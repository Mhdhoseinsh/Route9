// Route 9 — online multiplayer relay server
// Replaces Firebase Realtime Database (blocked on Iranian internet) with a
// small self-hosted Socket.io server. It still does not (and realistically
// cannot, without porting the whole rule engine here too) validate full
// game legality — that stays in the browser. What it DOES enforce now:
//   - every player's slot is protected by a private reconnect token, so a
//     disconnected slot can only ever be reclaimed by its real owner, never
//     by a stranger who just knows the room code (see joinRoom). Token
//     comparison uses a constant-time check (tokensMatch) so a mismatched
//     guess can't be told apart from a correct one by response timing.
//   - every relayed message carries the TRUE sender slot (`from`), derived
//     from the socket, never from anything the client claims — the browser
//     side now trusts this over any self-declared "playerId" in a payload,
//     which closes the "forge a message as a different player" class of
//     bug (e.g. forcing a stranger's forfeit in 4-player mode).
//   - messages are numbered per SENDER SLOT (`seq`) so a client that
//     notices a gap in a particular opponent's numbering can ask for a
//     fresh snapshot instead of silently drifting out of sync forever.
//     (Originally this was a single room-wide counter; that meant a
//     client's OWN outgoing messages — never echoed back to itself —
//     silently consumed numbers too, so the very next message it actually
//     received from the opponent almost always looked like a gap. Fixed by
//     numbering per-sender instead.)
//   - `mode` is validated against a fixed whitelist and `maxPlayers` is
//     always DERIVED from that validated mode on the server — never taken
//     as-is from whatever number a client sends. (Previously a client-
//     supplied maxPlayers was used directly as a loop bound in joinRoom;
//     a malicious value there — e.g. a huge number — could hang the whole
//     Node process for every room and every player, since Node is single-
//     threaded. That's closed now: the loop bound can only ever be 2 or 4.)
//   - a per-socket rate limit on gameplay messages (unchanged from before),
//     PLUS a separate, tighter rate limit on createRoom/joinRoom/roomExists,
//     so a script on one connection can't rapid-fire room codes to brute-
//     force its way into someone else's game, or spin up rooms fast enough
//     to matter. A hard cap on total concurrent rooms is a last-resort
//     backstop against the same kind of abuse spread across many
//     connections.
//   - every relayed/cached payload is size-checked before being accepted
//     (payloadSizeOk), so a malformed or malicious client can't stuff an
//     oversized blob into a room broadcast or into the server's checkpoint
//     cache; the Socket.io transport itself is also capped well below its
//     1MB default as a coarser backstop.
//   - room codes and reconnect tokens are both generated with Node's
//     cryptographically-secure RNG (crypto.randomInt / crypto.randomBytes),
//     not Math.random().
//   - the server also caches the latest full board snapshot a client
//     reports (`checkpoint`) so a reconnecting player can be served state
//     directly by the server if the opponent isn't online to answer —
//     previously that case just hung until a manual retry.
//
// CORS: by default this server still accepts a Socket.io connection from
// any origin, exactly like before, so deploying this file changes nothing
// out of the box. Once you know your game's final URL, you can lock this
// down without touching code again: set an ALLOWED_ORIGINS environment
// variable on Render (Settings → Environment) to a comma-separated list of
// the origin(s) that are allowed to talk to this server, e.g.
//   ALLOWED_ORIGINS=https://your-username.github.io
// (multiple values: ALLOWED_ORIGINS=https://a.example,https://b.example).
// Leave it unset to keep today's permissive behavior.

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const allowedOriginsEnv = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const corsOrigin = allowedOriginsEnv.length ? allowedOriginsEnv : '*';

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST']
  },
  // Hard ceiling on any single incoming message. Well above the biggest
  // legitimate payload (a full board-state snapshot), but far below
  // Socket.io's 1MB default — trims how much bandwidth/memory a malicious
  // client can burn per message before payloadSizeOk() below even runs.
  maxHttpBufferSize: 512 * 1024
});

const PORT = process.env.PORT || 3000;

