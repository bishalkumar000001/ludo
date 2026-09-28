import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGetRoomQueryKey,
  getHealthCheckQueryKey,
  useCreateRoom,
  useGetRoom,
  useHealthCheck,
  type Player,
  type Room,
  type Token,
} from "@workspace/api-client-react";
import {
  ArrowRight,
  Check,
  Copy,
  Dice5,
  Link2,
  MessageCircle,
  Radio,
  RotateCcw,
  Send,
  Sparkles,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Route, Switch, Router as WouterRouter, useLocation } from "wouter";

const queryClient = new QueryClient();
const colors = ["red", "blue", "yellow", "green"] as const;
type PlayerColor = (typeof colors)[number];
type ConnectionState = "joining" | "live" | "offline";
type Profile = { id: string; name: string; color: PlayerColor };

function guestProfile(): Profile {
  if (typeof window === "undefined") return { id: "guest-local", name: "Guest", color: "red" };
  const saved = window.localStorage.getItem("velocity-ludo-guest");
  if (saved) {
    try {
      return JSON.parse(saved) as Profile;
    } catch {
      window.localStorage.removeItem("velocity-ludo-guest");
    }
  }
  const profile = {
    id: `guest-${Math.random().toString(36).slice(2, 9)}`,
    name: `Guest ${Math.floor(100 + Math.random() * 899)}`,
    color: "red" as PlayerColor,
  };
  window.localStorage.setItem("velocity-ludo-guest", JSON.stringify(profile));
  return profile;
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  const Icon = state === "live" ? Wifi : state === "offline" ? WifiOff : Radio;
  return (
    <div className={`connection ${state}`} data-testid="status-connection">
      <span className="connection-dot" />
      <Icon size={12} />
      {state === "live" ? "Live" : state === "joining" ? "Joining" : "Reconnecting"}
    </div>
  );
}

function Header({ roomCode, socketState, onCopy }: { roomCode: string; socketState: ConnectionState; onCopy: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><Dice5 size={20} strokeWidth={2.7} /></div>
        <div><div className="brand-name">Velocity Ludo</div><div className="brand-kicker">fast table / live match</div></div>
      </div>
      <div className="top-actions">
        <ConnectionPill state={socketState} />
        {roomCode && <div className="room-chip"><span>ROOM {roomCode}</span><button onClick={onCopy} aria-label="Copy room link"><Copy size={12} /></button></div>}
      </div>
    </header>
  );
}

function Lobby({ name, setName, color, setColor, onCreate, pending, error }: {
  name: string;
  setName: (value: string) => void;
  color: PlayerColor;
  setColor: (value: PlayerColor) => void;
  onCreate: () => void;
  pending: boolean;
  error?: string;
}) {
  return (
    <main className="page-wrap">
      <div className="lobby-grid">
        <section>
          <div className="eyebrow">A table for the quick-hearted</div>
          <h1 className="hero-title">Roll fast.<br /><em>Play close.</em></h1>
          <p className="hero-copy">A live Ludo table for people who would rather be in the same room. Share one link, pick a color, and make the next move count.</p>
          <div className="lobby-note"><span className="note-icon"><Link2 size={14} /></span><span><strong>One link is the whole invite.</strong><br />No accounts. No waiting room maze.</span></div>
          <div className="how-strip">
            <div className="how-item"><span className="how-number">01 / TABLE</span><p>Make a room in one tap.</p></div>
            <div className="how-item"><span className="how-number">02 / CREW</span><p>Send the code to friends.</p></div>
            <div className="how-item"><span className="how-number">03 / RACE</span><p>Roll, move, celebrate.</p></div>
          </div>
        </section>
        <section className="panel join-panel" aria-label="Create a room">
          <div className="eyebrow">Start a table</div>
          <h2 className="panel-title">Who is playing?</h2>
          <p className="panel-subtitle">Your guest name follows you around this table. You can change it before the first roll.</p>
          <div className="name-row">
            <div><label className="field-label" htmlFor="guest-name">Your name</label><input id="guest-name" className="text-input" value={name} maxLength={24} onChange={(event) => setName(event.target.value)} /></div>
            <div><span className="field-label">Color</span><div className="color-picker" role="radiogroup" aria-label="Choose a token color">
              {colors.map((option) => <button key={option} type="button" className={`color-option swatch-${option} ${color === option ? "active" : ""}`} aria-label={`Choose ${option}`} aria-pressed={color === option} onClick={() => setColor(option)} />)}
            </div></div>
          </div>
          <button className="button-primary full-button" disabled={pending || !name.trim()} onClick={onCreate}>{pending ? "Making your table…" : <>Create a room <ArrowRight size={16} /></>}</button>
          {error && <div className="error-banner">{error}</div>}
        </section>
      </div>
    </main>
  );
}

