import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Check,
  Copy,
  Crown,
  Dices,
  Headphones,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelTop,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import {
  getGetRoomQueryKey,
  getHealthCheckQueryKey,
  useCreateRoom,
  useGetRoom,
  useHealthCheck,
} from '@workspace/api-client-react';
import type { Player, Room, RoomInputMode } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

const queryClient = new QueryClient();

type ConnectionState = 'connecting' | 'connected' | 'offline';
type ChatMessage = { id: string; name: string; body: string; time: string; own?: boolean; role?: string };
type RoomEvent = { type: string; [key: string]: unknown };

const colorClass: Record<string, string> = {
  red: 'text-[hsl(11_81%_61%)]',
  green: 'text-[hsl(161_48%_47%)]',
  yellow: 'text-[hsl(43_96%_57%)]',
  blue: 'text-[hsl(204_75%_61%)]',
};
const colorBg: Record<string, string> = {
  red: 'bg-[hsl(11_81%_61%)]',
  green: 'bg-[hsl(161_48%_47%)]',
  yellow: 'bg-[hsl(43_96%_57%)]',
  blue: 'bg-[hsl(204_75%_61%)]',
};

const guestFromTelegram = () => {
  const webApp = (window as Window & { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number; first_name?: string; username?: string } } } } }).Telegram?.WebApp;
  const user = webApp?.initDataUnsafe?.user;
  if (user?.id) return { id: String(user.id), name: user.first_name || 'Telegram player', username: user.username || null };
  const saved = window.localStorage.getItem('ludo-arena-guest');
  if (saved) return JSON.parse(saved) as { id: string; name: string; username: string | null };
  const guest = { id: `guest-${Math.random().toString(36).slice(2, 8)}`, name: 'Guest player', username: null };
  window.localStorage.setItem('ludo-arena-guest', JSON.stringify(guest));
  return guest;
};

