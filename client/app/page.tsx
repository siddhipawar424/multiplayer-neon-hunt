"use client";

import {
  useEffect, useState, useRef, useCallback, useMemo, memo,
} from "react";
import { io, Socket } from "socket.io-client";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

type PlayerSlot = { color: string; label: string; spawnX: number; spawnY: number; icon: string };
type Player = {
  socketId: string; name: string; x: number; y: number;
  score: number; streak: number; lastCatch: number;
  shieldUntil: number; speedUntil: number; connected: boolean;
  slotIndex: number; reconnectToken: string; ping: number;
};
type PowerUp = { x: number; y: number; type: "freeze"|"double"|"teleport"|"shield"|"speed"; id: string };
type ChatMsg = { name: string; color: string; text: string; ts: number };
type GameState = {
  id: string; players: Record<number, Player>;
  spectatorCount: number; enemy: { x: number; y: number };
  powerUps: PowerUp[]; timer: number; gameOver: boolean;
  started: boolean; frozenUntil: number; round: number;
  chat: ChatMsg[]; leaderboard: Record<string, number>;
  phase: "lobby"|"countdown"|"playing"|"gameover";
  countdownValue: number; boardSize: number; playerSlots: PlayerSlot[];
};
type GameEvent = {
  type: "catch"|"powerup_pickup"|"enemy_catch"|"player_disconnect"|"player_reconnect";
  slotIndex?: number; points?: number; streak?: number;
  frozen?: boolean; puType?: string; x?: number; y?: number; name?: string;
};
type Screen = "landing"|"lobby"|"game";
type Config = { BOARD_SIZE: number; MAX_PLAYERS_PER_ROOM: number; GAME_DURATION: number };
type Particle = { id: number; x: number; y: number; text: string; color: string };
type Toast = { id: number; text: string; color: string };

// ═══════════════════════════════════════════════════════════════════════════
// DESIGN CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  BG:      "#000b1e",
  BG2:     "#010d2a",
  CYAN:    "#00eeff",
  PURPLE:  "#a855f7",
  PINK:    "#ff1a5e",
  AMBER:   "#ffc400",
  GREEN:   "#00ff8a",
  TEXT:    "#c5d8f0",
  MUTED:   "#374e72",
  DIM:     "#1a2d50",
  BORDER:  "rgba(0,238,255,0.10)",
};

const PU_META: Record<string, { icon: string; label: string; color: string; desc: string }> = {
  freeze:   { icon: "❄", label: "FREEZE",  color: "#66d9ff", desc: "Freezes enemy for 4s"     },
  double:   { icon: "✦", label: "BONUS",   color: "#ffd700", desc: "+25 instant points"        },
  teleport: { icon: "⟡", label: "WARP",    color: "#ff79c6", desc: "Teleport to random cell"  },
  shield:   { icon: "⬡", label: "SHIELD",  color: "#00ff8a", desc: "Block enemy damage 5s"    },
  speed:    { icon: "⚡", label: "SPEED",   color: "#ffaa00", desc: "Double move speed 5s"     },
};

// ═══════════════════════════════════════════════════════════════════════════
// AUDIO ENGINE  — procedural, no samples
// ═══════════════════════════════════════════════════════════════════════════

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambOsc: OscillatorNode | null = null;
  private ambGain: GainNode | null = null;
  public enabled = true;

  private boot() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
    } catch {}
  }

  setEnabled(v: boolean) { this.enabled = v; }

  private tone(
    freq: number, dur: number, vol = 0.18,
    type: OscillatorType = "square",
    filterHz = 3200, attack = 0.004
  ) {
    if (!this.enabled) return;
    this.boot();
    if (!this.ctx || !this.master) return;
    try {
      const osc   = this.ctx.createOscillator();
      const gain  = this.ctx.createGain();
      const filt  = this.ctx.createBiquadFilter();
      filt.type = "lowpass"; filt.frequency.value = filterHz;
      osc.connect(filt); filt.connect(gain); gain.connect(this.master);
      osc.type = type; osc.frequency.value = freq;
      const t = this.ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + attack);
      gain.gain.exponentialRampToValueAtTime(0.001, t + attack + dur);
      osc.start(t); osc.stop(t + attack + dur + 0.06);
    } catch {}
  }

  private seq(steps: [number, number, number?][], gapMs = 65) {
    steps.forEach(([f, d, v], i) => setTimeout(() => this.tone(f, d, v ?? 0.16), i * gapMs));
  }

  private noise(dur: number, vol: number, fc = 200) {
    if (!this.enabled) return;
    this.boot();
    if (!this.ctx || !this.master) return;
    try {
      const n = Math.ceil(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const arr = buf.getChannelData(0);
      for (let i = 0; i < n; i++) arr[i] = Math.random() * 2 - 1;
      const src  = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      const filt = this.ctx.createBiquadFilter();
      filt.type = "bandpass"; filt.frequency.value = fc; filt.Q.value = 0.8;
      src.buffer = buf; src.connect(filt); filt.connect(gain); gain.connect(this.master);
      const t = this.ctx.currentTime;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.start(t); src.stop(t + dur + 0.04);
    } catch {}
  }

  catch(streak: number) {
    const b = 280 + Math.min(streak - 1, 5) * 110;
    this.tone(b, 0.07, 0.22, "square", 3200);
    setTimeout(() => this.tone(b * 1.33, 0.09, 0.18, "square"), 58);
    if (streak >= 3) {
      setTimeout(() => this.tone(b * 2,    0.12, 0.14, "sine", 5000), 125);
      setTimeout(() => this.tone(b * 2.67, 0.10, 0.11, "sine", 5000), 195);
    }
  }

  enemyCatch() {
    this.tone(145, 0.08, 0.30, "sawtooth", 900);
    setTimeout(() => this.tone(90, 0.28, 0.22, "sawtooth", 700), 70);
    this.noise(0.18, 0.28, 190);
  }

  powerup(type: string) {
    ({
      freeze:   () => this.seq([[1046,0.07],[1318,0.07],[1568,0.07],[2093,0.14,0.22]], 72),
      double:   () => this.seq([[523,0.05],[659,0.05],[784,0.05],[1046,0.10,0.22]], 52),
      teleport: () => this.seq([[880,0.05],[440,0.05],[1320,0.05],[660,0.05],[1760,0.12,0.2]], 46),
      shield:   () => this.seq([[220,0.12,0.14],[277,0.12,0.14],[330,0.2,0.18]], 100),
      speed:    () => { this.noise(0.08, 0.2, 600); this.seq([[880,0.04],[1100,0.04],[1320,0.06]], 36); },
    } as Record<string, ()=>void>)[type]?.();
  }

  countdown(n: number) {
    if (n > 0) {
      const p = [0, 550, 440, 330][n] ?? 330;
      this.tone(p, 0.22, 0.32, "square", 2600);
    } else {
      this.seq([[440,0.08,0.22],[554,0.08,0.22],[659,0.08,0.22],[880,0.18,0.28]], 88);
    }
  }

  gameStart() {
    this.seq([[330,0.07,0.2],[415,0.07,0.2],[523,0.07,0.2],[659,0.14,0.25],[880,0.2,0.28]], 82);
  }

  gameOver() {
    this.seq([[880,0.13,0.28],[698,0.13,0.25],[554,0.13,0.22],[440,0.13,0.2],[330,0.28,0.28]], 145);
  }

  uiClick()  { this.tone(1100, 0.035, 0.10, "square", 2800, 0.001); }
  move()     { this.tone(185,  0.022, 0.04, "square", 1100, 0.001); }

  startAmbient(urgency = 0) {
    if (!this.enabled) return;
    this.boot();
    if (!this.ctx || !this.master) return;
    this.stopAmbient();
    try {
      const osc  = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filt = this.ctx.createBiquadFilter();
      const lfo  = this.ctx.createOscillator();
      const lfog = this.ctx.createGain();
      filt.type = "lowpass"; filt.frequency.value = 100 + urgency * 200;
      osc.type = "sawtooth"; osc.frequency.value = 36 + urgency * 14;
      lfo.type = "sine"; lfo.frequency.value = 0.4 + urgency * 1.5;
      lfog.gain.value = 6 + urgency * 4;
      lfo.connect(lfog); lfog.connect(osc.frequency);
      osc.connect(filt); filt.connect(gain); gain.connect(this.master);
      gain.gain.value = 0.032;
      osc.start(); lfo.start();
      this.ambOsc = osc; this.ambGain = gain;
    } catch {}
  }

  stopAmbient() {
    if (!this.ctx || !this.ambGain || !this.ambOsc) return;
    try {
      this.ambGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
      const osc = this.ambOsc;
      this.ambOsc = null; this.ambGain = null;
      setTimeout(() => { try { osc.stop(); } catch {} }, 900);
    } catch {}
  }
}

