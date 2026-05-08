/**
 * NEON HUNT — Distributed Multiplayer Server v2
 * Fixes: shield check, teleport block scope, quick_match handler,
 *        stale-room cleanup, better validation
 */

const { Server } = require("socket.io");
const { createServer } = require("http");
const crypto = require("crypto");

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  PORT:                   process.env.PORT || 3001,
  BOARD_SIZE:             7,
  GAME_DURATION:          45,
  MAX_PLAYERS_PER_ROOM:   4,
  SPECTATORS_ALLOWED:     true,
  POWERUP_SPAWN_INTERVAL: 6,
  MAX_POWERUPS_ON_BOARD:  4,
  POWERUP_TYPES:          ["freeze", "double", "teleport", "shield", "speed"],
  POWERUP_DURATIONS:      { freeze: 4000, shield: 5000, speed: 5000 },
  STREAK_THRESHOLD:       3,
  STREAK_MULTIPLIER:      1.5,
  CATCH_WINDOW_MS:        5000,
  ENEMY_MOVE_INTERVAL:    1200,
  ENEMY_AI_CHANCE:        0.65,
  RECONNECT_GRACE_MS:     15000,
  PING_INTERVAL:          5000,
  MIN_PLAYERS_TO_START:   1,
  STALE_ROOM_TTL_MS:      2 * 60 * 60 * 1000,  // 2h
  MAX_ROOMS:              200,
  CORS_ORIGIN:            process.env.CORS_ORIGIN || "*",
};

// ─── Player spawn slots ────────────────────────────────────────────────────

const PLAYER_SLOTS = [
  { color: "#00eeff", label: "P1", spawnX: 0, spawnY: 0, icon: "①" },
  { color: "#a855f7", label: "P2", spawnX: 6, spawnY: 6, icon: "②" },
  { color: "#ff9500", label: "P3", spawnX: 6, spawnY: 0, icon: "③" },
  { color: "#ff1a5e", label: "P4", spawnX: 0, spawnY: 6, icon: "④" },
];

// ─── Global state ──────────────────────────────────────────────────────────

/** @type {Map<string, import('./types').Room>} */
const rooms = new Map();

/** socketId → roomId */
const socketToRoom = new Map();

/** reconnectToken → { roomId, slotIndex, name } */
const reconnectData = new Map();

// ─── BFS pathfinding ────────────────────────────────────────────────────────

function bfsNextStep(from, targets, size, blocked) {
  if (!targets.length) return null;
  const key = (x, y) => `${x},${y}`;
  const visited = new Set([key(from.x, from.y)]);
  const queue   = [{ x: from.x, y: from.y, first: null }];
  const dirs    = [{ dx:0,dy:-1 }, { dx:0,dy:1 }, { dx:-1,dy:0 }, { dx:1,dy:0 }];

  while (queue.length) {
    const { x, y, first } = queue.shift();
    for (const { dx, dy } of dirs) {
      const nx = x + dx, ny = y + dy;
      const k  = key(nx, ny);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (visited.has(k)) continue;
      if (blocked.some(b => b.x === nx && b.y === ny)) continue;
      visited.add(k);
      const step = first ?? { x: nx, y: ny };
      if (targets.some(t => t.x === nx && t.y === ny)) return step;
      queue.push({ x: nx, y: ny, first: step });
    }
  }
  return null;
}

// ─── Room factory ────────────────────────────────────────────────────────────

function createRoom(roomId, isPrivate = false) {
  return {
    id: roomId, isPrivate,
    players: {}, spectators: new Set(),
    enemy: { x: 3, y: 3 }, powerUps: [],
    timer: CONFIG.GAME_DURATION, gameOver: false,
    started: false, frozenUntil: 0,
    round: 1, chat: [], leaderboard: {},
    powerUpCounter: 0,
    timerInterval: null, powerUpInterval: null, enemyInterval: null,
    createdAt: Date.now(), lastActivity: Date.now(),
    phase: "lobby", countdownValue: 3,
  };
}

// ─── Room utilities ──────────────────────────────────────────────────────────

function randomPos(occupied = [], size = CONFIG.BOARD_SIZE) {
  let pos, tries = 0;
  do {
    pos = { x: Math.floor(Math.random() * size), y: Math.floor(Math.random() * size) };
  } while (++tries < 120 && occupied.some(o => o.x === pos.x && o.y === pos.y));
  return pos;
}

