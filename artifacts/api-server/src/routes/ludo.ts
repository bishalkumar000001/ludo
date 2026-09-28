import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import {
  CreateRoomBody,
  CreateRoomResponse,
  GetRoomResponse,
} from "@workspace/api-zod";

type PlayerColor = "red" | "blue" | "yellow" | "green";
type RoomStatus = "waiting" | "playing" | "finished";
type ActionType = "start" | "toggle_ready" | "roll" | "move" | "rematch";

export type LudoPlayer = {
  id: string;
  name: string;
  color: PlayerColor;
  ready: boolean;
  connected: boolean;
};

export type LudoToken = {
  id: string;
  playerId: string;
  index: number;
  position: number;
};

export type LudoMessage = {
  id: string;
  playerId: string;
  playerName: string;
  body: string;
  createdAt: string;
};

export type LudoRoom = {
  roomCode: string;
  status: RoomStatus;
  players: LudoPlayer[];
  currentPlayerId: string | null;
  dice: number | null;
  validMoves: number[];
  winnerId: string | null;
  tokens: LudoToken[];
  messages: LudoMessage[];
  createdAt: number;
  updatedAt: number;
};

const COLORS: PlayerColor[] = ["red", "blue", "yellow", "green"];
const START_OFFSETS: Record<PlayerColor, number> = {
  red: 0,
  blue: 13,
  yellow: 26,
  green: 39,
};
const SAFE_TRACK_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const rooms = new Map<string, LudoRoom>();
const streams = new Map<string, Set<Response>>();
const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();

function roomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? roomCode() : code;
}

function safeRoom(room: LudoRoom) {
  return {
    roomCode: room.roomCode,
    status: room.status,
    players: room.players,
    currentPlayerId: room.currentPlayerId,
    dice: room.dice,
    validMoves: room.validMoves,
    winnerId: room.winnerId,
    tokens: room.tokens,
    messages: room.messages,
  };
}

function findRoom(code: string) {
  return rooms.get(code.trim().toUpperCase());
}

function getPlayer(room: LudoRoom, playerId: string) {
  return room.players.find((player) => player.id === playerId);
}

function tokenFor(room: LudoRoom, playerId: string, index: number) {
  return room.tokens.find(
    (token) => token.playerId === playerId && token.index === index,
  );
}

function trackCell(player: LudoPlayer, position: number) {
  return (START_OFFSETS[player.color] + position) % 52;
}

function legalMoves(room: LudoRoom, playerId: string, dice: number) {
  return room.tokens
    .filter((token) => token.playerId === playerId)
    .filter((token) => {
      if (token.position === 56) return false;
      if (token.position === -1) return dice === 6;
      return token.position + dice <= 56;
    })
    .map((token) => token.index);
}

function nextPlayer(room: LudoRoom, playerId: string) {
  const index = room.players.findIndex((player) => player.id === playerId);
  if (index < 0 || room.players.length === 0) return null;
  return room.players[(index + 1) % room.players.length]?.id ?? null;
}

function scheduleTurn(room: LudoRoom) {
  const existing = turnTimers.get(room.roomCode);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    if (room.status !== "playing" || !room.currentPlayerId) return;
    room.dice = null;
    room.validMoves = [];
    room.currentPlayerId = nextPlayer(room, room.currentPlayerId);
    room.updatedAt = Date.now();
    broadcast(room);
  }, 30_000);
  turnTimers.set(room.roomCode, timer);
}

