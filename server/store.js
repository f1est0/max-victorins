const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
const DEFAULT_RATING = 1000;
const ABORT_PENALTY = 20;
const BOT_OPPONENT_RATING = 1000; // условный рейтинг бота, отражающий его сложность

let users = {}; // идентификатор пользователя Max (строка) → профиль

function load() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read user store, starting empty:', e.message);
    users = {};
  }
}

const SAVE_DEBOUNCE_MS = 2000;
let saveTimer = null;
let dirty = false;

function writeNow() {
  if (!dirty) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // В POSIX запись во временный файл и атомарное переименование защищают файл от повреждения при сбое.
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(users, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
  dirty = false;
}

// Отложенная запись не блокирует цикл событий при каждом подключении; при остановке вызывается flush().
function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeNow();
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    writeNow();
  } catch (e) {
    console.error('[store] flush failed:', e.message);
  }
}

load();

function getOrCreate(userInfo) {
  const id = String(userInfo.id);
  let p = users[id];
  if (!p) {
    p = {
      id,
      firstName: userInfo.firstName || '',
      lastName: userInfo.lastName || '',
      username: userInfo.username || '',
      photoUrl: userInfo.photoUrl || '',
      rating: DEFAULT_RATING,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      ratingVsBot: DEFAULT_RATING,
      botGamesPlayed: 0,
      botWins: 0,
      botLosses: 0,
      botDraws: 0,
      banned: false,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    users[id] = p;
  } else {
    p.firstName = userInfo.firstName || p.firstName;
    p.lastName = userInfo.lastName || p.lastName;
    p.username = userInfo.username || p.username;
    p.photoUrl = userInfo.photoUrl || p.photoUrl;
    p.lastSeenAt = Date.now();
    ensureBotFields(p);
  }
  save();
  return p;
}

// Старым профилям добавляются поля рейтинга против бота, чтобы избежать NaN.
function ensureBotFields(p) {
  if (p.ratingVsBot == null) p.ratingVsBot = DEFAULT_RATING;
  if (p.botGamesPlayed == null) p.botGamesPlayed = 0;
  if (p.botWins == null) p.botWins = 0;
  if (p.botLosses == null) p.botLosses = 0;
  if (p.botDraws == null) p.botDraws = 0;
}

function get(id) {
  return users[String(id)] || null;
}

function list() {
  return Object.values(users).sort((a, b) => b.rating - a.rating);
}

function setBanned(id, banned) {
  const p = users[String(id)];
  if (!p) return null;
  p.banned = banned;
  save();
  return p;
}

// Сбрасывает игровую статистику, сохраняя личные данные, бан и пользовательские наборы.
function resetStats(id) {
  const p = users[String(id)];
  if (!p) return null;
  p.rating = DEFAULT_RATING;
  p.gamesPlayed = 0;
  p.wins = 0;
  p.losses = 0;
  p.draws = 0;
  p.ratingVsBot = DEFAULT_RATING;
  p.botGamesPlayed = 0;
  p.botWins = 0;
  p.botLosses = 0;
  p.botDraws = 0;
  p.topicStats = {};
  save();
  return p;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// score: 1 - победа, 0.5 - ничья, 0 - поражение игрока A.
function applyEloResult(idA, idB, scoreA, kFactor = 32) {
  const a = users[String(idA)];
  const b = users[String(idB)];
  if (!a || !b) return;

  const expectedA = expectedScore(a.rating, b.rating);
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;

  a.rating = Math.round(a.rating + kFactor * (scoreA - expectedA));
  b.rating = Math.round(b.rating + kFactor * (scoreB - expectedB));

  if (scoreA === 1) { a.wins += 1; b.losses += 1; }
  else if (scoreA === 0) { a.losses += 1; b.wins += 1; }
  else { a.draws += 1; b.draws += 1; }

  a.gamesPlayed += 1;
  b.gamesPlayed += 1;
  save();
}

function applyAbortPenalty(id) {
  const p = users[String(id)];
  if (!p) return;
  p.rating = Math.max(0, p.rating - ABORT_PENALTY);
  p.gamesPlayed += 1;
  p.losses += 1;
  save();
}

// score: 1 - победа над ботом, 0.5 - ничья, 0 - поражение.
function applyBotResult(id, score, kFactor = 32) {
  const p = users[String(id)];
  if (!p) return;
  ensureBotFields(p);

  const expected = expectedScore(p.ratingVsBot, BOT_OPPONENT_RATING);
  p.ratingVsBot = Math.round(p.ratingVsBot + kFactor * (score - expected));

  if (score === 1) p.botWins += 1;
  else if (score === 0) p.botLosses += 1;
  else p.botDraws += 1;

  p.botGamesPlayed += 1;
  save();
}

// tally: { [packId]: { categoryId, categoryTitle, packTitle, correct, total } }. Статистика собирается в rooms.js только для библиотечных вопросов с метками тем.
function recordTopicStats(id, tally) {
  if (!tally) return;
  const p = users[String(id)];
  if (!p) return;
  if (!p.topicStats) p.topicStats = {};
  for (const [packId, t] of Object.entries(tally)) {
    if (!t || !t.total) continue;
    const existing = p.topicStats[packId] || { correct: 0, total: 0 };
    existing.correct += t.correct;
    existing.total += t.total;
    existing.categoryId = t.categoryId;
    existing.categoryTitle = t.categoryTitle;
    existing.packTitle = t.packTitle;
    p.topicStats[packId] = existing;
  }
  save();
}

// Объединяет статистику по категориям и сортирует их по возрастанию точности.
function getTopicStats(id) {
  const p = users[String(id)];
  if (!p || !p.topicStats) return [];
  const byCategory = new Map();
  for (const [packId, t] of Object.entries(p.topicStats)) {
    if (!t.total) continue;
    if (!byCategory.has(t.categoryId)) {
      byCategory.set(t.categoryId, {
        categoryId: t.categoryId,
        title: t.categoryTitle,
        correct: 0,
        total: 0,
        packs: [],
      });
    }
    const cat = byCategory.get(t.categoryId);
    cat.correct += t.correct;
    cat.total += t.total;
    cat.packs.push({ packId, title: t.packTitle, correct: t.correct, total: t.total });
  }
  return Array.from(byCategory.values())
    .sort((a, b) => a.correct / a.total - b.correct / b.total)
    .map((cat) => ({
      ...cat,
      packs: cat.packs.sort((a, b) => a.correct / a.total - b.correct / b.total),
    }));
}

function listBotLeaderboard(limit = 50) {
  return Object.values(users)
    // Забаненные игроки исключаются из таблицы лидеров.
    .filter((u) => u.botGamesPlayed > 0 && !u.banned)
    .sort((a, b) => b.ratingVsBot - a.ratingVsBot)
    .slice(0, limit)
    .map((u) => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || 'Игрок',
      rating: u.ratingVsBot,
      gamesPlayed: u.botGamesPlayed,
      wins: u.botWins,
      draws: u.botDraws,
      losses: u.botLosses,
    }));
}

module.exports = {
  getOrCreate,
  get,
  list,
  setBanned,
  resetStats,
  applyEloResult,
  applyAbortPenalty,
  applyBotResult,
  listBotLeaderboard,
  recordTopicStats,
  getTopicStats,
  flush,
  DEFAULT_RATING,
};
