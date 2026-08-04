const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./rooms');

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

  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    currentRoom.removePlayer(clientId);
    currentRoom.broadcast({ type: 'room_update', players: currentRoom.playersList() });
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
      case 'create_room': {
        const pack = packs[msg.packId];
        if (!pack) {
          ws.send(JSON.stringify({ type: 'error', message: 'Пакет вопросов не найден' }));
          return;
        }
        const mode = ['solo', 'bot'].includes(msg.mode) ? msg.mode : 'multiplayer';
        const name = String(msg.name || 'Хост').slice(0, 24);
        currentRoom = rooms.create(clientId, pack, mode);
        currentRoom.addPlayer(clientId, name, ws);
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
        room.addPlayer(clientId, name, ws);
        ws.send(JSON.stringify({
          type: 'room_created',
          code: room.code,
          isHost: false,
          players: room.playersList(),
        }));
        room.broadcast({ type: 'room_update', players: room.playersList() }, clientId);
        break;
      }

      case 'start_game': {
        if (!currentRoom || currentRoom.hostId !== clientId) return;
        if (currentRoom.players.size < 1) return;
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