function createRoom(playerId: string, name: string, color?: PlayerColor) {
  const chosenColor = color && COLORS.includes(color) ? color : COLORS[0];
  const player: LudoPlayer = {
    id: playerId,
    name: name.trim().slice(0, 24) || "Player 1",
    color: chosenColor,
    ready: false,
    connected: true,
  };
  const room: LudoRoom = {
    roomCode: roomCode(),
    status: "waiting",
    players: [player],
    currentPlayerId: null,
    dice: null,
    validMoves: [],
    winnerId: null,
    tokens: Array.from({ length: 4 }, (_, index) => ({
      id: randomUUID(),
      playerId,
      index,
      position: -1,
    })),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(room.roomCode, room);
  return room;
}

function joinRoom(
  room: LudoRoom,
  playerId: string,
  name: string,
  requestedColor?: PlayerColor,
) {
  const existing = getPlayer(room, playerId);
  if (existing) {
    existing.connected = true;
    existing.name = name.trim().slice(0, 24) || existing.name;
    return;
  }
  if (room.status !== "waiting") throw new Error("GAME_ALREADY_STARTED");
  if (room.players.length >= 4) throw new Error("ROOM_FULL");
  const color =
    requestedColor &&
    COLORS.includes(requestedColor) &&
    !room.players.some((player) => player.color === requestedColor)
      ? requestedColor
      : COLORS.find((candidate) => !room.players.some((p) => p.color === candidate)) ??
        COLORS[room.players.length];
  room.players.push({
    id: playerId,
    name: name.trim().slice(0, 24) || `Player ${room.players.length + 1}`,
    color,
    ready: false,
    connected: true,
  });
  room.tokens.push(
    ...Array.from({ length: 4 }, (_, index) => ({
      id: randomUUID(),
      playerId,
      index,
      position: -1,
    })),
  );
}

function startGame(room: LudoRoom, playerId: string) {
  if (room.players[0]?.id !== playerId) throw new Error("ONLY_HOST_CAN_START");
  if (room.players.length < 2) throw new Error("NEED_TWO_PLAYERS");
  room.status = "playing";
  room.currentPlayerId = room.players[0].id;
  room.dice = null;
  room.validMoves = [];
  room.winnerId = null;
  scheduleTurn(room);
}

function toggleReady(room: LudoRoom, playerId: string) {
  const player = getPlayer(room, playerId);
  if (!player || room.status !== "waiting") throw new Error("GAME_NOT_WAITING");
  player.ready = !player.ready;
}

function roll(room: LudoRoom, playerId: string) {
  if (room.status !== "playing") throw new Error("GAME_NOT_PLAYING");
  if (room.currentPlayerId !== playerId) throw new Error("NOT_YOUR_TURN");
  if (room.dice !== null) throw new Error("MOVE_REQUIRED");
  room.dice = Math.floor(Math.random() * 6) + 1;
  room.validMoves = legalMoves(room, playerId, room.dice);
  if (room.validMoves.length === 0) {
    const rolled = room.dice;
    room.dice = null;
    room.validMoves = [];
    if (rolled !== 6) room.currentPlayerId = nextPlayer(room, playerId);
    scheduleTurn(room);
  }
}

function move(room: LudoRoom, playerId: string, tokenIndex: number) {
  if (room.status !== "playing") throw new Error("GAME_NOT_PLAYING");
  if (room.currentPlayerId !== playerId) throw new Error("NOT_YOUR_TURN");
  if (room.dice === null) throw new Error("ROLL_FIRST");
  if (!room.validMoves.includes(tokenIndex)) throw new Error("ILLEGAL_MOVE");
  const player = getPlayer(room, playerId);
  const token = tokenFor(room, playerId, tokenIndex);
  if (!player || !token) throw new Error("TOKEN_NOT_FOUND");
  const rolled = room.dice;
  const movedFromHome = token.position === -1;
  token.position = movedFromHome ? 0 : token.position + rolled;

  let captured = false;
  if (token.position >= 0 && token.position <= 51) {
    const landingCell = trackCell(player, token.position);
    if (!SAFE_TRACK_CELLS.has(landingCell)) {
      for (const opponent of room.tokens) {
        if (opponent.playerId === playerId || opponent.position < 0 || opponent.position > 51) continue;
        const opponentPlayer = getPlayer(room, opponent.playerId);
        if (opponentPlayer && trackCell(opponentPlayer, opponent.position) === landingCell) {
          opponent.position = -1;
          captured = true;
        }
      }
    }
  }

  const hasWon = room.tokens
    .filter((candidate) => candidate.playerId === playerId)
    .every((candidate) => candidate.position === 56);
  if (hasWon) {
    room.status = "finished";
    room.winnerId = playerId;
    room.currentPlayerId = null;
  } else {
    room.currentPlayerId =
      rolled === 6 || captured || token.position === 56
        ? playerId
        : nextPlayer(room, playerId);
  }
  room.dice = null;
  room.validMoves = [];
  scheduleTurn(room);
}

function broadcast(room: LudoRoom) {
  room.updatedAt = Date.now();
  const payload = `data: ${JSON.stringify({ type: "state", room: safeRoom(room) })}\n\n`;
  for (const response of streams.get(room.roomCode) ?? []) response.write(payload);
}

function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "SERVER_ERROR";
  const messages: Record<string, string> = {
    ROOM_FULL: "This room already has four players.",
    GAME_ALREADY_STARTED: "This game has already started.",
    NEED_TWO_PLAYERS: "Invite at least one more player before starting.",
    ONLY_HOST_CAN_START: "Only the room host can start the game.",
    NOT_YOUR_TURN: "It is not your turn yet.",
    MOVE_REQUIRED: "Choose a token to move first.",
    ROLL_FIRST: "Roll the dice before moving a token.",
    ILLEGAL_MOVE: "That token cannot move with this roll.",
    GAME_NOT_PLAYING: "The game is not currently playing.",
  };
  return { code, message: messages[code] ?? "Something went wrong." };
}

