const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const TelegramBot = require("node-telegram-bot-api");
const { customAlphabet } = require("nanoid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const makeRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "");
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const COLORS = ["red", "green", "yellow", "blue"];
const START = { red: 0, green: 13, yellow: 26, blue: 39 };

function roomView(room) {
  return {
    code: room.code,
    mode: room.mode,
    groupId: room.groupId || null,
    status: room.status,
    hostId: room.hostId,
    current: room.current,
    dice: room.dice,
    winner: room.winner,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: p.avatar || "",
      connected: !!p.ws && p.ws.readyState === WebSocket.OPEN,
      finished: p.tokens.filter(x => x >= 57).length
    }))
  };
}

function broadcast(room) {
  const payload = JSON.stringify({ type: "state", room: roomView(room) });
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  }
}

function makeRoom(mode = "private", groupId = null) {
  const code = makeRoomCode();
  const room = {
    code, mode, groupId,
    status: "waiting",
    players: new Map(),
    hostId: null,
    current: 0,
    dice: null,
    winner: null,
    lastRollAt: 0
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, id, name, avatar) {
  if (room.players.has(id)) return room.players.get(id);
  if (room.players.size >= 4) return null;
  const color = COLORS[room.players.size];
  const p = { id, name: name || "Player", avatar: avatar || "", color, tokens: [-1,-1,-1,-1], ws: null };
  room.players.set(id, p);
  if (!room.hostId) room.hostId = id;
  return p;
}

function currentPlayer(room) {
  const ids = [...room.players.keys()];
  return ids[room.current] ? room.players.get(ids[room.current]) : null;
}

function nextTurn(room) {
  const ids = [...room.players.keys()];
  if (!ids.length) return;
  let tries = 0;
  do {
    room.current = (room.current + 1) % ids.length;
    tries++;
    const p = room.players.get(ids[room.current]);
    if (p && !p.tokens.every(x => x >= 57)) break;
  } while (tries <= ids.length);
  room.dice = null;
}

function roll(room, playerId) {
  const p = currentPlayer(room);
  if (!p || p.id !== playerId || room.status !== "playing") return { ok:false, error:"Not your turn" };
  if (room.dice !== null) return { ok:false, error:"Move the rolled piece first" };
  const now = Date.now();
  if (now - room.lastRollAt < 700) return { ok:false, error:"Too fast" };
  room.lastRollAt = now;
  room.dice = Math.floor(Math.random() * 6) + 1;
  return { ok:true, value:room.dice };
}

// Track a token on a 0..56 race path; -1 home, 57 finished.
// A roll of 6 releases a home token to 0. A token cannot move beyond 56.
function move(room, playerId, tokenIndex) {
  const p = currentPlayer(room);
  if (!p || p.id !== playerId || room.status !== "playing") return {ok:false,error:"Not your turn"};
  if (room.dice === null) return {ok:false,error:"Roll first"};
  const i = Number(tokenIndex);
  if (!Number.isInteger(i) || i < 0 || i > 3) return {ok:false,error:"Bad token"};
  const old = p.tokens[i];
  const d = room.dice;

  if (old === 57) return {ok:false,error:"Token already home"};
  let next = old;
  if (old === -1) {
    if (d !== 6) return {ok:false,error:"Need a 6 to enter"};
    next = 0;
  } else {
    if (old + d > 56) return {ok:false,error:"That token cannot move"};
    next = old + d;
  }

  p.tokens[i] = next;
  let captured = false;

  // Simple shared-track capture. Own tokens are safe from each other.
  if (next >= 0 && next < 56) {
    for (const other of room.players.values()) {
      if (other.id === p.id) continue;
      for (let j = 0; j < other.tokens.length; j++) {
        if (other.tokens[j] === next) {
          other.tokens[j] = -1;
          captured = true;
        }
      }
    }
  }

  if (next === 56) p.tokens[i] = 57;
  const finished = p.tokens.every(x => x === 57);
  if (finished) {
    room.status = "finished";
    room.winner = p.id;
  } else if (d !== 6 && !captured) {
    nextTurn(room);
  } else {
    room.dice = null;
  }
  return {ok:true};
}

wss.on("connection", ws => {
  let room = null;
  let player = null;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase();
      room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({type:"error", error:"Room not found"}));
        return;
      }
      if (room.status === "finished") {
        ws.send(JSON.stringify({type:"error", error:"Room has finished"}));
        return;
      }
      player = addPlayer(room, String(msg.playerId), msg.name, msg.avatar);
      if (!player) {
        ws.send(JSON.stringify({type:"error", error:"Room is full"}));
        return;
      }
      player.ws = ws;
      if (room.players.size >= 2 && room.status === "waiting") room.status = "playing";
      ws.send(JSON.stringify({type:"joined", playerId:player.id, color:player.color}));
      broadcast(room);
      return;
    }

    if (!room || !player) return;

    if (msg.type === "start") {
      if (player.id !== room.hostId) return;
      if (room.players.size < 2) {
        ws.send(JSON.stringify({type:"error",error:"At least 2 players are required"}));
        return;
      }
      room.status = "playing";
      room.current = 0;
      room.dice = null;
      broadcast(room);
    }

    if (msg.type === "roll") {
      const result = roll(room, player.id);
      if (!result.ok) ws.send(JSON.stringify({type:"error",error:result.error}));
      broadcast(room);
    }

    if (msg.type === "move") {
      const result = move(room, player.id, msg.token);
      if (!result.ok) ws.send(JSON.stringify({type:"error",error:result.error}));
      broadcast(room);
    }

    if (msg.type === "rematch") {
      if (room.status !== "finished") return;
      for (const p of room.players.values()) p.tokens = [-1,-1,-1,-1];
      room.status = "playing";
      room.winner = null;
      room.current = 0;
      room.dice = null;
      broadcast(room);
    }
  });

  ws.on("close", () => {
    if (player) player.ws = null;
    if (room) broadcast(room);
  });
});

