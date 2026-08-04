const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager, QUESTION_TIME_MS } = require('./rooms');
const { verifyInitData } = require('./auth');
const store = require('./store');
const { ADMIN_USER_IDS } = require('./env');

function isAdminId(id) {
  return id != null && ADMIN_USER_IDS.includes(String(id));
}

// Fully removes a player right now (no grace period) — used for explicit,
// intentional leaves ("Назад" / confirmed "Прервать"), as opposed to a socket
// just dropping, which gets a reconnect window instead.
function removeFromRoomNow(rooms, room, clientId, profile) {
  if (room.hostId === clientId) {
    // The host leaving strands everyone else in an unwinnable "waiting for
    // host" state — close the whole room for everyone instead.
    room.clearTimer();
    room.broadcast({ type: 'room_closed', reason: 'host_left' }, clientId);
    rooms.delete(room.code);
    return;
  }

  const wasInProgress =
    room.mode === 'matchmaking' && (room.state === 'question' || room.state === 'reveal');
  room.removePlayer(clientId);
  room.broadcast({ type: 'room_update', players: room.playersList() });
  if (wasInProgress && profile) {
    store.applyAbortPenalty(profile.id);
  }
  if (room.isEmpty()) {
    rooms.delete(room.code);
  }
}

// Rating only applies to matchmade games (not yet built), not bot/solo/private
// code-based rooms with friends — those stay purely for fun, no ELO on the line.
function handleGameOver(mode, results) {
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

function loadPacks() {
  const packs = {};

  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.json')) {
        const baseName = path.basename(entry.name, '.json');
        const id = prefix ? `${prefix}/${baseName}` : baseName;
        packs[id] = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      }
    }
  }

  walk(QUESTIONS_DIR, '');
  return packs;
}

let packs = loadPacks();
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
  if (req.url === '/api/packs') {
    const list = Object.entries(packs).map(([id, p]) => ({
      id,
      title: p.title,
      count: p.questions.length,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(list));
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
          profile: {
            rating: authedProfile.rating,
            gamesPlayed: authedProfile.gamesPlayed,
            wins: authedProfile.wins,
            losses: authedProfile.losses,
          },
        }));
        break;
      }

      case 'create_room': {
        if (authedProfile && authedProfile.banned) {
          ws.send(JSON.stringify({ type: 'error', message: 'Вы забанены и не можете играть' }));
          return;
        }
        const pack = packs[msg.packId];
        if (!pack) {
          ws.send(JSON.stringify({ type: 'error', message: 'Пакет вопросов не найден' }));
          return;
        }
        const mode = ['solo', 'bot'].includes(msg.mode) ? msg.mode : 'multiplayer';
        const name = String(msg.name || 'Хост').slice(0, 24);
        currentRoom = rooms.create(clientId, pack, mode);
        currentRoom.onGameOver = (results) => handleGameOver(mode, results);
        currentRoom.addPlayer(clientId, name, ws, authedProfile ? authedProfile.id : null);
        if (mode === 'bot') currentRoom.addBot();
        ws.send(JSON.stringify({
          type: 'room_created',
          code: currentRoom.code,
          isHost: true,
          mode,
          players: currentRoom.playersList(),
        }));
        if (mode !== 'multiplayer') currentRoom.startGame();
        break;
      }

      case 'join_room': {
        if (authedProfile && authedProfile.banned) {
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
        const name = String(msg.name || 'Игрок').slice(0, 24);
        currentRoom = room;
        room.addPlayer(clientId, name, ws, authedProfile ? authedProfile.id : null);
        ws.send(JSON.stringify({
          type: 'room_created',
          code: room.code,
          isHost: false,
          mode: room.mode,
          players: room.playersList(),
        }));
        room.broadcast({ type: 'room_update', players: room.playersList() }, clientId);
        break;
      }

      case 'start_game': {
        if (!currentRoom || currentRoom.hostId !== clientId) return;
        if (currentRoom.players.size < 1) return;
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
        if (!currentRoom) return;
        const player = currentRoom.players.get(clientId);
        if (player && player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
          player.disconnectTimer = null;
        }
        removeFromRoomNow(rooms, currentRoom, clientId, authedProfile);
        currentRoom = null;
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
