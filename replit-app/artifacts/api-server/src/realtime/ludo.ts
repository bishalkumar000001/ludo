import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Player, Room } from "@workspace/api-zod";

const TRACK_LENGTH = 52;
const FINISH_PROGRESS = 57;
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLORS: Player["color"][] = ["red", "green", "yellow", "blue"];
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type PlayerRecord = Player & { joinedAt: number };
type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  role: "player" | "spectator";
  timestamp: number;
};

export type LudoRoom = {
  roomCode: string;
  status: Room["status"];
  players: PlayerRecord[];
  currentPlayer: number;
  dice: number | null;
  winner: number | null;
  tokens: number[][];
  mode: "classic" | "quick";
  createdAt: number;
  updatedAt: number;
  activity: ChatMessage[];
};

type Session = {
  ws: WebSocket;
  roomCode: string;
  userId: string;
  userName: string;
  isSpectator: boolean;
};

const rooms = new Map<string, LudoRoom>();
const sessions = new Set<Session>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function createLudoRoom(input: {
  player: { id: string; name: string; username?: string | null };
  mode?: "classic" | "quick";
}): Room {
  const roomCode = makeRoomCode();
  const player: PlayerRecord = {
    id: input.player.id,
    name: input.player.name.slice(0, 64),
    username: input.player.username ?? null,
    color: "red",
    isHost: true,
    isSpectator: false,
    joinedAt: Date.now(),
  };
  const room: LudoRoom = {
    roomCode,
    status: "waiting",
    players: [player],
    currentPlayer: 0,
    dice: null,
    winner: null,
    tokens: [],
    mode: input.mode ?? "classic",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activity: [],
  };
  rooms.set(roomCode, room);
  return roomView(room);
}

export function getLudoRoom(roomCode: string): LudoRoom | null {
  return rooms.get(roomCode.toUpperCase()) ?? null;
}

export function roomView(room: LudoRoom): Room {
  return {
    roomCode: room.roomCode,
    status: room.status,
    players: room.players.map(({ joinedAt: _joinedAt, ...player }) => player),
    spectators: liveSpectatorCount(room.roomCode),
    currentPlayer: room.currentPlayer,
    dice: room.dice,
    winner: room.winner,
    tokens: room.tokens,
  };
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return randomId(6).toUpperCase();
}

function randomId(length: number) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function freshTokens(playerCount: number) {
  return Array.from({ length: playerCount }, () => [-1, -1, -1, -1]);
}

function globalCell(playerIndex: number, progress: number) {
  if (progress < 0 || progress >= TRACK_LENGTH) return null;
  return (playerIndex * 13 + progress) % TRACK_LENGTH;
}

function validMoves(room: LudoRoom, playerIndex: number, dice: number) {
  const tokens = room.tokens[playerIndex] ?? [];
  return tokens
    .map((progress, tokenIndex) => {
      if (progress >= FINISH_PROGRESS) return null;
      if (progress === -1) return dice === 6 ? tokenIndex : null;
      return progress + dice <= FINISH_PROGRESS ? tokenIndex : null;
    })
    .filter((tokenIndex): tokenIndex is number => tokenIndex !== null);
}

function nextPlayer(current: number, count: number) {
  return count ? (current + 1) % count : 0;
}

function getSessions(roomCode: string) {
  return [...sessions].filter((session) => session.roomCode === roomCode);
}

