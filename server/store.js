const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
const DEFAULT_RATING = 1000;
const ABORT_PENALTY = 20;
const BOT_OPPONENT_RATING = 1000; // fixed virtual rating standing in for the bot's difficulty

let users = {}; // maxUserId (string) -> profile

function load() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read user store, starting empty:', e.message);
    users = {};
  }
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Write to a temp file and rename over the original — rename is atomic on
  // POSIX, so a crash mid-write can never leave users.json half-written/corrupt.
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(users, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
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

// Profiles created before the bot leaderboard existed won't have these fields —
// backfill them on the fly so old accounts don't produce NaN ratings.
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

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// score: 1 = win, 0.5 = draw, 0 = loss (from A's perspective)
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

// score: 1 = beat the bot, 0.5 = tied, 0 = lost to the bot
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

function listBotLeaderboard(limit = 50) {
  return Object.values(users)
    // Banned players are kept out of the standings entirely — there's a prize
    // attached to the top places, so a banned cheater must not hold one.
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
  applyEloResult,
  applyAbortPenalty,
  applyBotResult,
  listBotLeaderboard,
  DEFAULT_RATING,
};