function randomEnemyPos(room) {
  return randomPos([
    ...Object.values(room.players).map(({ x, y }) => ({ x, y })),
    ...room.powerUps.map(({ x, y }) => ({ x, y })),
  ]);
}

function spawnPowerUp(room) {
  if (room.powerUps.length >= CONFIG.MAX_POWERUPS_ON_BOARD) return;
  const type = CONFIG.POWERUP_TYPES[Math.floor(Math.random() * CONFIG.POWERUP_TYPES.length)];
  const occupied = [
    ...Object.values(room.players).map(({ x, y }) => ({ x, y })),
    { x: room.enemy.x, y: room.enemy.y },
    ...room.powerUps.map(({ x, y }) => ({ x, y })),
  ];
  const pos = randomPos(occupied);
  room.powerUps.push({ ...pos, type, id: `pu-${++room.powerUpCounter}` });
}

function stopRoomIntervals(room) {
  if (room.timerInterval)   { clearInterval(room.timerInterval);  room.timerInterval  = null; }
  if (room.powerUpInterval) { clearInterval(room.powerUpInterval);room.powerUpInterval= null; }
  if (room.enemyInterval)   { clearInterval(room.enemyInterval);  room.enemyInterval  = null; }
}

function cleanupRoom(room) {
  stopRoomIntervals(room);
  rooms.delete(room.id);
  console.log(`[room] ${room.id} cleaned up`);
}

function getRoomSnapshot(room) {
  return {
    id: room.id, isPrivate: room.isPrivate,
    players: room.players,
    spectatorCount: room.spectators.size,
    enemy: room.enemy, powerUps: room.powerUps,
    timer: room.timer, gameOver: room.gameOver,
    started: room.started, frozenUntil: room.frozenUntil,
    round: room.round,
    chat: room.chat.slice(-20),
    leaderboard: room.leaderboard,
    phase: room.phase, countdownValue: room.countdownValue,
    boardSize: CONFIG.BOARD_SIZE, playerSlots: PLAYER_SLOTS,
  };
}

function broadcastRoom(io, room) {
  room.lastActivity = Date.now();
  io.to(room.id).emit("update", getRoomSnapshot(room));
}

// ─── Enemy AI tick ───────────────────────────────────────────────────────────

function tickEnemyAI(io, room) {
  if (!room.started || room.gameOver) return;
  if (Date.now() < room.frozenUntil)  return;

  const active = Object.values(room.players).filter(p => p.connected);
  if (!active.length) return;

  let next = null;
  if (Math.random() < CONFIG.ENEMY_AI_CHANCE) {
    next = bfsNextStep(
      room.enemy,
      active.map(p => ({ x: p.x, y: p.y })),
      CONFIG.BOARD_SIZE,
      []
    );
  }

  if (!next) {
    const dirs = [
      { x: room.enemy.x,     y: room.enemy.y - 1 },
      { x: room.enemy.x,     y: room.enemy.y + 1 },
      { x: room.enemy.x - 1, y: room.enemy.y     },
      { x: room.enemy.x + 1, y: room.enemy.y     },
    ].filter(p => p.x >= 0 && p.y >= 0 && p.x < CONFIG.BOARD_SIZE && p.y < CONFIG.BOARD_SIZE);
    next = dirs[Math.floor(Math.random() * dirs.length)];
  }

  if (next) { room.enemy.x = next.x; room.enemy.y = next.y; }

  // FIX: properly check shield expiry with Date.now()
  const now = Date.now();
  Object.entries(room.players).forEach(([slotKey, p]) => {
    const hasShield = p.shieldUntil && now < p.shieldUntil;
    if (p.x === room.enemy.x && p.y === room.enemy.y && !hasShield) {
      p.score  = Math.max(0, p.score - 5);
      p.streak = 0;
      room.enemy = randomEnemyPos(room);
      io.to(room.id).emit("event", { type: "enemy_catch", slotKey });
    }
  });

  broadcastRoom(io, room);
}

// ─── Game lifecycle ──────────────────────────────────────────────────────────

