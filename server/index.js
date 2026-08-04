const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./rooms');
const { verifyInitData } = require('./auth');
const store = require('./store');
const { ADMIN_USER_IDS } = require('./env');

function isAdminId(id) {
  return id != null && ADMIN_USER_IDS.includes(String(id));
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
};

function loadPacks() {
  const packs = {};
  for (const file of fs.readdirSync(QUESTIONS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const id = path.basename(file, '.json');
    const data = JSON.parse(fs.readFileSync(path.join(QUESTIONS_DIR, file), 'utf8'));
    packs[id] = data;
  }
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

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  let currentRoom = null;
  let authedProfile = null; // set once a valid, verified MAX initData comes in

  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    const wasInProgress =
      currentRoom.mode === 'matchmaking' &&
      (currentRoom.state === 'question' || currentRoom.state === 'reveal');
    currentRoom.removePlayer(clientId);
    currentRoom.broadcast({ type: 'room_update', players: currentRoom.playersList() });
    if (wasInProgress && authedProfile) {
      store.applyAbortPenalty(authedProfile.id);
    }
    if (currentRoom.isEmpty()) {
      rooms.delete(currentRoom.code);
    }
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
