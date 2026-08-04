const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const QUESTION_TIME_MS = 12000; // short window: enough to know the answer, too tight to google it
const REVEAL_TIME_MS = 4000;
const FAST_ANSWER_MS = 1200; // correct answers faster than this are flagged as suspicious

function generateCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join('');
  } while (existingCodes.has(code));
  return code;
}

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const BOT_ID = 'bot';
const BOT_NAME = 'Бот';
const BOT_ACCURACY = 0.65; // chance the bot answers correctly
const BOT_MIN_DELAY_MS = 1500;
const BOT_MAX_DELAY_MS = 9000;

class Room {
  constructor(code, hostId, pack, mode) {
    this.code = code;
    this.hostId = hostId;
    this.pack = pack; // { title, questions: [...] }
    this.mode = mode || 'multiplayer'; // multiplayer | solo | bot
    this.players = new Map(); // id -> { id, name, ws, score, answered, isBot }
    this.state = 'lobby'; // lobby | question | reveal | finished
    this.questionIndex = -1;
    this.timer = null;
    this.botTimer = null;
    this.questionStartedAt = 0;
  }

  addPlayer(id, name, ws) {
    this.players.set(id, {
      id,
      name,
      ws,
      score: 0,
      answered: null,
      isBot: false,
      optionMap: null,
      distractions: 0,
      distractedThisQuestion: false,
      fastCorrectCount: 0,
    });
  }

  addBot() {
    this.players.set(BOT_ID, {
      id: BOT_ID,
      name: BOT_NAME,
      ws: null,
      score: 0,
      answered: null,
      isBot: true,
      optionMap: null,
      distractions: 0,
      distractedThisQuestion: false,
      fastCorrectCount: 0,
    });
  }

  markDistracted(id) {
    if (this.state !== 'question') return;
    const p = this.players.get(id);
    if (!p || p.distractedThisQuestion) return;
    p.distractedThisQuestion = true;
    p.distractions += 1;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  isEmpty() {
    for (const p of this.players.values()) {
      if (!p.isBot) return false;
    }
    return true;
  }

  playersList() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      distractions: p.distractions,
      fastCorrectCount: p.fastCorrectCount,
    }));
  }

  leaderboard() {
    return this.playersList().sort((a, b) => b.score - a.score);
  }

  currentQuestion() {
    return this.pack.questions[this.questionIndex];
  }

  broadcast(message, exceptId) {
    const data = JSON.stringify(message);
    for (const p of this.players.values()) {
      if (p.id === exceptId || p.isBot) continue;
      if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  sendTo(id, message) {
    const p = this.players.get(id);
    if (p && !p.isBot && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(message));
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  startGame() {
    if (this.state !== 'lobby') return;
    this.questionIndex = -1;
    for (const p of this.players.values()) p.score = 0;
    this.state = 'question';
    this.broadcast({ type: 'game_started' });
    this.nextQuestion();
  }

  nextQuestion() {
    this.clearTimer();
    this.questionIndex += 1;

    if (this.questionIndex >= this.pack.questions.length) {
      this.state = 'finished';
      this.broadcast({ type: 'game_over', leaderboard: this.leaderboard() });
      return;
    }

    this.state = 'question';
    this.questionStartedAt = Date.now();

    const q = this.currentQuestion();

    for (const p of this.players.values()) {
      p.answered = null;
      p.distractedThisQuestion = false;
      if (p.isBot) {
        p.optionMap = null;
        continue;
      }
      // Each player gets their own shuffled option order, so reading
      // someone else's screen (or the answer for a different position) doesn't help.
      const order = shuffledIndices(q.options.length);
      p.optionMap = order;
      this.sendTo(p.id, {
        type: 'question',
        index: this.questionIndex,
        total: this.pack.questions.length,
        text: q.text,
        options: order.map((i) => q.options[i]),
        timeLimitMs: QUESTION_TIME_MS,
      });
    }

    this.timer = setTimeout(() => this.revealAnswer(), QUESTION_TIME_MS);

    if (this.mode === 'bot') this.scheduleBotAnswer();
  }

  scheduleBotAnswer() {
    const q = this.currentQuestion();
    const correct = Math.random() < BOT_ACCURACY;
    const answerIndex = correct
      ? q.correctIndex
      : q.options
          .map((_, i) => i)
          .filter((i) => i !== q.correctIndex)[
            Math.floor(Math.random() * (q.options.length - 1))
          ];

    const delay = Math.min(
      BOT_MIN_DELAY_MS + Math.random() * (BOT_MAX_DELAY_MS - BOT_MIN_DELAY_MS),
      QUESTION_TIME_MS - 500
    );

    this.botTimer = setTimeout(() => {
      if (this.state === 'question') this.submitAnswer(BOT_ID, answerIndex);
    }, delay);
  }

  allAnswered() {
    if (this.players.size === 0) return false;
    for (const p of this.players.values()) {
      if (p.answered === null) return false;
    }
    return true;
  }

  submitAnswer(id, optionIndex) {
    if (this.state !== 'question') return;
    const p = this.players.get(id);
    if (!p || p.answered !== null) return;

    const q = this.currentQuestion();
    const elapsed = Date.now() - this.questionStartedAt;
    const timeLeftRatio = Math.max(0, 1 - elapsed / QUESTION_TIME_MS);
    const actualIndex = p.optionMap ? p.optionMap[optionIndex] : optionIndex;
    const correct = actualIndex === q.correctIndex;
    const scoreDelta = correct ? Math.round(500 + 500 * timeLeftRatio) : 0;

    p.answered = optionIndex;
    p.score += scoreDelta;
    if (correct && elapsed < FAST_ANSWER_MS) p.fastCorrectCount += 1;

    this.sendTo(id, {
      type: 'answer_result',
      correct,
      scoreDelta,
      totalScore: p.score,
    });

    this.broadcast({ type: 'player_answered', playerId: id });

    if (this.allAnswered()) {
      this.clearTimer();
      this.revealAnswer();
    }
  }

  revealAnswer() {
    if (this.state !== 'question') return;
    this.clearTimer();
    this.state = 'reveal';
    const q = this.currentQuestion();
    const board = this.leaderboard();

    for (const p of this.players.values()) {
      if (p.isBot) continue;
      const correctIndex = p.optionMap ? p.optionMap.indexOf(q.correctIndex) : q.correctIndex;
      this.sendTo(p.id, { type: 'question_end', correctIndex, leaderboard: board });
    }

    this.timer = setTimeout(() => this.nextQuestion(), REVEAL_TIME_MS);
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create(hostId, pack, mode) {
    const code = generateCode(new Set(this.rooms.keys()));
    const room = new Room(code, hostId, pack, mode);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  delete(code) {
    const room = this.rooms.get(code);
    if (room) room.clearTimer();
    this.rooms.delete(code);
  }
}

module.exports = { RoomManager, QUESTION_TIME_MS, REVEAL_TIME_MS };