function startCountdown(io, room) {
  if (room.phase !== "lobby") return;
  room.phase          = "countdown";
  room.countdownValue = 3;
  broadcastRoom(io, room);

  const cd = setInterval(() => {
    room.countdownValue--;
    if (room.countdownValue <= 0) { clearInterval(cd); launchGame(io, room); }
    else broadcastRoom(io, room);
  }, 1000);
}

function launchGame(io, room) {
  room.started  = true;
  room.phase    = "playing";
  room.gameOver = false;
  broadcastRoom(io, room);

  room.timerInterval = setInterval(() => {
    if (room.timer <= 1) {
      room.timer    = 0;
      room.gameOver = true;
      room.started  = false;
      room.phase    = "gameover";
      stopRoomIntervals(room);
      Object.values(room.players).forEach(p => {
        room.leaderboard[p.name] = (room.leaderboard[p.name] || 0) + p.score;
      });
    } else {
      room.timer--;
    }
    broadcastRoom(io, room);
  }, 1000);

  room.powerUpInterval = setInterval(() => {
    if (!room.gameOver && room.started) { spawnPowerUp(room); broadcastRoom(io, room); }
  }, CONFIG.POWERUP_SPAWN_INTERVAL * 1000);

  room.enemyInterval = setInterval(() => tickEnemyAI(io, room), CONFIG.ENEMY_MOVE_INTERVAL);
}

function resetRoom(room) {
  stopRoomIntervals(room);
  room.round++;
  room.enemy         = randomEnemyPos(room);
  room.powerUps      = [];
  room.timer         = CONFIG.GAME_DURATION;
  room.gameOver      = false;
  room.started       = false;
  room.frozenUntil   = 0;
  room.phase         = "lobby";
  room.countdownValue= 3;

  Object.entries(room.players).forEach(([slotKey, p]) => {
    const slot = PLAYER_SLOTS[parseInt(slotKey)];
    p.x          = slot.spawnX;
    p.y          = slot.spawnY;
    p.score      = 0;
    p.streak     = 0;
    p.lastCatch  = 0;
    p.shieldUntil= 0;
    p.speedUntil = 0;
  });
}

// ─── Movement validation ─────────────────────────────────────────────────────