// ---- In-memory room store -------------------------------------------------
// rooms: Map<code, {
//   maxPlayers, mode, createdAt, lastActivity, seqBySlot: { [slot]: number },
//   players: { [slot]: { token, joinedAt, connected, leftAt } },
//   lastCheckpoint: { state, bySlot, t } | null
// }>
const rooms = new Map();

// Last-resort backstop against memory exhaustion if createRoom somehow gets
// called enough times to matter despite the per-socket rate limit below
// (e.g. spread across many connections). Real usage never gets close.
const MAX_ROOMS = 20000;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

// Only these three modes are ever legitimate — anything else falls back to
// '2p'. Keeping this whitelist is what lets maxPlayersForMode() below
// safely replace a client-supplied number as the source of truth for how
// many slots a room has.
const VALID_MODES = ['2p', '4p', 'hunter'];
function normalizeMode(mode) {
  return VALID_MODES.includes(mode) ? mode : '2p';
}
function maxPlayersForMode(mode) {
  return mode === '4p' ? 4 : 2;
}

// Every payload the server relays or caches is capped at this size (in
// bytes). Generous enough for the biggest legitimate message — a full
// board-state snapshot (state-sync/checkpoint) with a long move history —
// while still ruling out someone using this server as a free relay for
// arbitrary large blobs. Anything that can't even be measured (e.g. no
// payload at all) is let through rather than dropped — this check exists
// to catch genuinely oversized blobs, not to second-guess message shapes;
// silently swallowing a legitimate message here would just look like a
// mysterious disconnect/desync to two honest players.
const MAX_PAYLOAD_BYTES = 100 * 1024;
function payloadSizeOk(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_PAYLOAD_BYTES;
  } catch (e) {
    return true;
  }
}

// Constant-time reconnect-token comparison. A plain `===` leaks a tiny,
// in-principle-measurable timing signal about how many leading characters
// matched; crypto.timingSafeEqual avoids that. It requires equal-length
// buffers, so a length mismatch (an obviously-wrong guess) is rejected
// before it — safe, since the token's fixed length isn't itself a secret.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function touch(room) {
  room.lastActivity = Date.now();
}

function presenceSnapshot(room) {
  const out = {};
  for (const slot in room.players) {
    const p = room.players[slot];
    out[slot] = { joinedAt: p.joinedAt, connected: p.connected };
  }
  return out;
}

function broadcastPresence(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to('room:' + code).emit('presence', presenceSnapshot(room));
}

function assignSocketToSlot(socket, code, slot) {
  socket.data.roomCode = code;
  socket.data.slot = slot;
  socket.join('room:' + code);
}

function handleLeave(socket) {
  const code = socket.data.roomCode;
  const slot = socket.data.slot;
  if (!code || slot === null || slot === undefined) return;
  const room = rooms.get(code);
  if (room && room.players[slot]) {
    // BUGFIX (stuck "Disconnected" overlay after a fast refresh+rejoin):
    // a full page refresh doesn't close the old socket instantly — the
    // server can detect that socket's disconnect a moment LATER, after
    // the player has already reloaded and rejoined on a brand-new socket
    // (reclaiming the same slot via their token). If we blindly trusted
    // every 'disconnect' event here, that late/stale event from the OLD
    // socket would stomp connected=false back onto a slot that a NEWER
    // socket already marked connected=true — and since presence is only
    // pushed on change, no further update would ever arrive to correct
    // it. The opponent's disconnect overlay would then sit there for the
    // full 30s grace period and wrongly forfeit a player who actually
    // reconnected in time. Guard against this by only applying the leave
    // if this socket is still the one actually occupying the slot.
    if (room.players[slot].socketId === socket.id) {
      room.players[slot].connected = false;
      room.players[slot].leftAt = Date.now();
      touch(room);
    }
  }
  socket.leave('room:' + code);
  socket.data.roomCode = null;
  socket.data.slot = null;
  if (room) broadcastPresence(code);
}