const trackCoords: Array<[number, number]> = [
  [5, 0], [5, 1], [5, 2], [5, 3], [5, 4], [5, 5], [4, 5], [3, 5], [2, 5], [1, 5], [0, 5], [0, 6], [0, 7],
  [0, 8], [1, 9], [2, 9], [3, 9], [4, 9], [5, 9], [5, 10], [5, 11], [5, 12], [5, 13], [5, 14], [6, 9], [7, 9],
  [8, 9], [9, 9], [9, 10], [9, 11], [9, 12], [9, 13], [9, 14], [10, 9], [11, 9], [12, 9], [13, 9], [14, 9],
  [14, 8], [14, 7], [14, 6], [14, 5], [13, 5], [12, 5], [11, 5], [10, 5], [9, 5], [9, 4], [9, 3], [9, 2], [9, 1],
  [9, 0], [8, 5], [7, 5], [6, 5],
];

function Board({ room, me, onRoll, onStart, onToken, onRematch, rolling }: {
  room: Room;
  me: Player | undefined;
  onRoll: () => void;
  onStart: () => void;
  onToken: (token: Token) => void;
  onRematch: () => void;
  rolling: boolean;
}) {
  const tokenAt = (row: number, col: number) => room.tokens.filter((token) => {
    if (token.position < 0 || token.position > 51) return false;
    const [tokenRow, tokenCol] = trackCoords[token.position % trackCoords.length] ?? [];
    return tokenRow === row && tokenCol === col;
  });
  const cell = (row: number, col: number) => {
    const isHome = (row < 6 && col < 6) || (row < 6 && col > 9) || (row > 9 && col < 6) || (row > 9 && col > 9);
    const homeColor = row < 6 && col < 6 ? "red" : row < 6 && col > 9 ? "blue" : row > 9 && col < 6 ? "green" : "yellow";
    const isCenter = row >= 6 && row <= 8 && col >= 6 && col <= 8;
    const tokens = tokenAt(row, col);
    const trackIndex = trackCoords.findIndex(([trackRow, trackCol]) => trackRow === row && trackCol === col);
    if (isHome) {
      const isAnchor = (row === 0 || row === 10) && (col === 0 || col === 10);
      if (!isAnchor) return <div key={`${row}-${col}`} className="home-grid-spacer" />;
      const player = room.players.find((candidate) => candidate.color === homeColor);
      const homeTokens = room.tokens.filter((token) => token.playerId === player?.id && token.position === -1);
      return (
        <div key={`${row}-${col}`} className={`cell home-zone ${homeColor}`} style={{ gridRow: `${row + 1} / span 6`, gridColumn: `${col + 1} / span 6` }}>
          <div className="home-zone-inner"><div className="home-pips">
            {[0, 1, 2, 3].map((pip) => {
              const token = homeTokens.find((candidate) => candidate.index === pip);
              const selectable = token && room.validMoves?.includes(token.index) && token.playerId === me?.id;
              return token ? <button key={token.id} className={`home-token ${homeColor} ${selectable ? "selectable" : ""}`} title={`Token ${token.index + 1}`} onClick={() => onToken(token)} /> : <span key={pip} className="home-pip" />;
            })}
          </div></div>
        </div>
      );
    }
    return (
      <div key={`${row}-${col}`} className={`cell ${isCenter ? "center" : trackIndex >= 0 ? room.validMoves?.length ? "safe" : "track" : "track"}`}>
        {isCenter ? (row === 7 && col === 7 ? <Sparkles size={20} color="#fff2d2" /> : null) :
          tokens.map((token) => <button key={token.id} className={`token ${room.players.find((player) => player.id === token.playerId)?.color ?? "red"} ${token.playerId === me?.id && room.validMoves?.includes(token.index) ? "selectable" : ""}`} title={`Token ${token.index + 1}`} onClick={() => onToken(token)} />)}
      </div>
    );
  };
  const currentPlayer = room.players.find((player) => player.id === room.currentPlayerId);
  const canRoll = room.status === "playing" && room.currentPlayerId === me?.id && room.dice === null && !rolling;
  return (
    <section className="panel board-card">
      <div className="board-head"><div><div className="turn-label">{room.status === "waiting" ? "Table is open" : room.status === "finished" ? "Match complete" : "Current turn"}</div><div className="turn-player">{currentPlayer && <span className={`player-dot swatch-${currentPlayer.color}`} />} {room.status === "waiting" ? "Waiting for the crew" : room.status === "finished" ? room.players.find((player) => player.id === room.winnerId)?.name ?? "Winner" : currentPlayer?.name ?? "—"}</div></div><div className="status-pill">{room.status}</div></div>
      <div className="board"><div className="board-grid">{Array.from({ length: 225 }, (_, index) => cell(Math.floor(index / 15), index % 15))}</div></div>
      {room.status === "waiting" ? <div className="dice-area"><button className="button-primary" disabled={room.players.length < 2 || room.players[0]?.id !== me?.id} onClick={onStart}>Start the match <ArrowRight size={15} /></button></div> :
        room.status === "playing" ? <div className="dice-area"><div className={`dice ${rolling ? "rolling" : ""}`}>{room.dice ?? "·"}</div><button className="button-primary" disabled={!canRoll} onClick={onRoll}>{canRoll ? "Roll dice" : room.currentPlayerId === me?.id ? "Choose a token" : "Their turn"}</button></div> :
          <div className="dice-area"><button className="button-ghost" onClick={onRematch}><RotateCcw size={15} /> Play another</button></div>}
      <p className="board-hint">{room.status === "waiting" ? "Everyone can watch the board before the first roll." : room.status === "playing" ? "Select a highlighted token after your roll." : "The fastest path is rarely the safest one."}</p>
    </section>
  );
}