function validateMove(p, dir) {
  let { x, y } = p;
  if (dir === "up")    y = Math.max(0, y - 1);
  if (dir === "down")  y = Math.min(CONFIG.BOARD_SIZE - 1, y + 1);
  if (dir === "left")  x = Math.max(0, x - 1);
  if (dir === "right") x = Math.min(CONFIG.BOARD_SIZE - 1, x + 1);
  return { x, y };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPlayerRoom(socketId) {
  const roomId = socketToRoom.get(socketId);
  return roomId ? rooms.get(roomId) : null;
}

function getSocketPlayer(socketId, room) {
  return Object.values(room.players).find(p => p.socketId === socketId) ?? null;
}

function sanitizeName(name) {
  return String(name || "Ghost").replace(/[<>&"'`\\]/g, "").slice(0, 16).trim() || "Ghost";
}

function sanitizeChat(text) {
  return String(text || "").replace(/[<>&"'`\\]/g, "").slice(0, 120).trim();
}

function makePlayer(socketId, name, slotIndex, token) {
  const slot = PLAYER_SLOTS[slotIndex];
  return {
    socketId, name: sanitizeName(name),
    x: slot.spawnX, y: slot.spawnY,
    score: 0, streak: 0, lastCatch: 0,
    shieldUntil: 0, speedUntil: 0,
    connected: true, slotIndex,
    reconnectToken: token, ping: 0,
  };
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", CONFIG.CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      rooms: rooms.size,
      connections: io.engine.clientsCount,
      uptime: Math.round(process.uptime()),
      version: "2.0.0",
    }));
    return;
  }

  if (req.url === "/rooms") {
    const list = [];
    for (const [id, room] of rooms) {
      if (!room.isPrivate) {
        list.push({
          id, phase: room.phase, round: room.round,
          players: Object.keys(room.players).length,
          maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  res.writeHead(404); res.end();
});

const io = new Server(httpServer, {
  cors: { origin: CONFIG.CORS_ORIGIN, methods: ["GET","POST"] },
  pingInterval: CONFIG.PING_INTERVAL,
  pingTimeout:  10000,
});

// ─── Connection handler ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Ping ────────────────────────────────────────────────────────────────────
  socket.on("ping_client", (ts) => socket.emit("pong_server", ts));

  // ── Create room ─────────────────────────────────────────────────────────────
  socket.on("create_room", ({ name, isPrivate, reconnectToken }, cb) => {
    if (reconnectToken && reconnectData.has(reconnectToken)) {
      const data = reconnectData.get(reconnectToken);
      const room = rooms.get(data.roomId);
      if (room?.players[data.slotIndex]) return handleReconnect(socket, room, data, reconnectToken, cb);
    }

    if (rooms.size >= CONFIG.MAX_ROOMS) return cb?.({ error: "Server at capacity" });

    const roomId = crypto.randomBytes(3).toString("hex").toUpperCase();
    const room   = createRoom(roomId, isPrivate ?? false);
    const token  = crypto.randomBytes(16).toString("hex");

    room.players[0] = makePlayer(socket.id, name, 0, token);
    rooms.set(roomId, room);
    socketToRoom.set(socket.id, roomId);
    reconnectData.set(token, { roomId, slotIndex: 0, name: sanitizeName(name) });
    socket.join(roomId);

    console.log(`[room] ${roomId} created by ${sanitizeName(name)}`);
    broadcastRoom(io, room);
    cb?.({ roomId, slotIndex: 0, reconnectToken: token, config: CONFIG });
  });

  // ── Join room ────────────────────────────────────────────────────────────────
  socket.on("join_room", ({ roomId, name, reconnectToken, spectate }, cb) => {
    const room = rooms.get(roomId?.toUpperCase?.() ?? roomId);
    if (!room) return cb?.({ error: "Room not found" });

    if (reconnectToken && reconnectData.has(reconnectToken)) {
      const data = reconnectData.get(reconnectToken);
      if (data.roomId === room.id && room.players[data.slotIndex]) {
        return handleReconnect(socket, room, data, reconnectToken, cb);
      }
    }

    const filledSlots = Object.keys(room.players).length;

    // Spectator path
    if (spectate || filledSlots >= CONFIG.MAX_PLAYERS_PER_ROOM) {
      if (!CONFIG.SPECTATORS_ALLOWED) return cb?.({ error: "Room is full" });
      room.spectators.add(socket.id);
      socketToRoom.set(socket.id, room.id);
      socket.join(room.id);
      socket.emit("update", getRoomSnapshot(room));
      return cb?.({ spectating: true });
    }

    // Find free slot
    const taken = new Set(Object.keys(room.players).map(Number));
    let freeSlot = -1;
    for (let i = 0; i < CONFIG.MAX_PLAYERS_PER_ROOM; i++) {
      if (!taken.has(i)) { freeSlot = i; break; }
    }
    if (freeSlot === -1) return cb?.({ error: "Room is full" });

    const token = crypto.randomBytes(16).toString("hex");
    room.players[freeSlot] = makePlayer(socket.id, name, freeSlot, token);
    socketToRoom.set(socket.id, room.id);
    reconnectData.set(token, { roomId: room.id, slotIndex: freeSlot, name: sanitizeName(name) });
    socket.join(room.id);

    console.log(`[room] ${sanitizeName(name)} joined ${room.id} slot ${freeSlot}`);
    broadcastRoom(io, room);
    cb?.({ roomId: room.id, slotIndex: freeSlot, reconnectToken: token, config: CONFIG });
  });

  // ── Quick match ──────────────────────────────────────────────────────────────
  // FIX: was calling socket.emit which sends to client — now handles directly
  socket.on("quick_match", ({ name }, cb) => {
    for (const [, room] of rooms) {
      if (!room.isPrivate && room.phase === "lobby" &&
          Object.keys(room.players).length < CONFIG.MAX_PLAYERS_PER_ROOM) {
        // Directly call the join logic
        const freeSlots = [...Array(CONFIG.MAX_PLAYERS_PER_ROOM).keys()]
          .filter(i => !room.players[i]);
        if (!freeSlots.length) continue;
        const freeSlot = freeSlots[0];
        const token    = crypto.randomBytes(16).toString("hex");
        room.players[freeSlot] = makePlayer(socket.id, name, freeSlot, token);
        socketToRoom.set(socket.id, room.id);
        reconnectData.set(token, { roomId: room.id, slotIndex: freeSlot, name: sanitizeName(name) });
        socket.join(room.id);
        broadcastRoom(io, room);
        return cb?.({ roomId: room.id, slotIndex: freeSlot, reconnectToken: token, config: CONFIG });
      }
    }

    // No open room — create one (directly, not via socket.emit)
    if (rooms.size >= CONFIG.MAX_ROOMS) return cb?.({ error: "Server at capacity" });
    const roomId = crypto.randomBytes(3).toString("hex").toUpperCase();
    const room   = createRoom(roomId, false);
    const token  = crypto.randomBytes(16).toString("hex");
    room.players[0] = makePlayer(socket.id, name, 0, token);
    rooms.set(roomId, room);
    socketToRoom.set(socket.id, roomId);
    reconnectData.set(token, { roomId, slotIndex: 0, name: sanitizeName(name) });
    socket.join(roomId);
    broadcastRoom(io, room);
    cb?.({ roomId, slotIndex: 0, reconnectToken: token, config: CONFIG });
  });

  // ── Start ────────────────────────────────────────────────────────────────────
  socket.on("start", () => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.phase !== "lobby") return;
    if (Object.keys(room.players).length < CONFIG.MIN_PLAYERS_TO_START) return;
    startCountdown(io, room);
  });

  // ── Restart ──────────────────────────────────────────────────────────────────
  socket.on("restart", () => {
    const room = getPlayerRoom(socket.id);
    if (!room || room.phase !== "gameover") return;
    resetRoom(room);
    broadcastRoom(io, room);
  });

  // ── Move ─────────────────────────────────────────────────────────────────────
  socket.on("move", ({ dir, slotIndex }) => {
    const room = getPlayerRoom(socket.id);
    if (!room || !room.started || room.gameOver) return;

    const p = room.players[slotIndex];
    if (!p || p.socketId !== socket.id) return;
    if (!["up","down","left","right"].includes(dir)) return;

    const now = Date.now();
    const hasSpeed = now < (p.speedUntil || 0);
    const minInterval = hasSpeed ? 60 : 100;
    if (now - (p._lastMove || 0) < minInterval) return;
    p._lastMove = now;

    const { x, y } = validateMove(p, dir);
    p.x = x; p.y = y;

    // Power-up pickup
    const puIdx = room.powerUps.findIndex(pu => pu.x === p.x && pu.y === p.y);
    if (puIdx !== -1) {
      const pu = room.powerUps.splice(puIdx, 1)[0];

      // FIX: wrap teleport `const` in block scope to avoid lexical declaration issues
      switch (pu.type) {
        case "freeze": {
          room.frozenUntil = now + CONFIG.POWERUP_DURATIONS.freeze;
          io.to(room.id).emit("event", { type: "powerup_pickup", slotIndex, puType: "freeze" });
          break;
        }
        case "double": {
          p.score += 25;
          io.to(room.id).emit("event", { type: "powerup_pickup", slotIndex, puType: "double" });
          break;
        }
        case "teleport": {
          const occupied = Object.values(room.players)
            .filter((_, i) => Object.keys(room.players)[i] !== String(slotIndex))
            .map(({ x, y }) => ({ x, y }));
          const newPos = randomPos(occupied);
          p.x = newPos.x; p.y = newPos.y;
          io.to(room.id).emit("event", { type: "powerup_pickup", slotIndex, puType: "teleport" });
          break;
        }
        case "shield": {
          p.shieldUntil = now + CONFIG.POWERUP_DURATIONS.shield;
          io.to(room.id).emit("event", { type: "powerup_pickup", slotIndex, puType: "shield" });
          break;
        }
        case "speed": {
          p.speedUntil = now + CONFIG.POWERUP_DURATIONS.speed;
          io.to(room.id).emit("event", { type: "powerup_pickup", slotIndex, puType: "speed" });
          break;
        }
      }
    }

    // Catch enemy
    if (p.x === room.enemy.x && p.y === room.enemy.y) {
      const frozen        = now < room.frozenUntil;
      const timeSinceLast = now - (p.lastCatch || 0);
      p.streak    = timeSinceLast <= CONFIG.CATCH_WINDOW_MS ? (p.streak || 0) + 1 : 1;
      p.lastCatch = now;
      const base  = frozen ? 20 : 10;
      const pts   = p.streak >= CONFIG.STREAK_THRESHOLD
        ? Math.round(base * CONFIG.STREAK_MULTIPLIER)
        : base;
      p.score += pts;

      io.to(room.id).emit("event", {
        type: "catch", slotIndex, points: pts,
        streak: p.streak, frozen, x: p.x, y: p.y,
      });

      if (!frozen) room.enemy = randomEnemyPos(room);
    }

    broadcastRoom(io, room);
  });

  // ── Chat ─────────────────────────────────────────────────────────────────────
  socket.on("chat", ({ message }) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    const p = getSocketPlayer(socket.id, room);
    if (!p) return;
    const msg = {
      name:  p.name,
      color: PLAYER_SLOTS[p.slotIndex]?.color ?? "#fff",
      text:  sanitizeChat(message),
      ts:    Date.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(room.id).emit("chat_msg", msg);
  });

  // ── Pong ─────────────────────────────────────────────────────────────────────
  socket.on("pong_client", (ts) => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;
    const p = getSocketPlayer(socket.id, room);
    if (p) p.ping = Date.now() - ts;
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[-] ${socket.id} (${reason})`);
    const room = getPlayerRoom(socket.id);
    if (!room) return;

    const p = getSocketPlayer(socket.id, room);
    if (p) {
      p.connected = false;
      io.to(room.id).emit("event", { type: "player_disconnect", slotIndex: p.slotIndex, name: p.name });

      setTimeout(() => {
        if (!p.connected) {
          delete room.players[p.slotIndex];
          reconnectData.delete(p.reconnectToken);
          if (Object.keys(room.players).length === 0 && room.spectators.size === 0) {
            cleanupRoom(room);
          } else {
            broadcastRoom(io, room);
          }
        }
      }, CONFIG.RECONNECT_GRACE_MS);
    }

    room.spectators.delete(socket.id);
    socketToRoom.delete(socket.id);
    if (Object.keys(room.players).length > 0 || room.spectators.size > 0) {
      broadcastRoom(io, room);
    }
  });
});

// ─── Reconnect handler ────────────────────────────────────────────────────────

function handleReconnect(socket, room, data, token, cb) {
  const p = room.players[data.slotIndex];
  if (!p) return cb?.({ error: "Slot no longer available" });

  const oldSocketId = p.socketId;
  p.socketId  = socket.id;
  p.connected = true;

  socketToRoom.set(socket.id, room.id);
  socketToRoom.delete(oldSocketId);
  socket.join(room.id);

  console.log(`[reconnect] ${data.name} rejoined ${room.id} slot ${data.slotIndex}`);
  io.to(room.id).emit("event", { type: "player_reconnect", slotIndex: data.slotIndex, name: p.name });
  broadcastRoom(io, room);
  cb?.({ roomId: room.id, slotIndex: data.slotIndex, reconnectToken: token, config: CONFIG, reconnected: true });
}

// ─── Periodic ping broadcast ─────────────────────────────────────────────────

setInterval(() => { io.emit("ping_server", Date.now()); }, CONFIG.PING_INTERVAL);

// ─── Stale room cleanup ───────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [, room] of rooms) {
    const idle      = now - room.lastActivity > CONFIG.STALE_ROOM_TTL_MS;
    const empty     = Object.keys(room.players).length === 0 && room.spectators.size === 0;
    const abandoned = now - room.createdAt > CONFIG.STALE_ROOM_TTL_MS;
    if ((idle && empty) || abandoned) cleanupRoom(room);
  }
}, 60_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully");
  io.emit("server_shutdown", { message: "Server restarting, please reconnect in 10s" });
  for (const [, room] of rooms) stopRoomIntervals(room);
  httpServer.close(() => process.exit(0));
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(CONFIG.PORT, () => {
  console.log(`🚀 NEON HUNT v2 running on :${CONFIG.PORT}`);
  console.log(`   Health : http://localhost:${CONFIG.PORT}/health`);
  console.log(`   Rooms  : http://localhost:${CONFIG.PORT}/rooms`);
});