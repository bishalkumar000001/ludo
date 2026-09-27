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

function normalizePlayer(raw = {}) {
  const telegramId = raw.telegramId != null ? String(raw.telegramId).trim() : '';
  const username = String(raw.username || '').trim().replace(/^@/, '').slice(0, 64);
  const firstName = String(raw.firstName || raw.first_name || '').trim().slice(0, 64);
  const lastName = String(raw.lastName || raw.last_name || '').trim().slice(0, 64);
  const displayName = firstName || username || 'Player';
  return {
    telegramId,
    username,
    firstName: displayName,
    lastName,
    photoUrl: String(raw.photoUrl || raw.photo_url || '').trim().slice(0, 1000)
  };
}

function telegramPlayer(user) {
  return normalizePlayer({
    telegramId: user?.id,
    username: user?.username,
    firstName: user?.first_name,
    lastName: user?.last_name,
    photoUrl: user?.photo_url
  });
}
function roomView(room) {
  return {
    roomCode: room.roomCode,
    mode: room.mode,
    groupId: room.groupId || null,
    status: room.status,
    hostId: room.hostId,
    players: (room.players || []).map(normalizePlayer),
    current: room.current || 0,
    dice: room.dice ?? null,
    winner: room.winner ?? null,
    tokens: room.tokens || null
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
      tokens: null,
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

const TRACK_LEN = 52;
const FINISH = 57;
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

function freshTokens(playerCount) {
  return Array.from({ length: playerCount }, () => [-1, -1, -1, -1]);
}

function globalCell(playerIndex, progress) {
  if (progress < 0 || progress >= TRACK_LEN) return null;
  return (playerIndex * 13 + progress) % TRACK_LEN;
}

function validMoves(room, playerIndex, dice) {
  const tokens = room.tokens?.[playerIndex] || [];
  return tokens.map((progress, tokenIndex) => {
    if (progress >= FINISH) return null;
    if (progress === -1) return dice === 6 ? tokenIndex : null;
    return progress + dice <= FINISH ? tokenIndex : null;
  }).filter(v => v !== null);
}

function advanceTurn(current, playerCount) {
  return playerCount ? (current + 1) % playerCount : 0;
}

function scheduleTurn(code) {
  clearTimeout(timers.get(code));
  const timer = setTimeout(async () => {
    try {
      const room = await getRoom(code);
      if (!room || room.status !== 'playing') return;
      const next = advanceTurn(room.current || 0, room.players.length);
      await touchRoom(code, { current: next, dice: null });
      await broadcastRoom(code);
      scheduleTurn(code);
    } catch (e) {
      console.error('turn timer:', e);
    }
  }, 30000);
  timers.set(code, timer);
}

async function finishTurn(code, room, playerIndex, extraTurn = false) {
  if (room.tokens[playerIndex].every(v => v === FINISH)) {
    await touchRoom(code, { status: 'finished', winner: playerIndex, dice: null });
    clearTimeout(timers.get(code));
    await broadcastRoom(code);
    return;
  }
  const next = extraTurn ? playerIndex : advanceTurn(playerIndex, room.players.length);
  await touchRoom(code, { current: next, dice: null });
  await broadcastRoom(code);
  scheduleTurn(code);
}


wss.on('connection', ws => {
  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const code = String(msg.roomCode || '').trim().toUpperCase();
      if (!code) return send(ws, { type: 'error', message: 'Room code missing' });

      if (msg.type === 'join') {
        const room = await getRoom(code);
        if (!room) return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found or expired' });

        const player = msg.player || {};
        if (player.telegramId) {
          const existing = (room.players || []).find(p => String(p.telegramId) === String(player.telegramId));
          if (!existing && room.status !== 'waiting') {
            return send(ws, { type: 'error', code: 'GAME_STARTED', message: 'This game has already started.' });
          }
          try {
            const normalized = normalizePlayer(player);
            if (!normalized.telegramId) return send(ws, { type: 'error', code: 'IDENTITY_MISSING', message: 'Telegram user identity was not found. Reopen the Ludo game from Telegram.' });
            const updated = await addPlayer(code, normalized);
            if (!updated) return send(ws, { type: 'error', message: 'Could not join room' });
          } catch (e) {
            if (e.message === 'ROOM_FULL') return send(ws, { type: 'error', code: 'ROOM_FULL', message: 'Room is full' });
            throw e;
          }
        }

        registerSocket(code, ws);
        const current = await getRoom(code);
        send(ws, { type: 'joined', room: roomView(current) });
        await broadcastRoom(code);
        return;
      }

      const room = await getRoom(code);
      if (!room) return send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found or expired' });

      const playerId = String(msg.telegramId || '');
      const playerIndex = (room.players || []).findIndex(p => String(p.telegramId) === playerId);

      if (msg.type === 'start') {
        if (playerIndex !== 0 || String(room.hostId) !== playerId) {
          return send(ws, { type: 'error', message: 'Only the room host can start the game' });
        }
        if (room.status !== 'waiting') return;
        if ((room.players || []).length < 2) return send(ws, { type: 'error', message: 'Need at least 2 players to start' });
        await touchRoom(code, {
          status: 'playing',
          current: 0,
          dice: null,
          winner: null,
          tokens: freshTokens(room.players.length)
        });
        await broadcastRoom(code);
        scheduleTurn(code);
        return;
      }

      if (playerIndex < 0) return send(ws, { type: 'error', message: 'You are not in this room' });

      if (msg.type === 'roll') {
        if (room.status !== 'playing') return send(ws, { type: 'error', message: 'Game is not active' });
        if (playerIndex !== room.current) return send(ws, { type: 'error', message: 'Not your turn' });
        if (room.dice != null) return send(ws, { type: 'error', message: 'Move the rolled token first' });

        const dice = Math.floor(Math.random() * 6) + 1;
        const moves = validMoves(room, playerIndex, dice);
        await touchRoom(code, { dice });
        await broadcastRoom(code);

        if (!moves.length) {
          setTimeout(async () => {
            try {
              const latest = await getRoom(code);
              if (!latest || latest.status !== 'playing' || latest.current !== playerIndex || latest.dice !== dice) return;
              await finishTurn(code, latest, playerIndex, dice === 6);
            } catch (e) { console.error('auto turn:', e); }
          }, 900);
        } else {
          scheduleTurn(code);
        }
        return;
      }

      if (msg.type === 'move') {
        if (room.status !== 'playing') return;
        if (playerIndex !== room.current) return send(ws, { type: 'error', message: 'Not your turn' });
        const dice = Number(room.dice);
        const tokenIndex = Number(msg.tokenIndex);
        if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 3) {
          return send(ws, { type: 'error', message: 'Invalid token' });
        }
        if (!Number.isInteger(dice) || dice < 1 || dice > 6) {
          return send(ws, { type: 'error', message: 'Roll the dice first' });
        }

        const moves = validMoves(room, playerIndex, dice);
        if (!moves.includes(tokenIndex)) return send(ws, { type: 'error', message: 'That token cannot move' });

        const tokens = (room.tokens || []).map(a => [...a]);
        let nextProgress = tokens[playerIndex][tokenIndex];
        nextProgress = nextProgress === -1 ? 0 : nextProgress + dice;
        tokens[playerIndex][tokenIndex] = nextProgress;

        let captured = false;
        if (nextProgress < TRACK_LEN) {
          const cell = globalCell(playerIndex, nextProgress);
          if (!SAFE_CELLS.has(cell)) {
            for (let i = 0; i < tokens.length; i++) {
              if (i === playerIndex) continue;
              for (let j = 0; j < 4; j++) {
                if (tokens[i][j] >= 0 && tokens[i][j] < TRACK_LEN && globalCell(i, tokens[i][j]) === cell) {
                  tokens[i][j] = -1;
                  captured = true;
                }
              }
            }
          }
        }

        await touchRoom(code, { tokens });
        const latest = await getRoom(code);
        await finishTurn(code, latest, playerIndex, dice === 6 || captured);
        return;
      }

      if (msg.type === 'rematch') {
        if (playerIndex !== 0 || String(room.hostId) !== playerId) {
          return send(ws, { type: 'error', message: 'Only the room host can start the rematch' });
        }
        if (room.status !== 'finished') return;
        await touchRoom(code, {
          status: 'waiting',
          current: 0,
          dice: null,
          winner: null,
          tokens: null
        });
        clearTimeout(timers.get(code));
        await broadcastRoom(code);
        return;
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
      const host = telegramPlayer(msg.from);
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
      const host = telegramPlayer(msg.from);
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
      const host = telegramPlayer(q.from);
      const room = await createRoom({ mode: 'private', host });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(q.message.chat.id, `New Ludo room: ${room.roomCode}`, { reply_markup: { inline_keyboard: [[launchButton(room.roomCode, 'OPEN LUDO', q.message.chat.type === 'private')]] } });
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
