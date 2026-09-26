const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { customAlphabet } = require('nanoid');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'velocity_ludo';
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN) console.warn('WARNING: BOT_TOKEN is missing');
if (!MONGODB_URI) console.warn('WARNING: MONGODB_URI is missing');
if (!WEBAPP_URL) console.warn('WARNING: WEBAPP_URL is missing');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

let mongoClient;
let db;
let roomsCollection;
const sockets = new Map(); // roomCode -> Set<WebSocket>
const timers = new Map();

async function connectMongo() {
  if (!MONGODB_URI) return;
  mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  roomsCollection = db.collection('rooms');
  await roomsCollection.createIndex({ roomCode: 1 }, { unique: true });
  await roomsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await roomsCollection.createIndex({ 'players.telegramId': 1 });
  console.log(`MongoDB connected: ${DB_NAME}`);
}

function now() { return new Date(); }
function roomView(room) {
  return {
    roomCode: room.roomCode,
    mode: room.mode,
    groupId: room.groupId || null,
    status: room.status,
    hostId: room.hostId,
    players: room.players || [],
    current: room.current || 0,
    dice: room.dice ?? null,
    winner: room.winner ?? null,
    board: room.board || null
  };
}

async function createRoom({ mode = 'private', groupId = null, host = null }) {
  if (!roomsCollection) throw new Error('MongoDB is not connected. Add MONGODB_URI.');
  for (let i = 0; i < 10; i++) {
    const roomCode = makeCode();
    const room = {
      roomCode,
      mode,
      groupId,
      status: 'waiting',
      hostId: host?.telegramId || null,
      players: host ? [host] : [],
      current: 0,
      dice: null,
      winner: null,
      board: null,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    };
    try {
      await roomsCollection.insertOne(room);
      return room;
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw new Error('Could not generate a unique room code');
}

async function getRoom(code) {
  if (!roomsCollection) return null;
  return roomsCollection.findOne({ roomCode: String(code || '').toUpperCase() });
}

async function touchRoom(code, patch = {}) {
  if (!roomsCollection) return null;
  const update = {
    ...patch,
    updatedAt: now(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  };
  const result = await roomsCollection.findOneAndUpdate(
    { roomCode: code.toUpperCase() },
    { $set: update },
    { returnDocument: 'after' }
  );
  return result;
}

async function addPlayer(code, player) {
  const room = await getRoom(code);
  if (!room) return null;
  const existing = (room.players || []).find(p => String(p.telegramId) === String(player.telegramId));
  if (existing) return room;
  if ((room.players || []).length >= 4) throw new Error('ROOM_FULL');
  const updated = await roomsCollection.findOneAndUpdate(
    { roomCode: code.toUpperCase(), 'players.telegramId': { $ne: player.telegramId }, $expr: { $lt: [{ $size: '$players' }, 4] } },
    { $push: { players: player }, $set: { updatedAt: now(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
    { returnDocument: 'after' }
  );
  if (updated) return updated;
  return getRoom(code);
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}
function broadcast(code, payload) {
  const set = sockets.get(code);
  if (!set) return;
  for (const ws of set) send(ws, payload);
}
async function broadcastRoom(code) {
  const room = await getRoom(code);
  if (room) broadcast(code, { type: 'state', room: roomView(room) });
}
function registerSocket(code, ws) {
  if (!sockets.has(code)) sockets.set(code, new Set());
  sockets.get(code).add(ws);
  ws.roomCode = code;
}
function unregisterSocket(ws) {
  const code = ws.roomCode;
  if (!code || !sockets.has(code)) return;
  sockets.get(code).delete(ws);
  if (!sockets.get(code).size) sockets.delete(code);
}

function scheduleTurn(code) {
  clearTimeout(timers.get(code));
  timers.set(code, setTimeout(async () => {
    const room = await getRoom(code);
    if (!room || room.status !== 'playing') return;
    const next = ((room.current || 0) + 1) % Math.max(room.players.length, 1);
    await touchRoom(code, { current: next, dice: null });
    await broadcastRoom(code);
  }, 30000));
}

wss.on('connection', ws => {
  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const code = String(msg.roomCode || '').toUpperCase();
      if (!code) return send(ws, { type: 'error', message: 'Room code missing' });

      if (msg.type === 'join') {
        const room = await getRoom(code);
        if (!room) return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found or expired' });
        registerSocket(code, ws);
        let player = msg.player || {};
        if (player.telegramId) {
          try {
            const updated = await addPlayer(code, {
              telegramId: String(player.telegramId),
              username: player.username || '',
              firstName: player.firstName || 'Player',
              photoUrl: player.photoUrl || ''
            });
            if (!updated) return send(ws, { type: 'error', message: 'Could not join room' });
          } catch (e) {
            if (e.message === 'ROOM_FULL') return send(ws, { type: 'error', code: 'ROOM_FULL', message: 'Room is full' });
            throw e;
          }
        }
        const current = await getRoom(code);
        send(ws, { type: 'joined', room: roomView(current) });
        await broadcastRoom(code);
        return;
      }

      const room = await getRoom(code);
      if (!room) return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found or expired' });

      if (msg.type === 'start') {
        if ((room.players || []).length < 2) return send(ws, { type: 'error', message: 'Need at least 2 players to start' });
        await touchRoom(code, { status: 'playing', current: 0, dice: null, winner: null });
        scheduleTurn(code);
        await broadcastRoom(code);
      } else if (msg.type === 'roll') {
        if (room.status !== 'playing') return;
        const playerId = String(msg.telegramId || '');
        const currentPlayer = room.players?.[room.current];
        if (!currentPlayer || String(currentPlayer.telegramId) !== playerId) return send(ws, { type: 'error', message: 'Not your turn' });
        const dice = Math.floor(Math.random() * 6) + 1;
        await touchRoom(code, { dice });
        await broadcastRoom(code);
      } else if (msg.type === 'move') {
        // Board/token movement is intentionally client-animation driven for now;
        // the server records the move and advances the turn.
        if (room.status !== 'playing') return;
        const playerId = String(msg.telegramId || '');
        const currentPlayer = room.players?.[room.current];
        if (!currentPlayer || String(currentPlayer.telegramId) !== playerId) return send(ws, { type: 'error', message: 'Not your turn' });
        const next = ((room.current || 0) + 1) % room.players.length;
        await touchRoom(code, { current: next, dice: null });
        scheduleTurn(code);
        await broadcastRoom(code);
      } else if (msg.type === 'rematch') {
        await touchRoom(code, { status: 'waiting', current: 0, dice: null, winner: null });
        clearTimeout(timers.get(code));
        await broadcastRoom(code);
      }
    } catch (err) {
      console.error('WS error:', err);
      send(ws, { type: 'error', message: 'Server error' });
    }
  });
  ws.on('close', () => unregisterSocket(ws));
});

app.get('/health', async (req, res) => {
  let mongo = false;
  try { mongo = !!roomsCollection && (await db.command({ ping: 1 })).ok === 1; } catch {}
  res.json({ ok: true, mongo, uptime: process.uptime() });
});

app.get('/api/rooms/:code', async (req, res) => {
  try {
    const room = await getRoom(req.params.code);
    if (!room) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
    res.json({ ok: true, room: roomView(room) });
  } catch (e) { res.status(500).json({ ok: false, error: 'SERVER_ERROR' }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const room = await createRoom({ mode: req.body?.mode || 'private', groupId: req.body?.groupId || null, host: req.body?.host || null });
    res.json({ ok: true, room: roomView(room) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

let bot;
let botUsername = process.env.BOT_USERNAME || '';

function appUrl(code) {
  return `${WEBAPP_URL}/?room=${encodeURIComponent(code)}`;
}

function miniAppDeepLink(code) {
  if (botUsername) return `https://t.me/${botUsername}?startapp=${encodeURIComponent(code)}`;
  return appUrl(code);
}

function launchButton(code, text = 'OPEN LUDO', isPrivate = false) {
  const url = appUrl(code);
  // Telegram only permits inline web_app buttons in private chats.
  // In groups, use a Mini App deep-link URL instead.
  return isPrivate
    ? { text, web_app: { url } }
    : { text, url: miniAppDeepLink(code) };
}

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.getMe().then(me => { botUsername = botUsername || me.username || ''; }).catch(() => {});

  bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const payload = (match?.[1] || '').trim().toUpperCase();
    try {
      if (payload) {
        const room = await getRoom(payload);
        if (!room) return bot.sendMessage(chatId, 'That Ludo room was not found or has expired.');
        return bot.sendMessage(chatId, `Ludo room ${payload} is ready.`, {
          reply_markup: { inline_keyboard: [[launchButton(payload, 'JOIN LUDO', true)]] }
        });
      }
      const host = { telegramId: String(msg.from.id), username: msg.from.username || '', firstName: msg.from.first_name || 'Player', photoUrl: '' };
      const room = await createRoom({ mode: 'private', host });
      await bot.sendMessage(chatId, `🎲 VELOCITY LUDO\n\nRoom: ${room.roomCode}\nPlayers: 1/4\n\nCreate a room or invite other players.`, {
        reply_markup: { inline_keyboard: [[launchButton(room.roomCode, 'PLAY LUDO', true)], [{ text: 'CREATE NEW ROOM', callback_data: 'ludo_new' }]] }
      });
    } catch (e) {
      console.error('/start:', e);
      bot.sendMessage(chatId, 'Ludo is temporarily unavailable. Please try again.');
    }
  });

  bot.onText(/^\/ludo$/, async msg => {
    try {
      const host = { telegramId: String(msg.from.id), username: msg.from.username || '', firstName: msg.from.first_name || 'Player', photoUrl: '' };
      const room = await createRoom({ mode: msg.chat.type === 'private' ? 'private' : 'group', groupId: msg.chat.type === 'private' ? null : String(msg.chat.id), host });
      await bot.sendMessage(msg.chat.id, `🎲 VELOCITY LUDO\n\nRoom: ${room.roomCode}\nPlayers: 1/4`, {
        reply_markup: { inline_keyboard: [[launchButton(room.roomCode, 'OPEN LUDO', msg.chat.type === 'private')]] }
      });
    } catch (e) {
      console.error('/ludo:', e);
      bot.sendMessage(msg.chat.id, 'Could not create the Ludo room.');
    }
  });

  bot.on('callback_query', async q => {
    if (q.data !== 'ludo_new') return;
    try {
      const host = { telegramId: String(q.from.id), username: q.from.username || '', firstName: q.from.first_name || 'Player', photoUrl: '' };
      const room = await createRoom({ mode: 'private', host });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(q.message.chat.id, `New Ludo room: ${room.roomCode}`, { reply_markup: { inline_keyboard: [[launchButton(room.roomCode, 'OPEN LUDO', msg.chat.type === 'private')]] } });
    } catch (e) {
      await bot.answerCallbackQuery(q.id, { text: 'Could not create room' });
    }
  });

  bot.on('polling_error', err => console.error('Telegram polling error:', err.message));
  console.log('Telegram bot polling enabled');
}

connectMongo()
  .then(() => server.listen(PORT, () => console.log(`Velocity Ludo listening on ${PORT}`)))
  .catch(err => {
    console.error('MongoDB startup error:', err);
    process.exit(1);
  });