// Simple per-socket token-bucket so a broken/compromised client can't flood
// a room. Generous enough for normal play (moves/walls/timer-sync) to never
// come close to it.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 5000;
function rateLimitOk(socket) {
  const now = Date.now();
  const times = (socket.data.msgTimes || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (times.length >= RATE_LIMIT_MAX) { socket.data.msgTimes = times; return false; }
  times.push(now);
  socket.data.msgTimes = times;
  return true;
}

// Separate limiter for room-management calls (createRoom/joinRoom/
// roomExists). Real players call these a handful of times per session —
// but on a shaky mobile connection, a player re-tapping "resume" a few
// times, or two people accidentally reloading around the same moment, can
// easily add up to more than that. This budget is set generously so real
// play (including a rocky reconnect) never gets anywhere near it, while
// still making a code-guessing script impractical: even at this limit,
// brute-forcing the ~39 million possible room codes on one connection
// would take years.
const ROOM_OP_LIMIT_MAX = 60;
const ROOM_OP_LIMIT_WINDOW_MS = 10000;
function roomOpLimitOk(socket) {
  const now = Date.now();
  const times = (socket.data.roomOpTimes || []).filter(t => now - t < ROOM_OP_LIMIT_WINDOW_MS);
  if (times.length >= ROOM_OP_LIMIT_MAX) { socket.data.roomOpTimes = times; return false; }
  times.push(now);
  socket.data.roomOpTimes = times;
  return true;
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.slot = null;
  socket.data.msgTimes = [];
  socket.data.roomOpTimes = [];

  socket.on('createRoom', ({ maxPlayers, mode } = {}, ack) => {
    if (!roomOpLimitOk(socket)) { if (ack) ack({ ok: false, error: 'rate-limited' }); return; }
    if (rooms.size >= MAX_ROOMS) { if (ack) ack({ ok: false, error: 'server-busy' }); return; }
    const safeMode = normalizeMode(mode);
    const code = genRoomCode();
    rooms.set(code, {
      maxPlayers: maxPlayersForMode(safeMode),
      // حالت بازی (2p / 4p / hunter) همینجا، لحظه‌ی ساخته‌شدن اتاق توسط
      // میزبان، به‌عنوان تنها منبع معتبر ثبت می‌شود — با اعتبارسنجی در
      // برابر فهرست مجاز (VALID_MODES). maxPlayers دیگر مستقیماً از
      // کلاینت گرفته نمی‌شود؛ همیشه از همین mode معتبرشده مشتق می‌شود
      // (maxPlayersForMode) تا یک عدد دلخواه از سمت کلاینت هرگز به‌عنوان
      // کران حلقه در joinRoom استفاده نشه.
      mode: safeMode,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      // Per-sender-slot message counters — see the seqBySlot comment in the
      // 'roomMessage' handler for why this replaced a single room-wide
      // counter.
      seqBySlot: {},
      players: {},
      lastCheckpoint: null
    });
    if (ack) ack({ ok: true, code });
  });

  socket.on('roomExists', ({ code } = {}, ack) => {
    if (!roomOpLimitOk(socket)) { if (ack) ack({ exists: false, mode: null }); return; }
    const room = rooms.get(String(code || '').slice(0, 20).toUpperCase());
    if (ack) ack({ exists: !!room, mode: room ? room.mode : null });
  });

  socket.on('joinRoom', ({ code, maxPlayers, token } = {}, ack) => {
    if (!roomOpLimitOk(socket)) { if (ack) ack({ ok: false, error: 'rate-limited' }); return; }
    code = String(code || '').slice(0, 20).toUpperCase();
    const room = rooms.get(code);
    if (!room) { if (ack) ack({ ok: false, error: 'not-found' }); return; }
    touch(room);

    // اگه همین سوکت قبلاً یک جا توی همین روم گرفته (مثلاً دابل‌کلیک روی
    // دکمه‌ی اتصال)، همون اسلات قبلی رو برگردون؛ یک اسلات دوم مصرف نکن.
    if (socket.data.roomCode === code && socket.data.slot !== null && socket.data.slot !== undefined) {
      const mine = room.players[socket.data.slot];
      if (mine && mine.connected) { if (ack) ack({ ok: true, slot: socket.data.slot, mode: room.mode, token: mine.token, t: Date.now() }); return; }
    }

    // limit همیشه از room.maxPlayers میاد که خودش موقع createRoom از یک
    // mode معتبرشده مشتق شده — نه از عددی که همین الان کلاینت توی
    // joinRoom می‌فرسته. (پارامتر ورودی maxPlayers صرفاً برای سازگاری با
    // شکل قدیمی پیام نگه داشته شده و در محاسبه‌ی limit نقشی نداره.)
    const limit = room.maxPlayers || maxPlayersForMode(normalizeMode(room.mode));

    // 1) اگه توکنِ اسلاتِ خودشو داره (یعنی داره reconnect می‌کنه، نه اولین
    //    بار وصل می‌شه)، دقیقاً همون اسلاتی که قبلاً داشت بهش برمی‌گرده —
    //    نه اولین جای خالی. این هم جلوی «جای اشتباه گرفتن توی مود ۴نفره
    //    وقتی دو نفر همزمان reconnect می‌کنن» رو می‌گیره و هم جلوی اینکه
    //    یه غریبه که فقط کد روم رو بلده، جای یه بازیکنِ قطع‌شده رو با یه
    //    joinRoom ساده بگیره (چون بدون توکنِ درست، اصلاً به اون اسلات
    //    نمی‌رسه — پایین‌تر می‌بینی). مقایسه‌ی توکن با tokensMatch (نه
    //    ===) انجام می‌شه تا زمان‌بندیِ پاسخ سرنخی از تطبیقِ جزئیِ توکن لو
    //    نده.
    if (token) {
      for (let i = 0; i < limit; i++) {
        const existing = room.players[i];
        if (existing && tokensMatch(existing.token, token)) {
          existing.connected = true;
          existing.leftAt = null;
          // Record which socket now owns this slot so a late 'disconnect'
          // from a stale/old socket (see handleLeave) can't override it.
          existing.socketId = socket.id;
          assignSocketToSlot(socket, code, i);
          if (ack) ack({ ok: true, slot: i, mode: room.mode, token, t: Date.now() });
          broadcastPresence(code);
          return;
        }
      }
      // توکن با هیچ اسلاتی توی این روم جور درنیومد (قدیمی/متعلق به روم
      // دیگه) — می‌ریم سراغ روال عادیِ اسلاتِ تازه.
    }

    // 2) فقط اسلاتی که تا حالا اصلاً کسی نگرفته (نه صرفاً «الان قطعه»)
    //    برای جوین‌شدنِ بدون توکن آزاده. اسلاتِ یک بازیکنِ قطع‌شده، بدون
    //    توکنِ درستش، برای هیچ سوکت دیگه‌ای قابل تصرف نیست.
    let slot = -1;
    for (let i = 0; i < limit; i++) {
      if (!room.players[i]) { slot = i; break; }
    }
    if (slot === -1) { if (ack) ack({ ok: false, error: 'full' }); return; }

    const newToken = crypto.randomBytes(16).toString('hex');
    room.players[slot] = { token: newToken, joinedAt: Date.now(), connected: true, leftAt: null, socketId: socket.id };
    assignSocketToSlot(socket, code, slot);
    if (ack) ack({ ok: true, slot, mode: room.mode, token: newToken, t: Date.now() });
    broadcastPresence(code);
  });

  socket.on('getPresence', (_data, ack) => {
    const code = socket.data.roomCode;
    const room = code ? rooms.get(code) : null;
    if (room) touch(room);
    if (ack) ack({ players: room ? presenceSnapshot(room) : {} });
  });

  socket.on('roomMessage', ({ payload } = {}) => {
    const code = socket.data.roomCode;
    const slot = socket.data.slot;
    if (!code || slot === null || slot === undefined || !rooms.has(code)) return;
    if (!rateLimitOk(socket)) return;
    if (!payloadSizeOk(payload)) return;
    const room = rooms.get(code);
    touch(room);
    // BUGFIX: seq used to be a single room-wide counter shared by every
    // sender. A client's own outgoing messages bump that counter too, but
    // (by design, see socket.to() below) never get relayed back to that
    // same client — so from any one client's point of view, the very next
    // message it actually RECEIVES from the opponent always looks like it
    // "skipped" however many numbers the client itself just consumed by
    // sending. The client-side gap check in app.js treats any such skip as
    // evidence of a dropped message and fires an automatic resync — so in
    // practice this fired on nearly every real exchange (each side sending
    // its own move/profile/timer message was enough to trip it on the
    // other), producing exactly the "reconnecting the board" / "couldn't
    // resync" loop and moves silently failing to apply.
    // Fix: number messages PER SENDER SLOT instead of per room. A client
    // then only compares incoming seq numbers against the last one it saw
    // FROM THAT SAME SLOT — a count that's only ever advanced by messages
    // it actually received, never polluted by its own sends.
    room.seqBySlot = room.seqBySlot || {};
    room.seqBySlot[slot] = (room.seqBySlot[slot] || 0) + 1;
    const mySeq = room.seqBySlot[slot];

    // اگه این پیام یه درخواستِ «request-state» موقعِ reconnect باشه و در
    // حال حاضر هیچ بازیکنِ دیگه‌ای توی روم آنلاین نباشه که جوابش رو بده،
    // به‌جای اینکه پیام تو خلا relay بشه و درخواست‌کننده تا ۹ ثانیه معطل
    // بمونه، سرور خودش آخرین snapshotِ کش‌شده (اگه داشته باشه) رو مستقیم
    // پس می‌ده — دقیقاً همون سناریوی «هر دو بازیکن همزمان ری‌لود کردن».
    if (payload && payload.type === 'request-state') {
      const others = Object.keys(room.players).filter(s => Number(s) !== slot && room.players[s].connected);
      if (others.length === 0 && room.lastCheckpoint) {
        socket.emit('stateFallback', { state: room.lastCheckpoint.state });
        return;
      }
    }

    socket.to('room:' + code).emit('roomMessage', {
      from: slot,
      t: Date.now(),
      seq: mySeq,
      payload
    });
  });

  // Lightweight state checkpoint — sent by whichever device just applied a
  // move/wall/turn change, so the server always has a recent, self-
  // contained snapshot to fall back on (see 'request-state' above).
  socket.on('checkpoint', ({ state } = {}) => {
    const code = socket.data.roomCode;
    const slot = socket.data.slot;
    if (!code || slot === null || slot === undefined || !rooms.has(code) || !state) return;
    if (!payloadSizeOk(state)) return;
    const room = rooms.get(code);
    touch(room);
    room.lastCheckpoint = { state, bySlot: slot, t: Date.now() };
  });

  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

// Simple health check — also handy as an uptime-ping target so free hosts
// (e.g. Render) don't spin the service down after inactivity. Deliberately
// doesn't reveal the number of active rooms (or anything else operational)
// to an anonymous visitor.
app.get('/', (req, res) => {
  res.type('text/plain').send('Route9 game server is running.');
});

// Sweep rooms that have seen no activity (no join/message/checkpoint) for a
// while AND currently have nobody connected. Based on actual inactivity
// instead of just "how long ago was it created", so a long-running match
// (or a room sitting in the lobby while people keep chatting/reconnecting)
// never gets swept out from under a still-live game.
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000; // 3h of pure inactivity
  for (const [code, room] of rooms.entries()) {
    const anyConnected = Object.values(room.players).some(p => p.connected);
    if (anyConnected) continue;
    if ((room.lastActivity || room.createdAt) < cutoff) rooms.delete(code);
  }
}, 30 * 60 * 1000);

// Best-effort keep-alive: on Render's free tier the service spins down
// after ~15 minutes with no *inbound* HTTP traffic, which wipes every
// in-memory room (there's no persistent disk/DB on the free plan to survive
// that). Pinging our own public URL counts as inbound traffic and can delay
// or prevent that spin-down. This only works if RENDER_EXTERNAL_URL (set
// automatically by Render) or SELF_URL is present, and it's a mitigation,
// not a guarantee — platforms can change this behavior at any time. For a
// reliable fix, point an external uptime pinger (UptimeRobot, cron-job.org,
// etc.) at this service's "/" endpoint every 5-10 minutes.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || null;
if (SELF_URL) {
  setInterval(() => {
    try {
      https.get(SELF_URL, (res) => { res.resume(); }).on('error', () => {});
    } catch (e) {}
  }, 4 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log('Route9 game server listening on port ' + PORT);
});