function PlayersCard({ players, me, onReady }: { players: Player[]; me: Player | undefined; onReady: () => void }) {
  return <section className="panel side-card"><h2 className="side-card-title"><span><Users size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />Players</span><span style={{ color: "hsl(var(--muted-foreground))", fontFamily: "var(--app-font-mono)", fontSize: 10 }}>{players.length}/4</span></h2><div className="player-list">{players.map((player) => <div className="player-row" key={player.id}><div className={`avatar swatch-${player.color}`}>{player.name.slice(0, 1).toUpperCase()}</div><div className="player-info"><div className="player-name">{player.name}{player.id === me?.id ? " (you)" : ""}</div><div className="player-state">{player.connected ? "at the table" : "away"}</div></div>{player.ready ? <Check className="ready-check" size={16} /> : <span className="waiting-check">—</span>}</div>)}</div><button className={`button-${me?.ready ? "ghost" : "primary"} full-button`} style={{ minHeight: 38, marginTop: 14 }} onClick={onReady}>{me?.ready ? "Ready for the roll" : "Mark me ready"}</button></section>;
}

function ChatCard({ room, me, onSend }: { room: Room; me: Player | undefined; onSend: (body: string) => void }) {
  const [body, setBody] = useState("");
  return <section className="panel side-card chat-card"><h2 className="side-card-title"><span><MessageCircle size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />Table chat</span><span style={{ color: "hsl(var(--muted-foreground))", fontFamily: "var(--app-font-mono)", fontSize: 9 }}>LIVE</span></h2><div className="messages" aria-live="polite">{room.messages.length === 0 ? <div style={{ color: "hsl(var(--muted-foreground))", fontSize: 12, padding: "20px 0" }}>Say something before the first roll.</div> : room.messages.map((message) => <div className={`message ${message.playerId === me?.id ? "mine" : ""}`} key={message.id}><div className="message-meta"><span>{message.playerName}</span><span>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div><span className="message-bubble">{message.body}</span></div>)}</div><form className="chat-form" onSubmit={(event) => { event.preventDefault(); if (body.trim()) { onSend(body.trim()); setBody(""); } }}><input className="text-input" value={body} maxLength={240} placeholder="Send a message…" aria-label="Chat message" onChange={(event) => setBody(event.target.value)} /><button className="button-primary send-button" type="submit" aria-label="Send message"><Send size={15} /></button></form></section>;
}