const AUDIO = new AudioEngine();

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET SINGLETON
// ═══════════════════════════════════════════════════════════════════════════

const SERVER = typeof process !== "undefined"
  ? (process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001")
  : "http://localhost:3001";

let _sock: Socket | null = null;
function getSocket(): Socket {
  if (!_sock) _sock = io(SERVER, { reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1200 });
  return _sock;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

let _pid = 0;
function uid() { return _pid++; }

function manhattan(ax: number, ay: number, bx: number, by: number) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function dangerAlpha(cellX: number, cellY: number, ex: number, ey: number): number {
  const d = manhattan(cellX, cellY, ex, ey);
  if (d === 0) return 0; // enemy cell handled separately
  if (d === 1) return 0.45;
  if (d === 2) return 0.20;
  if (d === 3) return 0.07;
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function NeonHunt() {
  const [screen,        setScreen]        = useState<Screen>("landing");
  const [gs,            setGs]            = useState<GameState | null>(null);
  const [mySlot,        setMySlot]        = useState<number | null>(null);
  const [name,          setName]          = useState("");
  const [roomId,        setRoomId]        = useState("");
  const [joinId,        setJoinId]        = useState("");
  const [error,         setError]         = useState("");
  const [ping,          setPing]          = useState(0);
  const [particles,     setParticles]     = useState<Particle[]>([]);
  const [toasts,        setToasts]        = useState<Toast[]>([]);
  const [chatInput,     setChatInput]     = useState("");
  const [chatOpen,      setChatOpen]      = useState(false);
  const [soundOn,       setSoundOn]       = useState(true);
  const [shake,         setShake]         = useState(false);
  const [tilt,          setTilt]          = useState({ x: 0, y: 0 });
  const [isMobile,      setIsMobile]      = useState(false);
  const [config,        setConfig]        = useState<Config>({ BOARD_SIZE: 7, MAX_PLAYERS_PER_ROOM: 4, GAME_DURATION: 45 });

  const sockRef        = useRef<Socket | null>(null);
  const reToken        = useRef("");
  const prevScores     = useRef<Record<number, number>>({});
  const chatEndRef     = useRef<HTMLDivElement | null>(null);
  const boardRef       = useRef<HTMLDivElement | null>(null);
  const nameRef        = useRef<HTMLInputElement | null>(null);
  const soundRef       = useRef(true);
  const gsRef          = useRef<GameState | null>(null);
  const mySlotRef      = useRef<number | null>(null);

  // sync refs
  useEffect(() => { soundRef.current = soundOn; AUDIO.setEnabled(soundOn); }, [soundOn]);
  useEffect(() => { gsRef.current = gs; }, [gs]);
  useEffect(() => { mySlotRef.current = mySlot; }, [mySlot]);

  // ── mobile detection ─────────────────────────────────────────────────────
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check(); window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── restore session ───────────────────────────────────────────────────────
  useEffect(() => {
  try {
    const s = sessionStorage.getItem("nh_sess");

    if (!s) return;

    const { token, rid, n } = JSON.parse(s);

    reToken.current = token;

    requestAnimationFrame(() => {
      setName(n);
      setJoinId(rid);
    });

  } catch {}
}, []);

  // ── ambient music with timer urgency ─────────────────────────────────────
  useEffect(() => {
    if (gs?.phase === "playing") {
      const urgency = 1 - (gs.timer / config.GAME_DURATION);
      AUDIO.startAmbient(urgency);
    } else {
      AUDIO.stopAmbient();
    }
  }, [gs?.phase, gs?.timer, config.GAME_DURATION]);

  // ── helpers ───────────────────────────────────────────────────────────────
  const triggerShake = useCallback(() => {
    setShake(true);
    setTimeout(() => setShake(false), 420);
  }, []);

  const spawnParticle = useCallback((x: number, y: number, text: string, color: string) => {
    const id = uid();
    setParticles(ps => [...ps.slice(-24), { id, x, y, text, color }]);
    setTimeout(() => setParticles(ps => ps.filter(p => p.id !== id)), 950);
  }, []);

  const addToast = useCallback((text: string, color: string) => {
    const id = uid();
    setToasts(ts => [...ts.slice(-5), { id, text, color }]);
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 2600);
  }, []);

  // ── socket wiring ─────────────────────────────────────────────────────────
  useEffect(() => {
    const s = getSocket();
    sockRef.current = s;

    s.on("update", (state: GameState) => {
      setGs(prev => {
        // score delta → particles
        if (prev) {
          Object.entries(state.players).forEach(([si, p]) => {
            const idx = Number(si);
            const prev_ = prevScores.current[idx] ?? 0;
            if (p.score > prev_) spawnParticle(p.x, p.y, `+${p.score - prev_}`, state.playerSlots[idx]?.color ?? "#fff");
            prevScores.current[idx] = p.score;
          });
        }
        return state;
      });
      if (state.phase === "playing" && screen !== "game") setScreen("game");
    });

    s.on("event", (e: GameEvent) => {
      if (!soundRef.current) return;
      switch (e.type) {
        case "catch":
          AUDIO.catch(e.streak ?? 1);
          addToast(`${(e.streak ?? 0) >= 3 ? "🔥 STREAK! " : ""}+${e.points}`, C.AMBER);
          break;
        case "powerup_pickup":
          if (e.puType) { AUDIO.powerup(e.puType); const m = PU_META[e.puType]; addToast(`${m.icon} ${m.label}`, m.color); }
          break;
        case "enemy_catch":
          AUDIO.enemyCatch();
          addToast("💀 CAUGHT! −5", C.PINK);
          triggerShake();
          break;
        case "player_disconnect": addToast(`${e.name} disconnected`, C.MUTED); break;
        case "player_reconnect":  addToast(`${e.name} reconnected!`, C.GREEN); break;
      }
    });

    s.on("chat_msg", () => setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50));
    s.on("ping_server",   (ts: number) => { s.emit("pong_client", ts); });
    s.on("pong_server",   (ts: number) => setPing(Date.now() - ts));
    s.on("connect_error", () => setError("Cannot connect to server — is it running?"));
    s.on("connect",       () => setError(""));

    return () => { s.off("update"); s.off("event"); s.off("chat_msg"); s.off("ping_server"); s.off("pong_server"); s.off("connect_error"); s.off("connect"); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── countdown sfx ────────────────────────────────────────────────────────
  useEffect(() => {
    if (gs?.phase === "countdown") AUDIO.countdown(gs.countdownValue);
    if (gs?.phase === "playing" && !gs?.started)  {} // handled by startAmbient
    if (gs?.phase === "gameover") { AUDIO.stopAmbient(); AUDIO.gameOver(); }
  }, [gs]);

  // ── keyboard handler ──────────────────────────────────────────────────────
  useEffect(() => {
    if (screen !== "game" || chatOpen) return;
    const s = sockRef.current;
    if (!s) return;
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const dir = KEY_MAP[e.key];
      if (!dir) return;
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)) e.preventDefault();
      const slot = mySlotRef.current;
      if (slot === null) return;
      s.emit("move", { dir, slotIndex: slot });
      AUDIO.move();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [screen, chatOpen]);

  // ── board parallax tilt ────────────────────────────────────────────────────
  const handleBoardMouseMove = useCallback((e: React.MouseEvent) => {
    const el = boardRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2))  / r.width;
    const dy = (e.clientY - (r.top  + r.height / 2)) / r.height;
    setTilt({ x: dy * -5, y: dx * 5 });
  }, []);
  const resetTilt = useCallback(() => setTilt({ x: 0, y: 0 }), []);

  // ── actions ────────────────────────────────────────────────────────────────
  const createRoom = useCallback((priv: boolean) => {
  const s = sockRef.current;

  if (!name.trim()) {
    setError("Enter your name first");
    return;
  }

  if (!s) {
    setError("Not connected to server");
    return;
  }

  AUDIO.uiClick();

  s.emit(
    "create_room",
    { name, isPrivate: priv, reconnectToken: reToken.current },

    (res: {
      error?: string;
      roomId: string;
      slotIndex: number;
      config?: Partial<typeof config>;
      reconnectToken: string;
    }) => {

      if (res?.error) {
        setError(res.error);
        return;
      }

      setRoomId(res.roomId);
      setMySlot(res.slotIndex);

      if (res.config)
        setConfig(c => ({ ...c, ...res.config }));

      reToken.current = res.reconnectToken;

      sessionStorage.setItem(
        "nh_sess",
        JSON.stringify({
          token: res.reconnectToken,
          rid: res.roomId,
          n: name
        })
      );

      setScreen("lobby");
    }
  );
}, [name]);

  const joinRoom = useCallback((rid?: string) => {
  const s = sockRef.current;
  const target = (rid ?? joinId).toUpperCase();

  if (!name.trim()) {
    setError("Enter your name first");
    return;
  }

  if (!target) {
    setError("Enter a room code");
    return;
  }

  if (!s) {
    setError("Not connected");
    return;
  }

  AUDIO.uiClick();

  s.emit(
    "join_room",
    {
      roomId: target,
      name,
      reconnectToken: reToken.current,
    },
    (res: {
      error?: string;
      roomId?: string;
      slotIndex?: number;
      reconnectToken?: string;
      config?: Partial<typeof config>;
    }) => {
      if (res?.error) {
        setError(res.error);
        return;
      }

      setRoomId(res.roomId ?? target);
      setMySlot(res.slotIndex ?? null);

      if (res.config) {
        setConfig(c => ({ ...c, ...res.config }));
      }

      if (res.reconnectToken) {
        reToken.current = res.reconnectToken;

        sessionStorage.setItem(
          "nh_sess",
          JSON.stringify({
            token: res.reconnectToken,
            rid: res.roomId,
            n: name,
          })
        );
      }

      setScreen("lobby");
    }
  );
}, [name, joinId]);

  const startGame   = useCallback(() => { AUDIO.uiClick(); sockRef.current?.emit("start"); }, []);
  const restartGame = useCallback(() => { AUDIO.uiClick(); sockRef.current?.emit("restart"); setScreen("lobby"); }, []);
  const leaveGame   = useCallback(() => {
    AUDIO.uiClick();
    sockRef.current?.disconnect(); _sock = null;
    sessionStorage.removeItem("nh_sess");
    setScreen("landing"); setGs(null); setMySlot(null);
  }, []);
  const mobileMove = useCallback((dir: string) => {
    if (mySlot === null) return;
    sockRef.current?.emit("move", { dir, slotIndex: mySlot });
    AUDIO.move();
  }, [mySlot]);
  const sendChat = useCallback(() => {
    if (!chatInput.trim()) return;
    sockRef.current?.emit("chat", { message: chatInput });
    setChatInput("");
  }, [chatInput]);

  // ── derived ────────────────────────────────────────────────────────────────
  const [now, setNow] = useState(() => Date.now());

useEffect(() => {
  const interval = setInterval(() => {
    setNow(Date.now());
  }, 100);

  return () => clearInterval(interval);
}, []);

  const isFrozen  = gs ? now < gs.frozenUntil : false;
  const timer     = gs?.timer ?? config.GAME_DURATION;
  const timerPct  = (timer / config.GAME_DURATION) * 100;
  const timerClr  = timer > 20 ? C.GREEN : timer > 8 ? C.AMBER : C.PINK;
  const board     = config.BOARD_SIZE;

  const sortedLB = useMemo(() => {
    if (!gs) return [];
    return Object.entries(gs.leaderboard).sort(([,a],[,b]) => b - a).slice(0, 8);
  }, [gs]);

  const winner = useMemo(() => {
    if (!gs?.gameOver) return "";
    const s = Object.values(gs.players).sort((a,b) => b.score - a.score);
    if (!s.length) return "NO PLAYERS";
    if (s.length > 1 && s[0].score === s[1].score) return "🤝 IT'S A DRAW";
    return `🏆 ${s[0].name} WINS`;
  }, [gs]);

  // ──────────────────────────────────────────────────────────────────────────
  // LANDING SCREEN
  // ──────────────────────────────────────────────────────────────────────────
  if (screen === "landing") return (
    <div style={S.root}>
      <GridBG />
      <div style={S.landing}>
        <div style={S.logoWrap}>
          <div style={S.logoNeon}>NEON</div>
          <div style={S.logoHunt}>HUNT</div>
          <div style={S.logoSub}>DISTRIBUTED ARENA · UP TO 4 PLAYERS</div>
        </div>

        {error && <div style={S.error}>{error}</div>}

        <input
          ref={nameRef} style={S.input} placeholder="Your callsign…"
          maxLength={16} value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && nameRef.current?.blur()}
        />

        <div style={S.btnRow}>
          <Btn primary onClick={() => createRoom(false)}>＋ PUBLIC ROOM</Btn>
          <Btn onClick={() => createRoom(true)}>🔒 PRIVATE</Btn>
        </div>

        <div style={S.joinRow}>
          <input
            style={{ ...S.input, flex: 1, margin: 0 }}
            placeholder="Room code…" maxLength={6}
            value={joinId}
            onChange={e => setJoinId(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && joinRoom()}
          />
          <Btn primary onClick={() => joinRoom()}>JOIN →</Btn>
        </div>

        <div style={S.puGrid}>
          {Object.entries(PU_META).map(([type, m]) => (
            <div key={type} style={{ ...S.puCard, borderColor: m.color + "33" }}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>{m.icon}</span>
              <span style={{ color: m.color, fontSize: 9, letterSpacing: "0.3em", fontWeight: 700 }}>{m.label}</span>
              <span style={{ color: C.MUTED, fontSize: 9 }}>{m.desc}</span>
            </div>
          ))}
        </div>

        <div style={{ color: C.MUTED, fontSize: 9, letterSpacing: "0.3em", marginTop: 4 }}>
          ARROWS / WASD · SHIELD AGAINST ENEMY · STREAK FOR BONUS POINTS
        </div>
      </div>
    </div>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // LOBBY SCREEN
  // ──────────────────────────────────────────────────────────────────────────
  if (screen === "lobby") {
    return (
      <div style={S.root}>
        <GridBG />
        <div style={S.lobby}>
          <span style={S.tag}>ROOM · {roomId}</span>

          {gs?.phase === "countdown" ? (
            <div style={S.countBig}>{gs.countdownValue || "GO!"}</div>
          ) : (
            <div style={S.lobbyTitle}>WAITING FOR PLAYERS</div>
          )}

          <div style={S.slotGrid}>
            {Array.from({ length: config.MAX_PLAYERS_PER_ROOM }).map((_, i) => {
              const slot = gs?.playerSlots[i];
              const p = gs?.players[i];
              return (
                <div key={i} style={{
                  ...S.slot,
                  borderColor: p ? (slot?.color ?? "#333") + "66" : C.DIM,
                  background:  p ? (slot?.color ?? "#333") + "0e" : "rgba(255,255,255,0.015)",
                }}>
                  <div style={{ fontSize: 26, color: p ? (slot?.color ?? C.MUTED) : C.MUTED }}>
                    {slot?.icon ?? "○"}
                  </div>
                  {p ? (
                    <>
                      <div style={{ color: slot?.color, fontWeight: 700, fontSize: 13 }}>{p.name}</div>
                      <div style={{ fontSize: 8, color: p.connected ? C.GREEN : C.PINK, letterSpacing: "0.25em" }}>
                        {p.connected ? "● READY" : "○ OFFLINE"}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: C.MUTED, fontSize: 10, letterSpacing: "0.3em" }}>OPEN SLOT</div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={S.btnRow}>
            {mySlot !== null && gs?.phase === "lobby" && (
              <Btn primary onClick={startGame}>▶ START GAME</Btn>
            )}
            <Btn danger onClick={leaveGame}>← LEAVE</Btn>
          </div>

          {sortedLB.length > 0 && (
            <div style={S.lbCard}>
              <div style={S.lbHdr}>ALL-TIME LEADERBOARD</div>
              {sortedLB.map(([n, sc], i) => (
                <div key={n} style={S.lbRow}>
                  <span style={{ color: i === 0 ? C.AMBER : C.MUTED, minWidth: 22 }}>#{i+1}</span>
                  <span style={{ flex: 1, color: C.TEXT }}>{n}</span>
                  <span style={{ color: C.CYAN, fontWeight: 700 }}>{sc}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ color: C.MUTED, fontSize: 9, letterSpacing: "0.35em" }}>
            SHARE: <span style={{ color: C.DIM, letterSpacing: "0.5em" }}>{roomId}</span>
            {gs?.spectatorCount ? `  ·  ${gs.spectatorCount} spectating` : ""}
          </div>
        </div>
      </div>
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GAME SCREEN
  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ ...S.root, ...(shake ? S.shake : {}) }}>
      <GridBG />

      {/* ── Countdown overlay ── */}
      {gs?.phase === "countdown" && (
        <div style={S.overlay}>
          <div style={S.cntNum}>{gs.countdownValue || "GO!"}</div>
        </div>
      )}

      {/* ── Game Over overlay ── */}
      {gs?.phase === "gameover" && (
        <div style={S.overlay}>
          <div style={S.goInner}>
            <div style={{ color: C.MUTED, fontSize: 10, letterSpacing: "0.5em", marginBottom: 6 }}>
              ROUND {gs.round} COMPLETE
            </div>
            <div style={S.winner}>{winner}</div>
            <div style={S.scoreGrid}>
              {Object.entries(gs.players)
                .sort(([,a],[,b]) => b.score - a.score)
                .map(([si, p]) => {
                  const slot = gs.playerSlots[Number(si)];
                  return (
                    <div key={si} style={S.scoreCard}>
                      <div style={{ color: slot?.color, fontSize: 36, fontWeight: 900, lineHeight: 1, textShadow: `0 0 20px ${slot?.color}88` }}>{p.score}</div>
                      <div style={{ color: slot?.color, fontSize: 10, letterSpacing: "0.2em" }}>{p.name}</div>
                    </div>
                  );
                })}
            </div>
            {sortedLB.length > 0 && (
              <div style={{ ...S.lbCard, maxWidth: 300 }}>
                <div style={S.lbHdr}>LEADERBOARD</div>
                {sortedLB.map(([n, sc], i) => (
                  <div key={n} style={S.lbRow}>
                    <span style={{ color: i===0 ? C.AMBER : C.MUTED, minWidth: 22 }}>#{i+1}</span>
                    <span style={{ flex: 1, color: C.TEXT }}>{n}</span>
                    <span style={{ color: C.CYAN, fontWeight: 700 }}>{sc}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ ...S.btnRow, marginTop: 18 }}>
              <Btn primary onClick={restartGame}>↺ NEXT ROUND</Btn>
              <Btn danger onClick={leaveGame}>← LEAVE</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── HUD ── */}
      <div style={S.hud}>
        {/* Player chips */}
        <div style={S.hudPlayers}>
          {gs && Object.entries(gs.players).map(([si, p]) => {
            const slot = gs.playerSlots[Number(si)];
            const isMe = Number(si) === mySlot;
            const hasShield = now < (p.shieldUntil || 0);
            const hasSpeed  = now < (p.speedUntil  || 0);
            const shieldPct = hasShield ? ((p.shieldUntil - now) / 5000) * 100 : 0;
            const speedPct  = hasSpeed  ? ((p.speedUntil  - now) / 5000) * 100 : 0;
            return (
              <div key={si} style={{
                ...S.chip,
                borderColor: (slot?.color ?? "#333") + (isMe ? "cc" : "33"),
                background:  isMe ? (slot?.color ?? "#333") + "15" : "rgba(0,0,0,0.35)",
                boxShadow:   isMe ? `0 0 16px ${slot?.color}22` : "none",
              }}>
                <span style={{ fontSize: 18, color: slot?.color }}>{slot?.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ color: slot?.color, fontWeight: 700, fontSize: 11 }}>
                      {p.name}{isMe ? " ◂" : ""}
                    </span>
                    {!p.connected && <span style={{ color: C.PINK, fontSize: 9 }}>⚠ OFFLINE</span>}
                  </div>
                  <div style={{ color: slot?.color, fontSize: 22, fontWeight: 900, lineHeight: 1.1, textShadow: `0 0 12px ${slot?.color}66` }}>
                    {p.score}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 2, alignItems: "center" }}>
                    {p.streak >= 2 && <span style={{ color: C.AMBER, fontSize: 9 }}>🔥 ×{p.streak}</span>}
                    {hasShield && (
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <span style={{ color: C.GREEN, fontSize: 9 }}>⬡</span>
                        <div style={{ width: 28, height: 3, background: C.DIM, borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ width: `${shieldPct}%`, height: "100%", background: C.GREEN, borderRadius: 2 }} />
                        </div>
                      </div>
                    )}
                    {hasSpeed && (
                      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        <span style={{ color: C.AMBER, fontSize: 9 }}>⚡</span>
                        <div style={{ width: 28, height: 3, background: C.DIM, borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ width: `${speedPct}%`, height: "100%", background: C.AMBER, borderRadius: 2 }} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 8, color: C.MUTED }}>{p.ping}ms</div>
              </div>
            );
          })}
        </div>

        {/* Timer */}
        <div style={S.timerWrap}>
          <div style={{ ...S.timerNum, color: timerClr }}>{timer}</div>
          <div style={S.timerTrack}>
            <div style={{ ...S.timerFill, width: `${timerPct}%`, background: timerClr }} />
          </div>
          {isFrozen && <div style={{ color: "#66d9ff", fontSize: 9, letterSpacing: "0.2em" }}>❄ FROZEN</div>}
          <div style={{ color: C.MUTED, fontSize: 8, letterSpacing: "0.25em" }}>RND {gs?.round}</div>
        </div>

        {/* Controls */}
        <div style={S.hudRight}>
          <div style={{ color: C.MUTED, fontSize: 8, textAlign: "right" }}>{ping}ms</div>
          <button style={S.iconBtn} onClick={() => { AUDIO.uiClick(); setSoundOn(s => !s); }}>
            {soundOn ? "🔊" : "🔇"}
          </button>
          <button style={S.iconBtn} onClick={() => { AUDIO.uiClick(); setChatOpen(o => !o); }}>💬</button>
          <button style={{ ...S.iconBtn, color: C.PINK }} onClick={restartGame}>✕</button>
        </div>
      </div>

      {/* ── Toasts ── */}
      <div style={S.toastStack}>
        {toasts.map(t => (
          <div key={t.id} style={{ ...S.toast, color: t.color, borderColor: t.color + "55", boxShadow: `0 0 12px ${t.color}33` }}>
            {t.text}
          </div>
        ))}
      </div>

      {/* ── Board ── */}
      <div
        ref={boardRef}
        style={{
          ...S.boardWrap,
          transform: `perspective(1100px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: "transform 0.15s ease-out",
        }}
        onMouseMove={handleBoardMouseMove}
        onMouseLeave={resetTilt}
      >
        <div style={{ ...S.boardInner, gridTemplateColumns: `repeat(${board}, 1fr)` }}>
          {Array.from({ length: board * board }).map((_, i) => {
            const cx = i % board;
            const cy = Math.floor(i / board);
            const isEnemy  = gs?.enemy.x === cx && gs?.enemy.y === cy;
            const pUp      = gs?.powerUps.find(pu => pu.x === cx && pu.y === cy);
            const danger   = gs ? dangerAlpha(cx, cy, gs.enemy.x, gs.enemy.y) : 0;
            const here     = gs ? Object.entries(gs.players).filter(([, p]) => p.x === cx && p.y === cy) : [];

            return (
              <div
                key={i}
                style={{
                  ...S.cell,
                  background: isEnemy
                    ? "rgba(255,26,94,0.12)"
                    : danger > 0
                    ? `rgba(255,26,94,${danger * 0.55})`
                    : "rgba(0,14,40,0.7)",
                  boxShadow: isEnemy
                    ? `inset 0 0 16px rgba(255,26,94,0.3), 0 0 8px rgba(255,26,94,0.2)`
                    : danger > 0.3
                    ? `inset 0 0 10px rgba(255,26,94,${danger * 0.4})`
                    : "0 3px 8px rgba(0,0,0,0.5)",
                  borderColor: isEnemy ? "rgba(255,26,94,0.4)" : "rgba(0,238,255,0.07)",
                }}
              >
                {/* Power-up token */}
                {pUp && !isEnemy && (() => {
                  const m = PU_META[pUp.type];
                  return (
                    <div style={{ ...S.puToken, color: m.color, borderColor: m.color + "44", boxShadow: `0 0 12px ${m.color}55` }}>
                      {m.icon}
                    </div>
                  );
                })()}

                {/* Enemy */}
                {isEnemy && (
                  <div style={{ ...S.enemy, ...(isFrozen ? S.enemyFrozen : {}) }}>
                    <div style={S.enemyCore} />
                    {!isFrozen && <div style={S.enemyRing} />}
                  </div>
                )}

                {/* Players */}
                {here.map(([si, p]) => {
                  const slot  = gs!.playerSlots[Number(si)];
                  const shield = now < (p.shieldUntil || 0);
                  const speed  = now < (p.speedUntil  || 0);
                  return (
                    <div key={si} style={{
                      ...S.token,
                      background: `radial-gradient(circle at 35% 35%, ${slot?.color}dd, ${slot?.color}88)`,
                      boxShadow: shield
                        ? `0 0 0 2px ${C.GREEN}, 0 0 24px ${C.GREEN}88, 0 0 8px ${slot?.color}66`
                        : `0 0 18px ${slot?.color}88, 0 2px 6px rgba(0,0,0,0.5)`,
                      outline: speed ? `2px solid ${C.AMBER}` : "none",
                    }}>
                      {slot?.icon ?? "?"}
                    </div>
                  );
                })}

                {/* Particles */}
                {particles.filter(pt => pt.x === cx && pt.y === cy).map(pt => (
                  <div key={pt.id} style={{ ...S.particle, color: pt.color }}>
                    {pt.text}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Mobile D-pad ── */}
      {isMobile && mySlot !== null && (
        <div style={{ position: "relative", zIndex: 2 }}>
          <Dpad color={gs?.playerSlots[mySlot]?.color ?? C.CYAN} onDir={mobileMove} />
        </div>
      )}

      {/* ── Chat panel ── */}
      {chatOpen && (
        <div style={S.chat}>
          <div style={S.chatHdr}>
            CHAT
            <button style={S.iconBtn} onClick={() => setChatOpen(false)}>✕</button>
          </div>
          <div style={S.chatMsgs}>
            {gs?.chat.map((m, i) => (
              <div key={i} style={{ fontSize: 11, lineHeight: 1.5 }}>
                <span style={{ color: m.color, fontWeight: 700 }}>{m.name}: </span>
                <span style={{ color: "#8898b8" }}>{m.text}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div style={S.chatFoot}>
            <input
              style={S.chatIn}
              placeholder="Say something…"
              value={chatInput}
              maxLength={120}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendChat()}
            />
            <Btn primary onClick={sendChat}>↵</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function Btn({ children, primary, danger, onClick }: {
  children: React.ReactNode; primary?: boolean; danger?: boolean; onClick?: () => void;
}) {
  return (
    <button
      style={{
        ...S.btn,
        ...(primary ? S.btnP : danger ? S.btnD : S.btnN),
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Dpad = memo(function Dpad({ color, onDir }: { color: string; onDir: (d: string) => void }) {
  const grid: (string|null)[] = [null,"up",null,"left",null,"right",null,"down",null];
  const icons: Record<string,string> = { up:"▲", down:"▼", left:"◀", right:"▶" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 52px)", gap: 6 }}>
      {grid.map((dir, i) => (
        <button
          key={i}
          disabled={!dir}
          onPointerDown={e => {
            e.preventDefault();
            if (dir) onDir(dir);
          }}
          style={{
            width: 52,
            height: 52,
            borderRadius: 10,
            background: dir ? `${color}1a` : "transparent",
            border: dir ? `1px solid ${color}44` : "none",
            color,
            fontSize: 20,
            cursor: dir ? "pointer" : "default",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            visibility: dir ? "visible" : "hidden",
            WebkitTapHighlightColor: "transparent",
            userSelect: "none",
            boxShadow: dir ? `0 0 12px ${color}22, inset 0 1px 0 ${color}22` : "none",
            transition: "background 0.1s",
          }}
        >
          {dir ? icons[dir] : ""}
        </button>
      ))}
    </div>
  );
});

function GridBG() {
  return (
    <>
      <div style={S.bgGrid} />
      <div style={S.bgScan} />
      <div style={S.bgBlob1} />
      <div style={S.bgBlob2} />
      <div style={S.bgVignette} />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// KEY MAP
// ═══════════════════════════════════════════════════════════════════════════

const KEY_MAP: Record<string, string> = {
  ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right",
  w:"up", s:"down", a:"left", d:"right",
};

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════

const S: Record<string, React.CSSProperties> = {
  // ── Root ──────────────────────────────────────────────────────────────────
  root: {
    minHeight: "100dvh",
    background: C.BG,
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    fontFamily: "'Share Tech Mono', 'Courier New', monospace",
    color: C.TEXT, position: "relative", overflow: "hidden",
    padding: "12px", gap: 12,
  },
  shake: { animation: "shake 0.4s ease" },

  // ── Backgrounds ───────────────────────────────────────────────────────────
  bgGrid: {
    position: "fixed", inset: 0,
    backgroundImage:
      "linear-gradient(rgba(0,238,255,0.025) 1px, transparent 1px)," +
      "linear-gradient(90deg, rgba(0,238,255,0.025) 1px, transparent 1px)",
    backgroundSize: "46px 46px",
    pointerEvents: "none", zIndex: 0,
  },
  bgScan: {
    position: "fixed", inset: 0,
    background: "repeating-linear-gradient(to bottom, transparent, transparent 2px, rgba(0,0,0,0.07) 2px, rgba(0,0,0,0.07) 3px)",
    pointerEvents: "none", zIndex: 0,
  },
  bgBlob1: {
    position: "fixed", top: "-20%", left: "-15%",
    width: "55vw", height: "55vw", borderRadius: "50%",
    background: "radial-gradient(circle, rgba(0,238,255,0.04), transparent 65%)",
    pointerEvents: "none", zIndex: 0,
  },
  bgBlob2: {
    position: "fixed", bottom: "-25%", right: "-15%",
    width: "60vw", height: "60vw", borderRadius: "50%",
    background: "radial-gradient(circle, rgba(168,85,247,0.05), transparent 65%)",
    pointerEvents: "none", zIndex: 0,
  },
  bgVignette: {
    position: "fixed", inset: 0,
    background: "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.7) 100%)",
    pointerEvents: "none", zIndex: 0,
  },

  // ── Landing ───────────────────────────────────────────────────────────────
  landing: {
    position: "relative", zIndex: 2,
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 14, maxWidth: 520, width: "100%", textAlign: "center",
  },
  logoWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, marginBottom: 4 },
  logoNeon: {
    fontFamily: "'Orbitron', 'Courier New', monospace",
    fontSize: "clamp(48px, 14vw, 80px)",
    fontWeight: 900, letterSpacing: "0.35em", lineHeight: 1,
    color: C.CYAN,
    textShadow: `0 0 30px ${C.CYAN}aa, 0 0 70px ${C.CYAN}44, 0 0 120px ${C.CYAN}22`,
  },
  logoHunt: {
    fontFamily: "'Orbitron', 'Courier New', monospace",
    fontSize: "clamp(48px, 14vw, 80px)",
    fontWeight: 900, letterSpacing: "0.35em", lineHeight: 1,
    color: "#fff",
    textShadow: "0 0 20px rgba(255,255,255,0.3)",
  },
  logoSub: { color: C.MUTED, fontSize: 9, letterSpacing: "0.5em", marginTop: 6 },

  input: {
    width: "100%", padding: "13px 18px",
    background: "rgba(0,238,255,0.04)",
    border: `1px solid rgba(0,238,255,0.14)`,
    borderRadius: 8, color: C.TEXT, fontSize: 13,
    fontFamily: "'Share Tech Mono', monospace",
    outline: "none", boxSizing: "border-box",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  btnRow: { display: "flex", gap: 10, width: "100%", flexWrap: "wrap" as const },
  joinRow: { display: "flex", gap: 8, width: "100%", alignItems: "center" },

  btn: {
    flex: 1, padding: "12px 20px", fontSize: 11, fontWeight: 700,
    letterSpacing: "0.25em", borderRadius: 8, border: "none",
    cursor: "pointer", fontFamily: "'Share Tech Mono', monospace",
    transition: "opacity 0.15s, transform 0.1s",
    minWidth: 110,
  },
  btnP: {
    background: `linear-gradient(135deg, #00c0cc, ${C.CYAN})`,
    color: "#001820",
    boxShadow: `0 0 28px rgba(0,238,255,0.35), inset 0 1px 0 rgba(255,255,255,0.2)`,
  },
  btnN: {
    background: "rgba(255,255,255,0.05)", color: "#8898b8",
    border: "1px solid rgba(255,255,255,0.09)",
  },
  btnD: {
    background: "rgba(255,26,94,0.1)", color: C.PINK,
    border: `1px solid rgba(255,26,94,0.22)`,
  },
  error: {
    padding: "8px 16px", borderRadius: 6,
    background: "rgba(255,26,94,0.08)", color: C.PINK,
    border: `1px solid rgba(255,26,94,0.25)`, fontSize: 12,
  },
  puGrid: {
    display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8,
    width: "100%",
  },
  puCard: {
    padding: "10px 6px", borderRadius: 8, border: "1px solid",
    background: "rgba(0,238,255,0.02)",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    textAlign: "center",
  },

  // ── Lobby ─────────────────────────────────────────────────────────────────
  lobby: {
    position: "relative", zIndex: 2,
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 16, maxWidth: 480, width: "100%", textAlign: "center",
  },
  lobbyTitle: {
    fontFamily: "'Orbitron', monospace",
    fontSize: "clamp(14px, 4vw, 22px)",
    fontWeight: 900, letterSpacing: "0.25em", color: C.TEXT,
  },
  countBig: {
    fontFamily: "'Orbitron', monospace",
    fontSize: 80, fontWeight: 900, color: C.AMBER,
    textShadow: `0 0 50px ${C.AMBER}88`, animation: "countPop 0.4s ease",
  },
  tag: {
    fontSize: 9, letterSpacing: "0.6em", color: C.MUTED,
    padding: "4px 14px", borderRadius: 20,
    border: "1px solid rgba(255,255,255,0.06)",
  },
  slotGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, width: "100%" },
  slot: {
    padding: "16px", borderRadius: 10, border: "1px solid",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
  },
  lbCard: {
    width: "100%", padding: "12px 16px", borderRadius: 10,
    background: "rgba(0,238,255,0.02)", border: `1px solid ${C.BORDER}`,
  },
  lbHdr: { fontSize: 8, letterSpacing: "0.5em", color: C.MUTED, marginBottom: 8 },
  lbRow: {
    display: "flex", gap: 10, fontSize: 12, padding: "4px 0",
    borderBottom: `1px solid rgba(255,255,255,0.04)`,
  },

  // ── Game HUD ──────────────────────────────────────────────────────────────
  hud: {
    position: "relative", zIndex: 2,
    display: "flex", alignItems: "flex-start", gap: 8,
    width: "100%", maxWidth: 620,
  },
  hudPlayers: { flex: 1, display: "flex", flexDirection: "column", gap: 6 },
  hudRight: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 },
  chip: {
    display: "flex", alignItems: "flex-start", gap: 8,
    padding: "8px 10px", borderRadius: 9, border: "1px solid",
    backdropFilter: "blur(4px)",
  },
  timerWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 68 },
  timerNum: {
    fontFamily: "'Orbitron', monospace",
    fontSize: 42, fontWeight: 900, lineHeight: 1,
    textShadow: "0 0 20px currentColor", transition: "color 0.5s",
  },
  timerTrack: {
    width: 60, height: 4, borderRadius: 2,
    background: "rgba(255,255,255,0.07)", overflow: "hidden",
  },
  timerFill: { height: "100%", borderRadius: 2, transition: "width 0.9s linear, background 0.5s" },
  iconBtn: {
    background: "transparent", border: "none", cursor: "pointer",
    fontSize: 16, color: C.MUTED, padding: 4, borderRadius: 4,
  },

  // ── Board ─────────────────────────────────────────────────────────────────
  boardWrap: {
    position: "relative", zIndex: 2,
    padding: 3, borderRadius: 16,
    background: `linear-gradient(135deg, ${C.CYAN}33, ${C.PURPLE}33)`,
    boxShadow: `0 0 60px rgba(0,238,255,0.12), 0 20px 60px rgba(0,0,0,0.6)`,
    transformStyle: "preserve-3d",
  },
  boardInner: {
    display: "grid", gap: 5, padding: 8,
    background: "rgba(0,9,30,0.97)", borderRadius: 14,
    boxShadow: "inset 0 0 40px rgba(0,0,0,0.5)",
  },
  cell: {
    width:  "clamp(48px, 10.5vw, 70px)",
    height: "clamp(48px, 10.5vw, 70px)",
    borderRadius: 7, border: "1px solid",
    display: "flex", alignItems: "center", justifyContent: "center",
    position: "relative",
    transition: "background 0.25s, box-shadow 0.25s, border-color 0.25s",
  },

  // ── Entities ──────────────────────────────────────────────────────────────
  enemy: {
    position: "absolute",
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28,
  },
  enemyCore: {
    width: 20, height: 20, borderRadius: "50%",
    background: `radial-gradient(circle at 35% 35%, #ff6688, ${C.PINK})`,
    boxShadow: `0 0 18px ${C.PINK}, 0 0 40px rgba(255,26,94,0.5)`,
    animation: "enemyPulse 0.8s ease-in-out infinite",
    position: "absolute",
  },
  enemyRing: {
    position: "absolute",
    width: 28, height: 28, borderRadius: "50%",
    border: `2px solid ${C.PINK}55`,
    animation: "enemyRingExpand 1.2s ease-out infinite",
  },
  enemyFrozen: {},   // Overrides set inline below
  token: {
    position: "absolute",
    width: 36, height: 36, borderRadius: 8,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 15, fontWeight: 900, zIndex: 2, color: "#000",
    animation: "tokenIdle 3s ease-in-out infinite",
  },
  puToken: {
    position: "absolute",
    width: 28, height: 28, borderRadius: 6,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 14, border: "1px solid", background: "rgba(0,0,0,0.6)",
    animation: "puFloat 2.2s ease-in-out infinite",
  },
  particle: {
    position: "absolute", fontSize: 12, fontWeight: 900,
    pointerEvents: "none",
    animation: "ptRise 0.95s ease-out forwards",
    zIndex: 10, top: 0, textShadow: "0 0 8px currentColor",
    letterSpacing: "0.05em",
  },

  // ── Toasts ────────────────────────────────────────────────────────────────
  toastStack: {
    position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)",
    display: "flex", flexDirection: "column", gap: 5, zIndex: 100, alignItems: "center",
  },
  toast: {
    padding: "6px 18px", borderRadius: 20, border: "1px solid",
    background: "rgba(0,9,30,0.92)", fontSize: 11, letterSpacing: "0.2em",
    fontWeight: 700, animation: "toastSlide 0.25s ease",
    backdropFilter: "blur(10px)", whiteSpace: "nowrap" as const,
  },

  // ── Overlays ──────────────────────────────────────────────────────────────
  overlay: {
    position: "fixed", inset: 0, zIndex: 200,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(0,9,30,0.82)", backdropFilter: "blur(6px)",
  },
  cntNum: {
    fontFamily: "'Orbitron', monospace",
    fontSize: 130, fontWeight: 900, color: C.AMBER,
    textShadow: `0 0 80px ${C.AMBER}77`, animation: "countPop 0.5s ease",
    pointerEvents: "none",
  },
  goInner: {
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 10, textAlign: "center", padding: 28,
    animation: "slideUp 0.4s ease",
    maxHeight: "90vh", overflowY: "auto" as const,
  },
  winner: {
    fontFamily: "'Orbitron', monospace",
    fontSize: "clamp(20px, 6vw, 44px)", fontWeight: 900,
    color: C.CYAN,
    textShadow: `0 0 40px ${C.CYAN}66`, letterSpacing: "0.1em",
    marginBottom: 6,
  },
  scoreGrid: { display: "flex", gap: 28, flexWrap: "wrap" as const, justifyContent: "center" },
  scoreCard: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 },

  // ── Chat ──────────────────────────────────────────────────────────────────
  chat: {
    position: "fixed", bottom: 14, right: 14, width: 264, zIndex: 50,
    background: "rgba(0,9,30,0.96)", borderRadius: 12,
    border: `1px solid ${C.BORDER}`, backdropFilter: "blur(14px)",
    display: "flex", flexDirection: "column",
    animation: "slideUp 0.25s ease",
  },
  chatHdr: {
    padding: "8px 12px", fontSize: 9, letterSpacing: "0.4em", color: C.MUTED,
    borderBottom: `1px solid ${C.BORDER}`,
    display: "flex", justifyContent: "space-between", alignItems: "center",
  },
  chatMsgs: {
    padding: "8px 12px", maxHeight: 190, overflowY: "auto" as const,
    display: "flex", flexDirection: "column", gap: 4,
  },
  chatFoot: {
    display: "flex", gap: 6, padding: "8px 10px",
    borderTop: `1px solid ${C.BORDER}`, alignItems: "center",
  },
  chatIn: {
    flex: 1, padding: "7px 10px",
    background: "rgba(0,238,255,0.04)",
    border: `1px solid rgba(0,238,255,0.1)`,
    borderRadius: 6, color: C.TEXT, fontSize: 11,
    fontFamily: "'Share Tech Mono', monospace", outline: "none",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// INJECT FONTS + KEYFRAMES
// ═══════════════════════════════════════════════════════════════════════════

if (typeof document !== "undefined" && !document.getElementById("nh-v2-styles")) {
  const st = document.createElement("style");
  st.id = "nh-v2-styles";
  st.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Share+Tech+Mono&display=swap');

    @keyframes enemyPulse {
      0%,100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(1.35); opacity: 0.85; }
    }
    @keyframes enemyRingExpand {
      0%   { transform: scale(0.8); opacity: 0.8; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    @keyframes puFloat {
      0%,100% { transform: translateY(0)    rotate(0deg);   }
      50%     { transform: translateY(-6px) rotate(6deg);   }
    }
    @keyframes tokenIdle {
      0%,100% { transform: translateY(0); }
      50%     { transform: translateY(-2px); }
    }
    @keyframes ptRise {
      0%   { opacity: 1;  transform: translateY(0)   scale(1);   }
      100% { opacity: 0;  transform: translateY(-48px) scale(1.4); }
    }
    @keyframes toastSlide {
      from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0);     }
    }
    @keyframes countPop {
      from { transform: scale(1.7); opacity: 0; }
      to   { transform: scale(1);   opacity: 1; }
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0);    }
    }
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      15%     { transform: translateX(-8px) rotate(-0.5deg); }
      30%     { transform: translateX( 8px) rotate( 0.5deg); }
      45%     { transform: translateX(-6px); }
      60%     { transform: translateX( 5px); }
      75%     { transform: translateX(-3px); }
      90%     { transform: translateX( 2px); }
    }
    @keyframes boardGlow {
      0%,100% { box-shadow: 0 0 60px rgba(0,238,255,0.12), 0 20px 60px rgba(0,0,0,0.6); }
      50%     { box-shadow: 0 0 90px rgba(0,238,255,0.22), 0 20px 60px rgba(0,0,0,0.6); }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    input { font-family: 'Share Tech Mono', monospace !important; }
    input::placeholder { color: #2e4060; }
    input:focus {
      border-color: rgba(0,238,255,0.4) !important;
      box-shadow: 0 0 0 3px rgba(0,238,255,0.08) !important;
    }

    button:active { opacity: 0.78; transform: scale(0.96); }

    ::-webkit-scrollbar       { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(0,238,255,0.12); border-radius: 2px; }

    /* Frozen enemy override */
    .enemy-frozen .enemy-core {
      background: radial-gradient(circle at 35% 35%, #aaeeff, #0099cc) !important;
      box-shadow: 0 0 18px #66d9ff, 0 0 40px rgba(0,200,255,0.5) !important;
      animation: none !important;
    }
  `;
  document.head.appendChild(st);
}
