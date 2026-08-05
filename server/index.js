const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager, QUESTION_TIME_MS } = require('./rooms');
const { verifyInitData } = require('./auth');
const store = require('./store');
const { sendMessage } = require('./botApi');
const { ADMIN_USER_IDS, WEBHOOK_SECRET } = require('./env');

const WELCOME_MESSAGE = `Привет! 👋 Это бот-викторина «Знариум».

Внутри мини-приложение с реалтайм-викторинами:
🎮 Играйте один, против бота (20 вопросов на матч) или с друзьями по коду комнаты
📚 Разные темы и разделы (общие знания, медицина, пожарная тактика, русский язык и другие), выбирайте количество вопросов
🏆 В конце игры результаты и поздравление победителю
📊 Раздел «Рейтинги» на главном экране, там уже есть топ игроков против бота, скоро добавим остальное

Чтобы начать, нажмите «Играть» внизу экрана.`;

function handleBotUpdate(update) {
  console.log('[bot webhook] update_type=', update && update.update_type, 'chat_id=', update && update.chat_id);
  if (!update || !update.chat_id) return;
  if (update.update_type === 'bot_started' || update.update_type === 'bot_added') {
    sendMessage(update.chat_id, WELCOME_MESSAGE);
  }
}

function isAdminId(id) {
  return id != null && ADMIN_USER_IDS.includes(String(id));
}

// Verified players always play under their real MAX name — the client can't
// override it by sending a different `name` in the message. Only unverified
// guests (testing outside MAX, no signed initData) fall back to whatever
// they typed.
function resolveName(profile, fallbackRaw, fallbackDefault) {
  if (profile) {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
    if (fullName) return fullName.slice(0, 24);
  }
  return String(fallbackRaw || fallbackDefault).slice(0, 24);
}

// Fully removes a player right now (no grace period) — used for explicit,
// intentional leaves ("Назад" / confirmed "Прервать"), as opposed to a socket
// just dropping, which gets a reconnect window instead.
function removeFromRoomNow(rooms, room, clientId, profile) {
  // Walking out of a live match counts against you. This has to run before the
  // host branch below: in solo/bot rooms the player IS the host, so an early
  // return there would skip the penalty entirely and let someone farm the
  // leaderboard by quitting every game they're about to lose.
  const gameInProgress = room.state === 'question' || room.state === 'reveal';
  if (gameInProgress && profile) {
    if (room.mode === 'bot') {
      store.applyBotResult(profile.id, 0); // scored as a loss to the bot
    } else if (room.mode === 'matchmaking') {
      store.applyAbortPenalty(profile.id);
    }
  }

  if (room.hostId === clientId) {
    // The host leaving strands everyone else in an unwinnable "waiting for
    // host" state — close the whole room for everyone instead.
    room.clearTimer();
    room.broadcast({ type: 'room_closed', reason: 'host_left' }, clientId);
    rooms.delete(room.code);
    return;
  }

  room.removePlayer(clientId);
  room.broadcast({ type: 'room_update', players: room.playersList() });
  if (room.isEmpty()) {
    rooms.delete(room.code);
  }
}

// The general rating only applies to matchmade games (not yet built), not
// solo/private code-based rooms with friends — those stay purely for fun.
// Bot games get their own separate leaderboard/rating (see below), since
// beating a fixed-difficulty bot means something different from beating a
// real ranked opponent.
function handleGameOver(mode, results) {
  if (mode === 'bot') {
    const human = results.find((r) => !r.isBot);
    const botEntry = results.find((r) => r.isBot);
    if (human && human.maxUserId && botEntry) {
      let score;
      if (human.score > botEntry.score) score = 1;
      else if (human.score < botEntry.score) score = 0;
      else score = 0.5;
      store.applyBotResult(human.maxUserId, score);
    }
    return;
  }

  if (mode !== 'matchmaking') return;
  const ranked = results.filter((r) => !r.isBot && r.maxUserId);
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i];
      const b = ranked[j];
      let scoreA;
      if (a.score > b.score) scoreA = 1;
      else if (a.score < b.score) scoreA = 0;
      else scoreA = 0.5;
      store.applyEloResult(a.maxUserId, b.maxUserId, scoreA);
    }
  }
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const QUESTIONS_DIR = path.join(__dirname, '..', 'questions');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const DEFAULT_QUESTION_COUNT = 10; // used when the client doesn't ask for a specific count
const MAX_QUESTIONS_PER_GAME = 200; // sanity ceiling only — the real limit is however many questions the selection actually has
const BOT_GAME_QUESTION_COUNT = 20; // vs-bot matches always use this many questions from the chosen topic