const previewRoom = (code: string, guest: { id: string; name: string; username: string | null }): Room => ({
  roomCode: code,
  status: 'waiting',
  players: [{ id: guest.id, name: guest.name, username: guest.username, color: 'yellow', isHost: true, isSpectator: false }],
  spectators: 3,
  currentPlayer: 0,
  dice: null,
  winner: null,
  tokens: [[], [], [], []],
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={Arena} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function NotFound() {
  return <div className="min-h-[100dvh] grid place-items-center bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"><div className="text-center"><p className="eyebrow">404 / off board</p><h1 className="mt-3 text-3xl font-extrabold">That room does not exist.</h1></div></div>;
}

function Arena() {
  const guest = useMemo(guestFromTelegram, []);
  const initialRoomCode = useMemo(() => {
    const webApp = (window as Window & { Telegram?: { WebApp?: { ready?: () => void; expand?: () => void; initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp;
    webApp?.ready?.();
    webApp?.expand?.();
    const params = new URLSearchParams(window.location.search);
    return (params.get('room') || params.get('tgWebAppStartParam') || webApp?.initDataUnsafe?.start_param || '').trim().toUpperCase();
  }, []);
  const [roomCode, setRoomCode] = useState(initialRoomCode);
  const [localRoom, setLocalRoom] = useState<Room | null>(null);
  const [mode, setMode] = useState<RoomInputMode>('classic');
  const [joinCode, setJoinCode] = useState('');
  const [roomActionError, setRoomActionError] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('offline');
  const [isMicOn, setIsMicOn] = useState(true);
  const [isSoundOn, setIsSoundOn] = useState(true);
  const [voiceStatus, setVoiceStatus] = useState('Voice ready');
  const [isSpectator, setIsSpectator] = useState(false);
  const [chatText, setChatText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const closedByUserRef = useRef(false);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef(new Map<string, HTMLAudioElement>());

  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), retry: false } });
  const createRoom = useCreateRoom();
  const roomQuery = useGetRoom(roomCode, {
    query: { enabled: Boolean(roomCode), queryKey: getGetRoomQueryKey(roomCode), retry: false },
  });
  const serverRoom = roomQuery.data;
  const room = serverRoom ?? localRoom;

  useEffect(() => {
    if (roomQuery.isError && roomCode) {
      setLocalRoom((current) => current ?? previewRoom(roomCode, guest));
      setRoomActionError('Live API unavailable. Preview room is ready in this browser.');
    }
  }, [guest, roomCode, roomQuery.isError]);

  const send = useCallback((payload: RoomEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    if (!roomCode) return;
    closedByUserRef.current = false;
    setConnection('connecting');
    const envUrl = import.meta.env.VITE_LUDO_WS_URL as string | undefined;
    const fallbackUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
    let socket: WebSocket | undefined;
    let disposed = false;
    const connectSocket = () => {
      if (disposed || closedByUserRef.current) return;
      try {
        socket = new WebSocket(envUrl || fallbackUrl);
        wsRef.current = socket;
        socket.onopen = () => {
          setConnection('connected');
          send({ type: 'join', roomCode, user: guest });
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as RoomEvent;
            if (message.type === 'chat' && message.message && typeof message.message === 'object') {
              const incoming = message.message as { id?: string; senderName?: string; text?: string; timestamp?: number; role?: string };
              const text = incoming.text;
              if (text) {
                setMessages((items) => [...items.slice(-49), {
                  id: incoming.id || `remote-${Date.now()}`,
                  name: incoming.senderName || 'Player',
                  body: text,
                  time: incoming.timestamp ? new Date(incoming.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now',
                  role: incoming.role,
                  own: incoming.senderName === guest.name,
                }]);
              }
            }
            if (message.type === 'state' && message.room && typeof message.room === 'object') setLocalRoom(message.room as Room);
            if (message.type === 'joined' && message.room && typeof message.room === 'object') {
              setLocalRoom(message.room as Room);
              setIsSpectator(Boolean(message.spectator));
            }
            if (message.type === 'presence' && typeof message.spectators === 'number') {
              setLocalRoom((current) => current ? { ...current, spectators: message.spectators as number } : current);
            }
            if (message.type === 'room_event' && message.event === 'turn_timeout') setRoomActionError('Turn timed out. The table moved to the next player.');
            if (message.type === 'voice_request' && typeof message.from === 'string') {
              setVoiceStatus('Voice request received');
              void connectVoicePeer(message.from as string, true);
            }
            if (message.type === 'voice_offer' && typeof message.from === 'string') {
              void acceptVoiceOffer(message.from as string, message.signal);
            }
            if (message.type === 'voice_answer' && typeof message.from === 'string') {
              void answerVoiceOffer(message.from as string, message.signal);
            }
            if (message.type === 'voice_ice' && typeof message.from === 'string') {
              const peer = peersRef.current.get(message.from as string);
              if (peer && message.signal) void peer.addIceCandidate(message.signal as RTCIceCandidateInit);
            }
            if (message.type === 'error' && typeof message.message === 'string') setRoomActionError(message.message);
          } catch {
            setConnection('offline');
          }
        };
        socket.onerror = () => setConnection('offline');
        socket.onclose = () => {
          if (disposed || closedByUserRef.current) return;
          setConnection('offline');
          reconnectRef.current = window.setTimeout(connectSocket, 1200);
        };
      } catch {
        setConnection('offline');
        reconnectRef.current = window.setTimeout(connectSocket, 1200);
      }
    };
    connectSocket();
    return () => {
      disposed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socket?.close();
      wsRef.current = null;
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      audioRef.current.forEach((audio) => audio.remove());
      audioRef.current.clear();
    };
  }, [guest, roomCode, send]);

  const getLocalStream = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    return stream;
  }, []);

  const connectVoicePeer = useCallback(async (peerId: string, createOffer: boolean) => {
    const existing = peersRef.current.get(peerId);
    const peer = existing ?? new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    if (!existing) {
      peersRef.current.set(peerId, peer);
      const stream = await getLocalStream();
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.onicecandidate = (event) => {
        if (event.candidate) send({ type: 'voice_ice', to: peerId, signal: event.candidate });
      };
      peer.ontrack = (event) => {
        const audio = audioRef.current.get(peerId) ?? document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = event.streams[0];
        audioRef.current.set(peerId, audio);
        void audio.play().catch(() => undefined);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') setVoiceStatus('Voice connected');
      };
    }
    if (createOffer && peer.signalingState === 'stable') {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      send({ type: 'voice_offer', to: peerId, signal: offer });
    }
    return peer;
  }, [getLocalStream, send]);

  const acceptVoiceOffer = useCallback(async (peerId: string, signal: unknown) => {
    if (!signal) return;
    const peer = await connectVoicePeer(peerId, false);
    await peer.setRemoteDescription(signal as RTCSessionDescriptionInit);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    send({ type: 'voice_answer', to: peerId, signal: answer });
  }, [connectVoicePeer, send]);

  const answerVoiceOffer = useCallback(async (peerId: string, signal: unknown) => {
    const peer = peersRef.current.get(peerId);
    if (peer && signal) await peer.setRemoteDescription(signal as RTCSessionDescriptionInit);
  }, []);

  const activeRoom = room;
  const create = () => {
    setRoomActionError('');
    createRoom.mutate(
      { data: { player: guest, mode } },
      {
        onSuccess: (created) => {
          setLocalRoom(null);
          setRoomCode(created.roomCode);
        },
        onError: () => {
          const code = `PREVIEW-${Math.floor(100 + Math.random() * 899)}`;
          setLocalRoom(previewRoom(code, guest));
          setRoomCode(code);
          setRoomActionError('The arena server is not reachable, so this room is running in local preview.');
        },
      },
    );
  };
  const join = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return setRoomActionError('Enter a room code first.');
    setRoomActionError('');
    setRoomCode(code);
  };
  const leave = () => {
    closedByUserRef.current = true;
    wsRef.current?.close();
    setRoomCode('');
    setLocalRoom(null);
    setMessages([]);
    setIsSpectator(false);
    setRoomActionError('');
  };

  if (roomCode && roomQuery.isPending && !localRoom) return <RoomLoading code={roomCode} />;
  if (!activeRoom) {
    return <Lobby guest={guest} mode={mode} setMode={setMode} joinCode={joinCode} setJoinCode={setJoinCode} onCreate={create} onJoin={join} error={roomActionError} isCreating={createRoom.isPending} health={health.isSuccess} />;
  }

  const onChat = (event: React.FormEvent) => {
    event.preventDefault();
    const body = chatText.trim();
    if (!body) return;
    setMessages((items) => [...items, { id: `own-${Date.now()}`, name: guest.name, body, time: 'now', own: true }]);
    send({ type: 'chat', roomCode, text: body });
    setChatText('');
  };
  const roll = () => {
    send({ type: 'roll', roomCode });
  };
  const toggleSpectator = () => {
    const next = !isSpectator;
    setIsSpectator(next);
    send({ type: 'spectator', roomCode, value: next });
  };

  return (
    <main className="arena-shell grain min-h-[100dvh] text-[hsl(var(--foreground))]">
      <div className="mx-auto max-w-[1500px] px-4 pb-8 pt-4 sm:px-7 lg:px-10">
        <ArenaHeader room={activeRoom} connection={connection} health={health.isSuccess} onLeave={leave} />
        {roomActionError && <Notice text={roomActionError} onClose={() => setRoomActionError('')} />}
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_345px]">
          <section className="min-w-0">
            <GameStage room={activeRoom} guestId={guest.id} isSpectator={isSpectator} dice={activeRoom.dice} onRoll={roll} onStart={() => send({ type: 'start', roomCode })} onMove={(tokenIndex) => send({ type: 'move', roomCode, tokenIndex })} onRematch={() => send({ type: 'rematch', roomCode })} />
            <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]">
              <PlayerRail room={activeRoom} guestId={guest.id} spectatorMode={isSpectator} onSpectator={toggleSpectator} />
              <div className="panel-soft flex items-center justify-between gap-3 rounded-2xl px-4 py-3">
                <div><p className="eyebrow">Match mode</p><p className="mt-1 text-sm font-bold capitalize">{mode} ruleset</p></div>
                <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]"><ShieldCheck className="h-4 w-4 text-[hsl(var(--primary))]" /> Fair play on</div>
              </div>
            </div>
          </section>
          <aside className="grid min-h-0 gap-4 lg:grid-rows-[auto_minmax(0,1fr)_auto]">
            <SpectatorPanel room={activeRoom} />
            <ChatPanel messages={messages} chatText={chatText} setChatText={setChatText} onChat={onChat} />
            <VoicePanel isMicOn={isMicOn} isSoundOn={isSoundOn} voiceStatus={voiceStatus} setIsMicOn={(next) => {
              setIsMicOn(next);
              localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
            }} setIsSoundOn={setIsSoundOn} onRequest={async () => {
              try {
                await getLocalStream();
                setVoiceStatus('Calling the table');
                send({ type: 'voice_request', roomCode });
                activeRoom.players.filter((player) => player.id !== guest.id).forEach((player) => void connectVoicePeer(player.id, true));
              } catch {
                setVoiceStatus('Microphone permission needed');
              }
            }} />
          </aside>
        </div>
        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 px-1 text-[11px] text-[hsl(var(--muted-foreground))]">
          <span className="mono">LUDO ARENA / ROOM {activeRoom.roomCode}</span>
          <span className="flex items-center gap-2"><LockKeyhole className="h-3.5 w-3.5" /> End-to-end room session</span>
        </footer>
      </div>
    </main>
  );
}