async function postRoomAction(roomCode: string, playerId: string, action: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`/api/rooms/${roomCode}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId, action, ...extra }) });
  if (!response.ok) throw new Error("Action failed");
  return (await response.json()) as { room: Room };
}

function RoomView({ room, profile, setRoom }: { room: Room; profile: Profile; setRoom: (room: Room) => void }) {
  const [rolling, setRolling] = useState(false);
  const me = room.players.find((player) => player.id === profile.id);
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      if (action === "roll") setRolling(true);
      const result = await postRoomAction(room.roomCode, profile.id, action, extra);
      setRoom(result.room);
    } finally {
      if (action === "roll") window.setTimeout(() => setRolling(false), 520);
    }
  };
  const sendMessage = async (body: string) => {
    await fetch(`/api/rooms/${room.roomCode}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: profile.id, body }) });
  };
  return <main className="page-wrap"><div className="match-topline"><div><h1 className="match-title">The table is <em style={{ color: "hsl(var(--accent))", fontStyle: "normal" }}>{room.status === "playing" ? "hot." : "open."}</em></h1><p className="match-meta">Room {room.roomCode} · {room.players.length} player{room.players.length === 1 ? "" : "s"} · {room.status === "playing" ? "server-validated match" : "waiting for the green light"}</p></div><div className={`status-pill ${room.status === "playing" ? "playing" : ""}`}>{room.status === "waiting" ? "Pre-game" : room.status === "playing" ? "In motion" : "Winner decided"}</div></div><div className="room-layout"><Board room={room} me={me} onRoll={() => void act("roll")} onStart={() => void act("start")} onToken={(token) => void act("move", { tokenIndex: token.index })} onRematch={() => void act("rematch")} rolling={rolling} /><aside className="sidebar-stack"><PlayersCard players={room.players} me={me} onReady={() => void act("toggle_ready")} /><ChatCard room={room} me={me} onSend={(body) => void sendMessage(body)} /></aside></div></main>;
}