function liveSpectatorCount(roomCode: string) {
  return getSessions(roomCode).filter((session) => session.isSpectator).length;
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(roomCode: string, payload: unknown) {
  getSessions(roomCode).forEach((session) => send(session.ws, payload));
}

function broadcastState(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.updatedAt = Date.now();
  broadcast(roomCode, { type: "state", room: roomView(room) });
}

function broadcastPresence(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;
  broadcast(roomCode, {
    type: "presence",
    spectators: liveSpectatorCount(roomCode),
    connected: getSessions(roomCode).length,
  });
  broadcastState(roomCode);
}

function addPlayer(room: LudoRoom, input: { id: string; name: string; username?: string | null }) {
  const existing = room.players.find((player) => player.id === input.id);
  if (existing) return existing;
  if (room.status !== "waiting" || room.players.length >= 4) return null;
  const player: PlayerRecord = {
    id: input.id,
    name: input.name.slice(0, 64),
    username: input.username ?? null,
    color: COLORS[room.players.length],
    isHost: false,
    isSpectator: false,
    joinedAt: Date.now(),
  };
  room.players.push(player);
  return player;
}

function normalizeUser(raw: Record<string, unknown>) {
  const id = String(raw.id ?? raw.telegramId ?? "").trim();
  const name = String(raw.name ?? raw.firstName ?? raw.first_name ?? "Guest").trim();
  const username = raw.username ? String(raw.username).replace(/^@/, "").trim() : null;
  return { id: id || `guest-${randomId(8)}`, name: name || "Guest", username };
}

function finishTurn(roomCode: string, room: LudoRoom, playerIndex: number, extraTurn: boolean) {
  if (room.tokens[playerIndex]?.every((progress) => progress === FINISH_PROGRESS)) {
    room.status = "finished";
    room.winner = playerIndex;
    room.dice = null;
    clearTurnTimer(roomCode);
    broadcastState(roomCode);
    return;
  }
  room.currentPlayer = extraTurn ? playerIndex : nextPlayer(playerIndex, room.players.length);
  room.dice = null;
  broadcastState(roomCode);
  scheduleTurn(roomCode);
}

function scheduleTurn(roomCode: string) {
  clearTurnTimer(roomCode);
  timers.set(
    roomCode,
    setTimeout(() => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== "playing") return;
      room.currentPlayer = nextPlayer(room.currentPlayer, room.players.length);
      room.dice = null;
      broadcast(roomCode, { type: "room_event", event: "turn_timeout" });
      broadcastState(roomCode);
      scheduleTurn(roomCode);
    }, 30_000),
  );
}

function clearTurnTimer(roomCode: string) {
  const timer = timers.get(roomCode);
  if (timer) clearTimeout(timer);
  timers.delete(roomCode);
}

function startGame(room: LudoRoom) {
  room.status = "playing";
  room.currentPlayer = 0;
  room.dice = null;
  room.winner = null;
  room.tokens = freshTokens(room.players.length);
}

function publishChat(roomCode: string, session: Session, text: string) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const clean = text.trim().slice(0, 240);
  if (!clean) return;
  const message: ChatMessage = {
    id: randomId(10),
    senderId: session.userId,
    senderName: session.userName,
    text: clean,
    role: session.isSpectator ? "spectator" : "player",
    timestamp: Date.now(),
  };
  room.activity = [...room.activity.slice(-49), message];
  broadcast(roomCode, { type: "chat", message });
}

function relayVoice(roomCode: string, session: Session, msg: Record<string, unknown>) {
  const targetId = typeof msg.to === "string" ? msg.to : null;
  const payload = {
    type: String(msg.type),
    from: session.userId,
    signal: msg.signal ?? null,
  };
  getSessions(roomCode)
    .filter((candidate) => candidate !== session && (!targetId || candidate.userId === targetId))
    .forEach((candidate) => send(candidate.ws, payload));
}