// REST room creation, useful for the Telegram bot.
app.post("/api/rooms", (req,res) => {
  const room = makeRoom(req.body?.mode || "private", req.body?.groupId || null);
  res.json({ code: room.code, url: `${APP_URL}/?room=${room.code}` });
});

app.get("/health", (req,res) => res.json({ok:true, rooms:rooms.size}));

// Telegram bot: /ludo creates a room; /ludo CODE opens/joins one.
// For a Mini App direct-link setup, configure the bot's Main Mini App in BotFather.
if (BOT_TOKEN) {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/^\/ludo(?:\s+([A-Za-z0-9]+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const requested = match && match[1] ? match[1].toUpperCase() : null;
      let room = requested ? rooms.get(requested) : null;
      if (!room) room = makeRoom(msg.chat.type === "group" || msg.chat.type === "supergroup" ? "group" : "private",
                                msg.chat.type === "group" || msg.chat.type === "supergroup" ? String(chatId) : null);

      const direct = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?startapp=${room.code}`
        : `${APP_URL}/?room=${room.code}`;

      const text = `🎲 LUDO\\n\\nRoom: ${room.code}\\nPlayers: 0/4\\n\\nOpen the game and share the room code with your friends.`;
      await bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [[{text:"🎮 PLAY LUDO", url:direct}]]
        }
      });
    } catch (e) {
      console.error("Telegram error:", e.message);
    }
  });

  bot.onText(/^\/ludostop$/, (msg) => {
    for (const [code, room] of rooms) {
      if (room.groupId === String(msg.chat.id)) rooms.delete(code);
    }
    bot.sendMessage(msg.chat.id, "Ludo rooms for this chat have been closed.");
  });

  bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const payload = match?.[1] ? String(match[1]).trim().toUpperCase() : null;

      if (!payload) {
        const room = makeRoom("private", null);
        const direct = BOT_USERNAME
          ? `https://t.me/${BOT_USERNAME}?startapp=${room.code}`
          : `${APP_URL}/?room=${room.code}`;

        await bot.sendMessage(chatId, `🎲 *VELOCITY LUDO*\n\nPlay multiplayer Ludo with your friends.\n\nRoom: *${room.code}*\nPlayers: 0/4`, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: "🎮 PLAY LUDO", url: direct }],
            [{ text: "➕ CREATE NEW ROOM", url: direct }]
          ]}
        });
        return;
      }

      const code = payload.replace(/^ROOM[_-]?/, "");
      const room = rooms.get(code);
      if (!room) {
        await bot.sendMessage(chatId, `❌ Room *${code}* was not found or has expired.\n\nUse /ludo to create a new room.`, { parse_mode: "Markdown" });
        return;
      }

      const direct = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?startapp=${room.code}`
        : `${APP_URL}/?room=${room.code}`;
      await bot.sendMessage(chatId, `🎲 *LUDO ROOM*\n\nRoom: *${room.code}*\nPlayers: ${room.players.size}/4`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🎮 JOIN LUDO", url: direct }]] }
      });
    } catch (e) {
      console.error("Start command error:", e.message);
    }
  });

  console.log("Telegram bot polling enabled");
} else {
  console.log("BOT_TOKEN not set; running web game only.");
}

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60;
  for (const [code, room] of rooms) {
    const connected = [...room.players.values()].some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!connected && room.status === "waiting") rooms.delete(code);
    if (room.status === "finished" && room.lastActivity && room.lastActivity < cutoff) rooms.delete(code);
  }
}, 60_000);

server.listen(PORT, () => console.log(`Velocity Ludo listening on ${PORT}`));