function Game() {
  const [location, setLocation] = useLocation();
  const [profile, setProfile] = useState<Profile>(() => guestProfile());
  const roomCode = useMemo(() => new URLSearchParams(location.includes("?") ? location.slice(location.indexOf("?") + 1) : "").get("room")?.toUpperCase() ?? "", [location]);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState<PlayerColor>(profile.color);
  const [localRoom, setLocalRoom] = useState<Room | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(roomCode ? "joining" : "offline");
  const [joinError, setJoinError] = useState("");
  const { mutate: createRoom, data: createdRoom, isPending: isCreating, isError: createError } = useCreateRoom();
  const roomQuery = useGetRoom(roomCode || "pending", { query: { enabled: Boolean(roomCode), queryKey: getGetRoomQueryKey(roomCode || "pending") } });
  const healthQuery = useHealthCheck({ query: { staleTime: 30_000, queryKey: getHealthCheckQueryKey() } });

  useEffect(() => { if (roomQuery.data?.room) setLocalRoom(roomQuery.data.room); }, [roomQuery.data]);
  useEffect(() => { if (createdRoom?.room.roomCode) setLocation(`/?room=${createdRoom.room.roomCode}`); }, [createdRoom, setLocation]);
  useEffect(() => {
    if (!roomCode) return;
    let cancelled = false;
    let timer: number | undefined;
    let retry = 0;

    const syncRoom = async (join = false) => {
      if (cancelled) return;
      if (!localRoom) setConnection("joining");
      try {
        if (join) {
          const joined = await fetch(`/api/rooms/${roomCode}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playerId: profile.id, name: profile.name, color: profile.color }),
          });
          if (!joined.ok) {
            const details = await joined.json().catch(() => ({}));
            throw new Error(details?.message || "Could not join this room");
          }
          const payload = (await joined.json()) as { room: Room };
          if (cancelled) return;
          setLocalRoom(payload.room);
        } else {
          const response = await fetch(`/api/rooms/${roomCode}`, { cache: "no-store" });
          if (!response.ok) throw new Error("Room is unavailable");
          const payload = (await response.json()) as { room: Room };
          if (cancelled) return;
          setLocalRoom(payload.room);
        }
        retry = 0;
        setConnection("live");
      } catch (error) {
        if (cancelled) return;
        retry += 1;
        setConnection("offline");
        if (retry >= 5) setJoinError(error instanceof Error ? error.message : "Connection to the table was lost.");
      }
    };

    void syncRoom(true);
    const poll = () => {
      if (cancelled) return;
      void syncRoom(false);
      timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [roomCode, profile.id, profile.name, profile.color]);
  const copyRoom = () => { void navigator.clipboard?.writeText(window.location.href); };
  const create = () => {
    const nextProfile = { ...profile, name: name.trim() || profile.name, color };
    setProfile(nextProfile);
    window.localStorage.setItem("velocity-ludo-guest", JSON.stringify(nextProfile));
    createRoom({ data: { playerId: nextProfile.id, name: nextProfile.name, color: nextProfile.color } });
  };
  const room = localRoom;
  return <div className="app-shell"><Header roomCode={roomCode || room?.roomCode || ""} socketState={connection} onCopy={copyRoom} />{!roomCode && !room ? <Lobby name={name} setName={setName} color={color} setColor={setColor} onCreate={create} pending={isCreating} error={createError ? "We could not make a table just now." : undefined} /> : roomQuery.isLoading && !room ? <main className="page-wrap"><section className="panel loading-card"><div className="skeleton" style={{ width: "35%" }} /><div className="skeleton large" /></section></main> : roomQuery.isError && !room ? <main className="page-wrap"><section className="panel loading-card"><h2 className="panel-title">That room is out of reach.</h2><p className="panel-subtitle">{joinError || "The table may have closed, or the room code might have a typo."}</p><button className="button-primary" onClick={() => setLocation("/")}>Back to the lobby <RotateCcw size={15} /></button></section></main> : room ? <RoomView room={room} profile={profile} setRoom={setLocalRoom} /> : <main className="page-wrap"><section className="panel loading-card"><div className="skeleton" /><div className="skeleton large" /></section></main>}<span style={{ position: "fixed", bottom: 8, left: 10, opacity: 0, pointerEvents: "none" }} data-testid="status-api-health">{healthQuery.data?.status ?? "checking"}</span></div>;
}

function NotFound() {
  return <main className="not-found"><div><div className="brand-mark" style={{ margin: "0 auto" }}><Dice5 size={20} /></div><h1>404</h1><p>This table does not exist. Check the room link and try again.</p><a className="button-primary" href="/" data-testid="link-back-home">Back to the lobby</a></div></main>;
}

function Router() {
  return <Switch><Route path="/" component={Game} /><Route path="/404" component={NotFound} /><Route component={NotFound} /></Switch>;
}

function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}><Router /></WouterRouter></QueryClientProvider>;
}

export default App;