function handleMessage(session: Session, raw: RawData) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString()) as Record<string, unknown>;
  } catch {
    send(session.ws, { type: "error", message: "Invalid message" });
    return;
  }
  const room = rooms.get(session.roomCode);
  if (!room) {
    send(session.ws, { type: "error", code: "ROOM_NOT_FOUND", message: "Room not found" });
    return;
  }

  switch (msg.type) {
    case "start": {
      if (room.players[0]?.id !== session.userId) {
        send(session.ws, { type: "error", message: "Only the host can start the game" });
        return;
      }
      if (room.players.length < 2) {
        send(session.ws, { type: "error", message: "Invite at least one more player" });
        return;
      }
      if (room.status !== "waiting") return;
      startGame(room);
      broadcast(room.roomCode, { type: "room_event", event: "game_started" });
      broadcastState(room.roomCode);
      scheduleTurn(room.roomCode);
      return;
    }
    case "roll": {
      const playerIndex = room.players.findIndex((player) => player.id === session.userId);
      if (session.isSpectator || playerIndex !== room.currentPlayer) {
        send(session.ws, { type: "error", message: "It is not your turn" });
        return;
      }
      if (room.status !== "playing" || room.dice !== null) return;
      room.dice = Math.floor(Math.random() * 6) + 1;
      const moves = validMoves(room, playerIndex, room.dice);
      broadcast(room.roomCode, { type: "room_event", event: "dice_rolled", playerIndex, dice: room.dice });
      broadcastState(room.roomCode);
      if (!moves.length) {
        const rolled = room.dice;
        setTimeout(() => {
          const latest = rooms.get(room.roomCode);
          if (latest?.status === "playing" && latest.currentPlayer === playerIndex && latest.dice === rolled) {
            finishTurn(room.roomCode, latest, playerIndex, rolled === 6);
          }
        }, 900);
      } else {
        scheduleTurn(room.roomCode);
      }
      return;
    }
    case "move": {
      const playerIndex = room.players.findIndex((player) => player.id === session.userId);
      const tokenIndex = Number(msg.tokenIndex);
      const dice = room.dice;
      if (session.isSpectator || playerIndex !== room.currentPlayer) {
        send(session.ws, { type: "error", message: "It is not your turn" });
        return;
      }
      if (room.status !== "playing" || dice === null || !Number.isInteger(dice) || !Number.isInteger(tokenIndex)) {
        send(session.ws, { type: "error", message: "Roll the dice first" });
        return;
      }
      const valid = validMoves(room, playerIndex, dice);
      if (!valid.includes(tokenIndex)) {
        send(session.ws, { type: "error", message: "That token cannot move" });
        return;
      }
      const tokens = room.tokens.map((playerTokens) => [...playerTokens]);
      const currentProgress = tokens[playerIndex][tokenIndex];
      const nextProgress = currentProgress === -1 ? 0 : currentProgress + dice;
      tokens[playerIndex][tokenIndex] = nextProgress;
      let captured = false;
      if (nextProgress < TRACK_LENGTH) {
        const cell = globalCell(playerIndex, nextProgress);
        if (cell !== null && !SAFE_CELLS.has(cell)) {
          tokens.forEach((otherTokens, otherPlayer) => {
            if (otherPlayer === playerIndex) return;
            otherTokens.forEach((progress, otherToken) => {
              if (progress >= 0 && progress < TRACK_LENGTH && globalCell(otherPlayer, progress) === cell) {
                tokens[otherPlayer][otherToken] = -1;
                captured = true;
              }
            });
          });
        }
      }
      room.tokens = tokens;
      broadcast(room.roomCode, {
        type: "room_event",
        event: captured ? "capture" : "token_moved",
        playerIndex,
        tokenIndex,
        progress: nextProgress,
      });
      finishTurn(room.roomCode, room, playerIndex, dice === 6 || captured);
      return;
    }
    case "rematch": {
      if (room.players[0]?.id !== session.userId || room.status !== "finished") return;
      room.status = "waiting";
      room.currentPlayer = 0;
      room.dice = null;
      room.winner = null;
      room.tokens = [];
      clearTurnTimer(room.roomCode);
      broadcastState(room.roomCode);
      return;
    }
    case "chat":
      publishChat(room.roomCode, session, String(msg.text ?? ""));
      return;
    case "spectator": {
      session.isSpectator = Boolean(msg.value);
      broadcastPresence(room.roomCode);
      return;
    }
    case "voice_request":
    case "voice_offer":
    case "voice_answer":
    case "voice_ice":
      relayVoice(room.roomCode, session, msg);
      return;
    default:
      send(session.ws, { type: "error", message: "Unknown action" });
  }
}

export function attachLudoRealtime(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    let session: Session | null = null;

    ws.on("message", (raw) => {
      if (!session) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          send(ws, { type: "error", message: "Join payload is invalid" });
          return;
        }
        if (msg.type !== "join") {
          send(ws, { type: "error", message: "Join a room first" });
          return;
        }
        const roomCode = String(msg.roomCode ?? "").trim().toUpperCase();
        const room = rooms.get(roomCode);
        if (!room) {
          send(ws, { type: "error", code: "ROOM_NOT_FOUND", message: "Room not found or expired" });
          ws.close();
          return;
        }
        const user = normalizeUser((msg.user ?? msg.player ?? {}) as Record<string, unknown>);
        const requestedSpectator = Boolean(msg.spectator);
        const player = addPlayer(room, user);
        const alreadyPlayer = room.players.some((candidate) => candidate.id === user.id);
        session = {
          ws,
          roomCode,
          userId: user.id,
          userName: player?.name ?? user.name,
          isSpectator: requestedSpectator || !alreadyPlayer,
        };
        sessions.add(session);
        send(ws, { type: "joined", room: roomView(room), spectator: session.isSpectator });
        broadcastPresence(roomCode);
        return;
      }
      handleMessage(session, raw);
    });

    ws.on("close", () => {
      if (!session) return;
      sessions.delete(session);
      broadcastPresence(session.roomCode);
    });
  });
  return wss;
}