function loadPacks() {
  const packs = {};
  const categoryMeta = {}; // top-level folder id -> { title }

  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const catId = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!prefix) {
          const metaPath = path.join(fullPath, '_meta.json');
          if (fs.existsSync(metaPath)) {
            categoryMeta[catId] = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          }
        }
        walk(fullPath, catId);
      } else if (entry.name.endsWith('.json') && entry.name !== '_meta.json') {
        const baseName = path.basename(entry.name, '.json');
        const id = prefix ? `${prefix}/${baseName}` : baseName;
        packs[id] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      }
    }
  }

  walk(QUESTIONS_DIR, '');
  return { packs, categoryMeta };
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Builds a one-off pack {title, questions} for a game session from a client
// selection — either a single pack (optionally capped/randomized to `count`
// questions) or a whole category mixed together and randomly sampled.
function buildEffectivePack(selection) {
  if (!selection || typeof selection !== 'object') return null;
  const count = Math.max(1, Math.min(MAX_QUESTIONS_PER_GAME, Number(selection.count) || DEFAULT_QUESTION_COUNT));

  if (selection.kind === 'all') {
    const pool = [];
    for (const pack of Object.values(packs)) pool.push(...pack.questions);
    if (pool.length === 0) return null;
    return {
      title: 'Все темы',
      questions: shuffleArray(pool).slice(0, Math.min(count, pool.length)),
    };
  }

  if (selection.kind === 'category') {
    const catId = String(selection.categoryId || '');
    const pool = [];
    for (const [id, pack] of Object.entries(packs)) {
      if (id.startsWith(`${catId}/`)) pool.push(...pack.questions);
    }
    if (pool.length === 0) return null;
    return {
      title: categoryMeta[catId] ? categoryMeta[catId].title : catId,
      questions: shuffleArray(pool).slice(0, Math.min(count, pool.length)),
    };
  }

  const pack = packs[selection.packId];
  if (!pack) return null;
  return {
    title: pack.title,
    questions: shuffleArray(pack.questions).slice(0, Math.min(count, pack.questions.length)),
  };
}