function Lobby({ guest, mode, setMode, joinCode, setJoinCode, onCreate, onJoin, error, isCreating, health }: { guest: { name: string; username: string | null }; mode: RoomInputMode; setMode: (mode: RoomInputMode) => void; joinCode: string; setJoinCode: (value: string) => void; onCreate: () => void; onJoin: () => void; error: string; isCreating: boolean; health: boolean }) {
  return (
    <main className="arena-shell grain min-h-[100dvh] text-[hsl(var(--foreground))]">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1300px] flex-col px-5 py-5 sm:px-9 lg:px-14">
        <header className="flex items-center justify-between">
          <Brand compact />
          <div className="flex items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card)/.7)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]"><span className={`h-2 w-2 rounded-full ${health ? 'live-dot bg-[hsl(161_48%_47%)]' : 'bg-[hsl(var(--primary))]'}`} /> {health ? 'Arena systems live' : 'Connecting to arena'}</div>
        </header>
        <div className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[1.05fr_.95fr] lg:gap-20">
          <div className="rise">
            <div className="eyebrow flex items-center gap-2 text-[hsl(var(--primary))]"><Sparkles className="h-3.5 w-3.5" /> Four seats. One winner.</div>
            <h1 className="mt-5 max-w-[650px] text-5xl font-extrabold leading-[.98] tracking-[-.06em] sm:text-7xl">Make your move.<br /><span className="text-[hsl(var(--primary))]">Own the room.</span></h1>
            <p className="mt-6 max-w-[530px] text-base leading-7 text-[hsl(var(--muted-foreground))] sm:text-lg">A fast, social Ludo table for the group chat. Play the classic race, watch every roll, and keep the banter live.</p>
            <div className="mt-9 flex flex-wrap gap-3 text-xs text-[hsl(var(--muted-foreground))]"><span className="flex items-center gap-2"><Users className="h-4 w-4 text-[hsl(var(--accent))]" /> 4-player rooms</span><span className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-[hsl(var(--primary))]" /> Live room chat</span><span className="flex items-center gap-2"><Headphones className="h-4 w-4 text-[hsl(161_48%_47%)]" /> Voice ready</span></div>
          </div>
          <div className="rise-2 panel relative overflow-hidden rounded-[28px] p-6 sm:p-8">
            <div className="absolute -right-20 -top-20 h-48 w-48 rounded-full bg-[hsl(var(--primary)/.08)] blur-2xl" />
            <div className="relative"><p className="eyebrow">Start a match</p><h2 className="mt-2 text-2xl font-extrabold">Build your table</h2><p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">You will be the host. Invite friends with a room code once the table opens.</p>
              <div className="mt-7 grid grid-cols-2 gap-3">
                {(['classic', 'quick'] as RoomInputMode[]).map((item) => <button type="button" data-testid={`button-mode-${item}`} key={item} onClick={() => setMode(item)} className={`rounded-2xl border p-4 text-left transition ${mode === item ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/.12)]' : 'border-[hsl(var(--border))] bg-[hsl(var(--secondary)/.55)] hover:border-[hsl(var(--muted-foreground))]'}`}><div className="flex items-center justify-between"><Dices className={`h-5 w-5 ${mode === item ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} />{mode === item && <Check className="h-4 w-4 text-[hsl(var(--primary))]" />}</div><p className="mt-4 text-sm font-bold capitalize">{item}</p><p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{item === 'classic' ? 'The original race' : 'Shorter, sharper rounds'}</p></button>)}
              </div>
              <button type="button" data-testid="button-create-room" onClick={onCreate} disabled={isCreating} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-[hsl(var(--primary))] px-5 py-4 text-sm font-extrabold text-[hsl(var(--primary-foreground))] transition hover:-translate-y-0.5 hover:shadow-[0_10px_24px_hsl(43_96%_57%/.2)] disabled:cursor-wait disabled:opacity-70">{isCreating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />} {isCreating ? 'Opening table…' : 'Create a room'}<ArrowRight className="ml-auto h-4 w-4" /></button>
              <div className="my-6 flex items-center gap-3 text-[10px] uppercase tracking-[.16em] text-[hsl(var(--muted-foreground))]"><span className="h-px flex-1 bg-[hsl(var(--border))]" /> or join a room <span className="h-px flex-1 bg-[hsl(var(--border))]" /></div>
              <div className="flex gap-2"><input data-testid="input-room-code" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} maxLength={12} placeholder="ENTER ROOM CODE" className="min-w-0 flex-1 rounded-2xl border border-[hsl(var(--input))] bg-[hsl(var(--background)/.5)] px-4 py-3 text-sm font-bold tracking-[.12em] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:border-[hsl(var(--primary))]" /><button type="button" data-testid="button-join-room" onClick={onJoin} className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--secondary))] px-4 text-sm font-bold transition hover:border-[hsl(var(--primary))]">Join</button></div>
              {error && <p data-testid="status-room-error" className="mt-4 flex items-start gap-2 text-xs leading-5 text-[hsl(var(--accent))]"><WifiOff className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
              <p className="mt-5 text-center text-xs text-[hsl(var(--muted-foreground))]">Playing as <strong className="text-[hsl(var(--foreground))]">{guest.name}</strong>{guest.username ? ` / @${guest.username}` : ''}</p>
            </div>
          </div>
        </div>
        <footer className="flex items-center justify-between border-t border-[hsl(var(--border))] pt-5 text-[11px] text-[hsl(var(--muted-foreground))]"><span className="mono">LUDO ARENA / TELEGRAM MINI APP</span><span>Made for loud group chats</span></footer>
      </div>
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-[13px] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_8px_18px_hsl(43_96%_57%/.2)]"><Dices className="h-5 w-5" /></div><div><p className="text-sm font-extrabold tracking-[-.02em]">Ludo Arena</p>{!compact && <p className="eyebrow mt-0.5">Live room</p>}</div></div>;
}

function ArenaHeader({ room, connection, health, onLeave }: { room: Room; connection: ConnectionState; health: boolean; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard?.writeText(room.roomCode); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  return <header className="flex flex-wrap items-center justify-between gap-4"><Brand /><div className="flex items-center gap-2 sm:gap-3"><div className="hidden items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card)/.64)] px-3 py-2 text-xs sm:flex"><span className={`h-2 w-2 rounded-full ${connection === 'connected' ? 'live-dot bg-[hsl(161_48%_47%)]' : connection === 'connecting' ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--accent))]'}`} /><span className="text-[hsl(var(--muted-foreground))]">{connection === 'connected' ? 'Live connection' : connection === 'connecting' ? 'Joining room' : 'Preview mode'}</span></div><div className="flex items-center gap-1 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card)/.64)] p-1"><button type="button" data-testid="button-copy-room" onClick={copy} className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition hover:bg-[hsl(var(--secondary))]"><span className="eyebrow !text-[.58rem]">Code</span><span className="mono tracking-widest text-[hsl(var(--primary))]">{room.roomCode}</span>{copied ? <Check className="h-3.5 w-3.5 text-[hsl(161_48%_47%)]" /> : <Copy className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />}</button><button type="button" data-testid="button-room-menu" onClick={copy} title="Copy room code" className="rounded-lg p-2 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]"><MoreHorizontal className="h-4 w-4" /></button></div><button type="button" data-testid="button-leave-room" onClick={onLeave} className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold text-[hsl(var(--muted-foreground))] transition hover:border-[hsl(var(--accent))] hover:text-[hsl(var(--accent))]">Leave</button></div></header>;
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return <div data-testid="status-room-notice" className="mt-4 flex items-center gap-3 rounded-xl border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.08)] px-4 py-3 text-xs text-[hsl(var(--foreground))]"><WifiOff className="h-4 w-4 text-[hsl(var(--accent))]" /><span className="flex-1">{text}</span><button type="button" data-testid="button-dismiss-notice" onClick={onClose}><X className="h-4 w-4 text-[hsl(var(--muted-foreground))]" /></button></div>;
}

function RoomLoading({ code }: { code: string }) {
  return <main className="arena-shell min-h-[100dvh] p-5 text-[hsl(var(--foreground))]"><div className="mx-auto max-w-[1500px]"><Brand /><div className="mt-10 grid gap-5 lg:grid-cols-[1fr_345px]"><div className="panel h-[650px] animate-pulse rounded-[28px] bg-[hsl(var(--card)/.55)]" /><div className="space-y-4"><div className="panel h-24 animate-pulse rounded-2xl" /><div className="panel h-[400px] animate-pulse rounded-2xl" /></div></div><p data-testid="status-room-loading" className="mt-5 text-center text-sm text-[hsl(var(--muted-foreground))]">Joining room <span className="mono text-[hsl(var(--primary))]">{code}</span>…</p></div></main>;
}

function GameStage({ room, guestId, isSpectator, dice, onRoll, onStart, onMove, onRematch }: { room: Room; guestId: string; isSpectator: boolean; dice: number | null; onRoll: () => void; onStart: () => void; onMove: (tokenIndex: number) => void; onRematch: () => void }) {
  const guestIndex = room.players.findIndex((player) => player.id === guestId);
  const canStart = room.status === 'waiting' && (guestIndex === 0 || room.players.find((player) => player.id === guestId)?.isHost);
  return <div className="panel arena-grid relative overflow-hidden rounded-[28px] p-4 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow flex items-center gap-2"><span className="live-dot h-2 w-2 rounded-full bg-[hsl(161_48%_47%)]" /> {room.status === 'playing' ? 'Match in progress' : room.status === 'finished' ? 'Match complete' : 'Waiting for players'}</p><h1 className="mt-2 text-2xl font-extrabold tracking-[-.04em] sm:text-3xl">{room.status === 'playing' ? 'The table is hot.' : room.status === 'finished' ? 'That was a good one.' : 'Seats are filling up.'}</h1></div><div className="flex items-center gap-2 rounded-xl bg-[hsl(var(--background)/.4)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]"><Activity className="h-4 w-4 text-[hsl(var(--primary))]" /> Turn {room.currentPlayer + 1} / 4</div></div><div className="mt-6 flex flex-col items-center gap-5 xl:flex-row xl:items-end xl:justify-center xl:gap-10"><div className="w-full max-w-[590px] board-wrap"><LudoBoard room={room} guestId={guestId} dice={dice} onMove={onMove} /></div><div className="flex w-full max-w-[590px] flex-col items-center gap-4 xl:w-44"><div className="flex items-center gap-3"><div className="dice" data-testid="value-dice">{dice ?? '—'}</div><div><p className="eyebrow">Last roll</p><p className="mt-1 text-sm font-bold">{dice ? `Player ${room.currentPlayer + 1} rolled` : 'Waiting on the table'}</p></div></div>{room.status === 'waiting' && canStart && <button type="button" data-testid="button-start-match" onClick={onStart} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-3 text-sm font-extrabold text-[hsl(var(--primary-foreground))]"><Play className="h-4 w-4 fill-current" /> Start match</button>}{room.status === 'playing' && !isSpectator && guestIndex === room.currentPlayer && <button type="button" data-testid="button-roll-dice" onClick={onRoll} disabled={dice !== null} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-3 text-sm font-extrabold text-[hsl(var(--primary-foreground))] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40"><Dices className="h-4 w-4" /> {dice === null ? 'Roll dice' : 'Choose a token'}</button>}{room.status === 'finished' && guestIndex === 0 && <button type="button" data-testid="button-rematch" onClick={onRematch} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-3 text-sm font-extrabold text-[hsl(var(--primary-foreground))]"><RefreshCw className="h-4 w-4" /> Request rematch</button>}<p className="text-center text-[11px] leading-5 text-[hsl(var(--muted-foreground))]">{isSpectator ? 'Spectator mode: enjoy the view.' : room.status === 'waiting' ? 'Host can start when the table is ready.' : guestIndex === room.currentPlayer ? 'Your turn. Roll, then choose a highlighted token.' : 'Watch the board while the next player decides.'}</p></div></div></div>;
}

const track: [number, number][] = [
  ...Array.from({ length: 5 }, (_, i) => [6, i + 1] as [number, number]),
  ...Array.from({ length: 5 }, (_, i) => [5 - i, 6] as [number, number]),
  ...([[0, 6], [0, 7], [0, 8]] as [number, number][]),
  ...Array.from({ length: 5 }, (_, i) => [i + 1, 8] as [number, number]),
  ...Array.from({ length: 5 }, (_, i) => [6, i + 9] as [number, number]),
  ...([[6, 14], [7, 14], [8, 14]] as [number, number][]),
  ...Array.from({ length: 5 }, (_, i) => [8, 13 - i] as [number, number]),
  ...Array.from({ length: 5 }, (_, i) => [i + 9, 8] as [number, number]),
  ...([[14, 8], [14, 7], [14, 6]] as [number, number][]),
  ...Array.from({ length: 5 }, (_, i) => [13 - i, 6] as [number, number]),
  ...Array.from({ length: 5 }, (_, i) => [8, 5 - i] as [number, number]),
  ...([[8, 0], [7, 0], [6, 0]] as [number, number][]),
];
const lanes: [number, number][][] = [
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
];
const yards: [number, number][][] = [
  [[1, 1], [1, 4], [4, 1], [4, 4]],
  [[1, 10], [1, 13], [4, 10], [4, 13]],
  [[10, 10], [10, 13], [13, 10], [13, 13]],
  [[10, 1], [10, 4], [13, 1], [13, 4]],
];
const boardColors = ['red', 'green', 'yellow', 'blue'];

function boardPosition(playerIndex: number, tokenIndex: number, progress: number) {
  if (progress < 0) return yards[playerIndex][tokenIndex];
  if (progress >= 52 && progress < 57) return lanes[playerIndex][progress - 52];
  if (progress >= 57) return [7, 7] as [number, number];
  return track[(playerIndex * 13 + progress) % 52];
}

function boardPercent(value: number) {
  return `${9 + ((value + 0.5) / 15) * 82}%`;
}

function LudoBoard({ room, guestId, dice, onMove }: { room: Room; guestId: string; dice: number | null; onMove: (tokenIndex: number) => void }) {
  const cells = useMemo(() => Array.from({ length: 225 }, (_, index) => index), []);
  const guestIndex = room.players.findIndex((player) => player.id === guestId);
  return <div className="ludo-board"><div className="board-grid">{cells.map((cell) => { const row = Math.floor(cell / 15); const col = cell % 15; const isCenter = row >= 6 && row <= 8 && col >= 6 && col <= 8; const isTrack = track.some(([trackRow, trackCol]) => trackRow === row && trackCol === col); let cellClass = 'board-cell'; if (row < 6 && col < 6) cellClass += ' home-red'; else if (row < 6 && col > 8) cellClass += ' home-green'; else if (row > 8 && col < 6) cellClass += ' home-blue'; else if (row > 8 && col > 8) cellClass += ' home-yellow'; else if (isCenter) cellClass += ' board-center'; else if (isTrack) cellClass += ' board-track'; return <div key={cell} className={cellClass} />; })}</div>{room.tokens.map((playerTokens, playerIndex) => playerTokens.map((progress, tokenIndex) => { const [row, col] = boardPosition(playerIndex, tokenIndex, progress); const movable = room.status === 'playing' && guestIndex === room.currentPlayer && guestIndex === playerIndex && dice !== null && ((progress === -1 && dice === 6) || (progress >= 0 && progress + dice <= 57)); return <button key={`${playerIndex}-${tokenIndex}`} type="button" aria-label={`${boardColors[playerIndex]} token ${tokenIndex + 1}`} onClick={() => movable && onMove(tokenIndex)} className={`token token-${boardColors[playerIndex]} ${movable ? 'movable-token' : ''}`} style={{ left: boardPercent(col), top: boardPercent(row) }}>{tokenIndex + 1}</button>; }))}<span className="absolute left-[45.5%] top-[45.5%] h-[9%] w-[9%] rounded-full border-4 border-[hsl(43_34%_88%)] bg-[hsl(43_96%_57%)] shadow-lg" /></div>;
}

function PlayerRail({ room, guestId, spectatorMode, onSpectator }: { room: Room; guestId: string; spectatorMode: boolean; onSpectator: () => void }) {
  const seats = [...room.players, ...Array.from({ length: Math.max(0, 4 - room.players.length) }, (_, index) => null)];
  return <div className="panel-soft rounded-2xl p-3"><div className="flex items-center justify-between px-2 pb-2"><p className="eyebrow">Player seats</p><button type="button" data-testid="button-spectator-toggle" onClick={onSpectator} className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-bold transition ${spectatorMode ? 'bg-[hsl(var(--primary)/.14)] text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]'}`}><PanelTop className="h-3.5 w-3.5" /> {spectatorMode ? 'Watching' : 'Spectate'}</button></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{seats.map((player, index) => player ? <Seat key={player.id} player={player} active={room.currentPlayer === index} isYou={player.id === guestId} /> : <div data-testid={`seat-open-${index}`} key={`open-${index}`} className="flex items-center gap-2 rounded-xl border border-dashed border-[hsl(var(--border))] px-3 py-2.5"><div className="grid h-8 w-8 place-items-center rounded-full bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]"><Users className="h-3.5 w-3.5" /></div><div className="min-w-0"><p className="truncate text-xs font-bold text-[hsl(var(--muted-foreground))]">Open seat</p><p className="text-[10px] text-[hsl(var(--muted-foreground))]">Invite a friend</p></div></div>)}</div></div>;
}

function Seat({ player, active, isYou }: { player: Player; active: boolean; isYou: boolean }) {
  return <div data-testid={`seat-player-${player.id}`} className={`relative flex items-center gap-2 rounded-xl border px-3 py-2.5 transition ${active ? 'border-[hsl(var(--primary)/.6)] bg-[hsl(var(--primary)/.1)]' : 'border-[hsl(var(--border))] bg-[hsl(var(--card)/.45)]'}`}><div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-extrabold text-[hsl(var(--primary-foreground))] ${colorBg[player.color] || colorBg.yellow}`}>{player.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0"><p className="truncate text-xs font-bold">{player.name} {isYou && <span className="font-normal text-[hsl(var(--muted-foreground))]">(you)</span>}</p><p className={`flex items-center gap-1 text-[10px] ${colorClass[player.color] || colorClass.yellow}`}>{player.isHost && <Crown className="h-2.5 w-2.5" />} {active ? 'Rolling now' : player.isHost ? 'Host' : 'Ready'}</p></div>{active && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[hsl(var(--primary))]" />}</div>;
}

function SpectatorPanel({ room }: { room: Room }) {
  return <div className="panel rounded-2xl p-4"><div className="flex items-center justify-between"><div><p className="eyebrow">In the stands</p><p data-testid="value-spectators" className="mt-1 text-2xl font-extrabold">{room.spectators}<span className="ml-1 text-sm font-medium text-[hsl(var(--muted-foreground))]">spectators</span></p></div><div className="grid h-10 w-10 place-items-center rounded-xl bg-[hsl(var(--accent)/.12)] text-[hsl(var(--accent))]"><Users className="h-5 w-5" /></div></div><div className="mt-4 flex items-center gap-2"><div className="flex -space-x-2">{['M', 'N', 'S', 'K'].slice(0, Math.min(4, room.spectators)).map((initial, index) => <div data-testid={`avatar-spectator-${index}`} key={initial} className="grid h-7 w-7 place-items-center rounded-full border-2 border-[hsl(var(--card))] bg-[hsl(var(--secondary))] text-[10px] font-bold text-[hsl(var(--foreground))]">{initial}</div>)}</div><span className="text-xs text-[hsl(var(--muted-foreground))]">Watching this match</span></div></div>;
}

function ChatPanel({ messages, chatText, setChatText, onChat }: { messages: ChatMessage[]; chatText: string; setChatText: (text: string) => void; onChat: (event: React.FormEvent) => void }) {
  return <div className="panel flex min-h-[350px] flex-col overflow-hidden rounded-2xl"><div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3"><div className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-[hsl(var(--primary))]" /><p className="text-sm font-extrabold">Room chat</p></div><span className="eyebrow">live</span></div><div className="flex-1 space-y-4 overflow-y-auto p-4">{messages.map((message) => <div data-testid={`chat-message-${message.id}`} key={message.id} className={`flex gap-2.5 ${message.own ? 'flex-row-reverse text-right' : ''}`}><div className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-extrabold ${message.own ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))]'}`}>{message.name.slice(0, 1)}</div><div className="min-w-0"><div className={`flex items-baseline gap-2 ${message.own ? 'justify-end' : ''}`}><p className="text-xs font-bold">{message.name}</p><span className="text-[10px] text-[hsl(var(--muted-foreground))]">{message.time}</span></div><p className={`mt-1 inline-block max-w-[240px] rounded-xl px-3 py-2 text-xs leading-5 ${message.own ? 'bg-[hsl(var(--primary)/.14)]' : 'bg-[hsl(var(--secondary))]'}`}>{message.body}</p></div></div>)}</div><form onSubmit={onChat} className="flex gap-2 border-t border-[hsl(var(--border))] p-3"><input data-testid="input-chat-message" value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Say something…" className="min-w-0 flex-1 rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--background)/.5)] px-3 py-2.5 text-xs focus:border-[hsl(var(--primary))]" /><button type="submit" data-testid="button-send-chat" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] transition hover:scale-105"><Send className="h-4 w-4" /></button></form></div>;
}

function VoicePanel({ isMicOn, isSoundOn, voiceStatus, setIsMicOn, setIsSoundOn, onRequest }: { isMicOn: boolean; isSoundOn: boolean; voiceStatus: string; setIsMicOn: (value: boolean) => void; setIsSoundOn: (value: boolean) => void; onRequest: () => void }) {
  return <div className="panel-soft flex items-center justify-between gap-3 rounded-2xl p-3"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[hsl(161_48%_47%/.12)] text-[hsl(161_48%_47%)]"><Headphones className="h-4 w-4" /></div><div><p className="text-xs font-bold">Table voice</p><p data-testid="status-voice" className="text-[10px] text-[hsl(var(--muted-foreground))]">{voiceStatus}</p></div></div><div className="flex items-center gap-1"><button type="button" data-testid="button-voice-request" onClick={onRequest} className="rounded-lg p-2 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]" title="Request voice"><Link2 className="h-4 w-4" /></button><button type="button" data-testid="button-toggle-mic" onClick={() => setIsMicOn(!isMicOn)} className={`rounded-lg p-2 ${isMicOn ? 'text-[hsl(var(--foreground))]' : 'bg-[hsl(var(--accent)/.12)] text-[hsl(var(--accent))]'}`}>{isMicOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}</button><button type="button" data-testid="button-toggle-sound" onClick={() => setIsSoundOn(!isSoundOn)} className="rounded-lg p-2 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))]">{isSoundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-[hsl(var(--accent))]" />}</button></div></div>;
}

export default App;