const router: IRouter = Router();

router.post("/rooms", (req, res) => {
  const parsed = CreateRoomBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid room request." });
  const room = createRoom(
    parsed.data.playerId ?? randomUUID(),
    parsed.data.name ?? "Player 1",
    parsed.data.color as PlayerColor | undefined,
  );
  return res.status(201).json(CreateRoomResponse.parse({ room: safeRoom(room) }));
});

router.get("/rooms/:roomCode", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  const room = findRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: "Room not found." });
  return res.json(GetRoomResponse.parse({ room: safeRoom(room) }));
});

router.post("/rooms/:roomCode/join", (req, res) => {
  const room = findRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: "Room not found." });
  try {
    joinRoom(room, String(req.body?.playerId || randomUUID()), String(req.body?.name || "Player"), req.body?.color);
    broadcast(room);
    return res.json({ room: safeRoom(room) });
  } catch (error) {
    const result = errorMessage(error);
    return res.status(result.code === "ROOM_FULL" ? 409 : 400).json(result);
  }
});

router.post("/rooms/:roomCode/action", (req, res) => {
  const room = findRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: "Room not found." });
  try {
    const playerId = String(req.body?.playerId || "");
    const action = String(req.body?.action || "") as ActionType;
    if (action === "start") startGame(room, playerId);
    else if (action === "toggle_ready") toggleReady(room, playerId);
    else if (action === "roll") roll(room, playerId);
    else if (action === "move") move(room, playerId, Number(req.body?.tokenIndex));
    else if (action === "rematch") {
      if (room.players[0]?.id !== playerId) throw new Error("ONLY_HOST_CAN_START");
      room.status = "waiting";
      room.currentPlayerId = null;
      room.dice = null;
      room.validMoves = [];
      room.winnerId = null;
      room.tokens = room.tokens.map((token) => ({ ...token, position: -1 }));
    } else throw new Error("UNKNOWN_ACTION");
    broadcast(room);
    return res.json({ room: safeRoom(room) });
  } catch (error) {
    return res.status(400).json(errorMessage(error));
  }
});

router.post("/rooms/:roomCode/messages", (req, res) => {
  const room = findRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: "Room not found." });
  const player = getPlayer(room, String(req.body?.playerId || ""));
  const body = String(req.body?.body || "").trim().slice(0, 240);
  if (!player || !body) return res.status(400).json({ error: "A player and message are required." });
  const message: LudoMessage = {
    id: randomUUID(),
    playerId: player.id,
    playerName: player.name,
    body,
    createdAt: new Date().toISOString(),
  };
  room.messages = [...room.messages.slice(-49), message];
  broadcast(room);
  return res.status(201).json({ message, room: safeRoom(room) });
});

router.get("/rooms/:roomCode/stream", (req, res) => {
  const room = findRoom(req.params.roomCode);
  if (!room) return res.status(404).json({ error: "Room not found." });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  if (!streams.has(room.roomCode)) streams.set(room.roomCode, new Set());
  streams.get(room.roomCode)?.add(res);
  res.write(`data: ${JSON.stringify({ type: "state", room: safeRoom(room) })}\n\n`);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    streams.get(room.roomCode)?.delete(res);
    if (streams.get(room.roomCode)?.size === 0) streams.delete(room.roomCode);
  });
  return undefined;
});

export default router;