let { packs, categoryMeta } = loadPacks();
const rooms = new RoomManager();

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && WEBHOOK_SECRET && req.url === `/bot/webhook/${WEBHOOK_SECRET}`) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      try {
        handleBotUpdate(JSON.parse(body));
      } catch (e) {
        console.error('[bot webhook] parse error', e.message);
      }
    });
    return;
  }

  if (req.url === '/api/packs') {
    const standalone = [];
    const categoriesById = new Map();

    for (const [id, pack] of Object.entries(packs)) {
      const slashIndex = id.indexOf('/');
      if (slashIndex === -1) {
        standalone.push({ id, title: pack.title, count: pack.questions.length });
        continue;
      }
      const catId = id.slice(0, slashIndex);
      if (!categoriesById.has(catId)) {
        categoriesById.set(catId, {
          id: catId,
          title: categoryMeta[catId] ? categoryMeta[catId].title : catId,
          topics: [],
        });
      }
      categoriesById.get(catId).topics.push({ id, title: pack.title, count: pack.questions.length });
    }

    const categories = Array.from(categoriesById.values()).map((c) => ({
      ...c,
      totalCount: c.topics.reduce((sum, t) => sum + t.count, 0),
    }));

    const overallCount = Object.values(packs).reduce((sum, p) => sum + p.questions.length, 0);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      standalone,
      categories,
      overallCount,
      maxQuestions: MAX_QUESTIONS_PER_GAME,
      defaultCount: DEFAULT_QUESTION_COUNT,
    }));
  }
  if (req.url === '/healthz') {
    res.writeHead(200);
    return res.end('ok');
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const DISCONNECT_GRACE_MS = 45000; // window to reopen the app / reconnect before we give up the seat

wss.on('connection', (ws) => {
  let clientId = crypto.randomUUID(); // may be replaced by a persistent session id via 'hello'
  let currentRoom = null;
  let authedProfile = null; // set once a valid, verified MAX initData comes in

  // A closed socket doesn't immediately evict the player — it just marks them
  // disconnected and starts a grace timer, so an accidental close / app kill
  // (which fires 'close' well before the user gets a chance to reopen) doesn't
  // instantly cost them their seat. Reconnecting via 'hello' cancels the timer.
  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    const player = currentRoom.players.get(clientId);
    if (!player || player.ws !== ws) {
      // Either already gone, or this connection was superseded by a reconnect.
      currentRoom = null;
      return;
    }

    const room = currentRoom;
    const cid = clientId;
    const profile = authedProfile;
    player.ws = null;

    player.disconnectTimer = setTimeout(() => {
      const stillThere = room.players.get(cid);
      if (!stillThere || stillThere.ws) return; // reconnected in the meantime
      removeFromRoomNow(rooms, room, cid, profile);
    }, DISCONNECT_GRACE_MS);

    currentRoom = null;
  };

  // Explicit, immediate leave (no grace period) — used when a player deliberately
  // exits, or when create_room/join_room needs to vacate a stale room first so a
  // stray double-click can't leave an orphaned room behind.
  const leaveRoomNow = () => {
    if (!currentRoom) return;
    const player = currentRoom.players.get(clientId);
    if (player && player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    removeFromRoomNow(rooms, currentRoom, clientId, authedProfile);
    currentRoom = null;
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId.slice(0, 128) : '';
        if (sid) clientId = sid;

        const found = rooms.findPlayerRoom(clientId);
        if (!found) return;
        const { room, player } = found;
        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
          player.disconnectTimer = null;
        }
        player.ws = ws;
        currentRoom = room;

        const payload = {
          type: 'resumed',
          code: room.code,
          mode: room.mode,
          isHost: room.hostId === clientId,
          state: room.state,
          packTitle: room.pack.title,
          questionCount: room.pack.questions.length,
          players: room.playersList(),
          leaderboard: room.leaderboard(),
        };
        if (room.state === 'question') {
          const remaining = Math.max(0, QUESTION_TIME_MS - (Date.now() - room.questionStartedAt));
          payload.current = room.questionPayloadFor(player, remaining);
        }
        ws.send(JSON.stringify(payload));
        break;
      }

      case 'auth': {
        const result = verifyInitData(msg.initData);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'auth_result', ok: false, reason: result.reason }));
          return;
        }
        authedProfile = store.getOrCreate(result.user);
        ws.send(JSON.stringify({
          type: 'auth_result',
          ok: true,
          banned: authedProfile.banned,
          isAdmin: isAdminId(authedProfile.id),
          name: [authedProfile.firstName, authedProfile.lastName].filter(Boolean).join(' ').trim(),
          photoUrl: authedProfile.photoUrl || null,
          profile: {
            rating: authedProfile.rating,
            gamesPlayed: authedProfile.gamesPlayed,
            wins: authedProfile.wins,
            losses: authedProfile.losses,
            ratingVsBot: authedProfile.ratingVsBot,
            botGamesPlayed: authedProfile.botGamesPlayed,
          },
        }));
        break;
      }

      case 'create_room': {
        if (!authedProfile) {
          ws.send(JSON.stringify({ type: 'error', message: 'Доступно только через приложение Max' }));
          return;
        }
        if (authedProfile.banned) {
          ws.send(JSON.stringify({ type: 'error', message: 'Вы забанены и не можете играть' }));
          return;
        }
        const mode = ['solo', 'bot'].includes(msg.mode) ? msg.mode : 'multiplayer';
        // A bot match is always a fixed-length duel — the question-count field
        // on the home screen only applies to solo/multiplayer.
        const selection = mode === 'bot'
          ? { ...msg.selection, count: BOT_GAME_QUESTION_COUNT }
          : msg.selection;
        const pack = buildEffectivePack(selection);
        if (!pack) {
          ws.send(JSON.stringify({ type: 'error', message: 'Пакет вопросов не найден' }));
          return;
        }
        leaveRoomNow(); // in case this connection was already sitting in another room
        const name = resolveName(authedProfile, msg.name, 'Хост');
        currentRoom = rooms.create(clientId, pack, mode);
        currentRoom.onGameOver = (results) => handleGameOver(mode, results);
        currentRoom.addPlayer(clientId, name, ws, authedProfile ? authedProfile.id : null);
        if (mode === 'bot') currentRoom.addBot();
        ws.send(JSON.stringify({
          type: 'room_created',
          code: currentRoom.code,
          isHost: true,
          mode,
          packTitle: pack.title,
          questionCount: pack.questions.length,
          players: currentRoom.playersList(),
        }));
        if (mode !== 'multiplayer') currentRoom.startGame();
        break;
      }

      case 'join_room': {
        if (!authedProfile) {
          ws.send(JSON.stringify({ type: 'error', message: 'Доступно только через приложение Max' }));
          return;
        }
        if (authedProfile.banned) {
          ws.send(JSON.stringify({ type: 'error', message: 'Вы забанены и не можете играть' }));
          return;
        }
        const room = rooms.get(msg.code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
          return;
        }
        if (room.state !== 'lobby') {
          ws.send(JSON.stringify({ type: 'error', message: 'Игра уже началась' }));
          return;
        }
        const name = resolveName(authedProfile, msg.name, 'Игрок');
        if (room !== currentRoom) leaveRoomNow(); // vacate any other room first; re-joining the same one is a no-op
        currentRoom = room;
        room.addPlayer(clientId, name, ws, authedProfile ? authedProfile.id : null);
        ws.send(JSON.stringify({
          type: 'room_created',
          code: room.code,
          isHost: false,
          mode: room.mode,
          packTitle: room.pack.title,
          questionCount: room.pack.questions.length,
          players: room.playersList(),
        }));
        room.broadcast({ type: 'room_update', players: room.playersList() }, clientId);
        break;
      }

      case 'start_game': {
        if (!currentRoom || currentRoom.hostId !== clientId) return;
        if (currentRoom.mode === 'multiplayer' && currentRoom.players.size < 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Нужно минимум 2 игрока, чтобы начать' }));
          return;
        }
        currentRoom.startGame();
        break;
      }

      case 'answer': {
        if (!currentRoom) return;
        currentRoom.submitAnswer(clientId, msg.optionIndex);
        break;
      }

      case 'distracted': {
        if (!currentRoom) return;
        currentRoom.markDistracted(clientId);
        break;
      }

      case 'leave_room': {
        leaveRoomNow();
        break;
      }

      case 'get_bot_leaderboard': {
        if (!authedProfile) return;
        ws.send(JSON.stringify({ type: 'bot_leaderboard', entries: store.listBotLeaderboard() }));
        break;
      }

      case 'admin_list_users': {
        if (!authedProfile || !isAdminId(authedProfile.id)) return;
        ws.send(JSON.stringify({ type: 'admin_users', users: store.list() }));
        break;
      }

      case 'admin_set_banned': {
        if (!authedProfile || !isAdminId(authedProfile.id)) return;
        const updated = store.setBanned(msg.userId, !!msg.banned);
        if (updated) ws.send(JSON.stringify({ type: 'admin_users', users: store.list() }));
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', leaveCurrentRoom);
  ws.on('error', leaveCurrentRoom);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Quiz server listening on 127.0.0.1:${PORT}`);
});
