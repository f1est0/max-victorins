const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов 0/O/1/I
const QUESTION_TIME_MS = 12000; // времени достаточно для ответа, но недостаточно для поиска
const REVEAL_TIME_MS = 4000;
const FAST_ANSWER_MS = 1200; // более быстрые правильные ответы помечаются как подозрительные
const SUDDEN_DEATH_MS = 5000; // после первого ответа в мультиплеере столько времени остаётся остальным
const ANSWER_CONFIRM_DELAY_MS = 1500; // пауза перед раскрытием ответа, чтобы игрок увидел цвет своего ответа

function optionLabel(opt) {
  if (opt == null) return null;
  if (typeof opt === 'string') return opt;
  return opt.text || '(изображение)';
}

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

// Сложность бота: от 1 до 5; повышение увеличивает точность и скорость ответов.
const BOT_DIFFICULTY = 3;
const BOT_DIFFICULTY_SETTINGS = {
  1: { accuracy: 0.40, minDelayMs: 3000, maxDelayMs: 11000 },
  2: { accuracy: 0.55, minDelayMs: 2500, maxDelayMs: 10000 },
  3: { accuracy: 0.65, minDelayMs: 1500, maxDelayMs: 9000 },
  4: { accuracy: 0.80, minDelayMs: 1000, maxDelayMs: 7000 },
  5: { accuracy: 0.92, minDelayMs: 700, maxDelayMs: 5000 },
};
const { accuracy: BOT_ACCURACY, minDelayMs: BOT_MIN_DELAY_MS, maxDelayMs: BOT_MAX_DELAY_MS } =
  BOT_DIFFICULTY_SETTINGS[BOT_DIFFICULTY] || BOT_DIFFICULTY_SETTINGS[3];

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
    this.firstAnswerReceived = false;
    this.onGameOver = null; // необязательный обработчик (results) => void, задаётся сервером
  }

  addPlayer(id, name, ws, maxUserId, avatarUrl) {
    this.players.set(id, {
      id,
      name,
      ws,
      maxUserId: maxUserId || null,
      avatarUrl: avatarUrl || null,
      score: 0,
      wrong: 0,
      answered: null,
      isBot: false,
      optionMap: null,
      distractions: 0,
      distractedThisQuestion: false,
      fastCorrectCount: 0,
      roundScoreDelta: 0,
      lastAnswerActualIndex: null,
      disconnectTimer: null,
      answerHistory: [], // вопросы с неверным ответом для разбора после игры
      topicTally: {}, // количество верных и всех ответов по наборам для статистики
    });
  }

  addBot() {
    this.players.set(BOT_ID, {
      id: BOT_ID,
      name: BOT_NAME,
      ws: null,
      avatarUrl: '/logo.png',
      score: 0,
      wrong: 0,
      answered: null,
      isBot: true,
      optionMap: null,
      distractions: 0,
      distractedThisQuestion: false,
      fastCorrectCount: 0,
      roundScoreDelta: 0,
      lastAnswerActualIndex: null,
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
      avatarUrl: p.avatarUrl,
      score: p.score,
      wrong: p.wrong,
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

  questionPayloadFor(p, timeLimitMs) {
    const q = this.currentQuestion();
    const order = p.optionMap || shuffledIndices(q.options.length);
    p.optionMap = order;
    return {
      type: 'question',
      index: this.questionIndex,
      total: this.pack.questions.length,
      text: q.text,
      image: q.image || null,
      audio: q.audio || null,
      options: order.map((i) => q.options[i]),
      timeLimitMs,
    };
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
    for (const p of this.players.values()) {
      p.score = 0;
      p.wrong = 0;
      p.answerHistory = [];
      p.topicTally = {};
    }
    this.state = 'question';
    this.broadcast({ type: 'game_started' });
    this.nextQuestion();
  }

  nextQuestion() {
    this.clearTimer();
    this.questionIndex += 1;

    if (this.questionIndex >= this.pack.questions.length) {
      this.state = 'finished';
      // Разбор ошибок отправляется каждому игроку отдельно.
      const finalBoard = this.leaderboard();
      for (const p of this.players.values()) {
        if (p.isBot) continue;
        this.sendTo(p.id, {
          type: 'game_over',
          leaderboard: finalBoard,
          review: p.answerHistory,
          totalQuestions: this.pack.questions.length,
        });
      }
      if (this.onGameOver) {
        this.onGameOver(
          Array.from(this.players.values()).map((p) => ({
            maxUserId: p.maxUserId,
            score: p.score,
            isBot: p.isBot,
            topicTally: p.topicTally,
          }))
        );
      }
      return;
    }

    this.state = 'question';
    this.questionStartedAt = Date.now();
    this.firstAnswerReceived = false;

    for (const p of this.players.values()) {
      p.answered = null;
      p.distractedThisQuestion = false;
      p.roundScoreDelta = 0;
      p.lastAnswerActualIndex = null;
      if (p.isBot) {
        p.optionMap = null;
        continue;
      }
      // Каждый игрок получает свой случайный порядок вариантов ответов.
      p.optionMap = null;
      this.sendTo(p.id, this.questionPayloadFor(p, QUESTION_TIME_MS));
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
    const actualIndex = p.optionMap ? p.optionMap[optionIndex] : optionIndex;
    const correct = actualIndex === q.correctIndex;
    const scoreDelta = correct ? 1 : 0; // одно очко за правильный ответ в нерейтинговой игре

    p.answered = optionIndex;
    p.score += scoreDelta;
    p.roundScoreDelta = scoreDelta;
    p.lastAnswerActualIndex = actualIndex;
    if (correct && elapsed < FAST_ANSWER_MS) p.fastCorrectCount += 1;

    const correctIndexForPlayer = p.optionMap ? p.optionMap.indexOf(q.correctIndex) : q.correctIndex;
    this.sendTo(id, {
      type: 'answer_result',
      correct,
      scoreDelta,
      totalScore: p.score,
      correctIndex: correctIndexForPlayer,
    });

    this.broadcast({ type: 'player_answered', playerId: id });

    if (this.allAnswered()) {
      this.clearTimer();
      this.timer = setTimeout(() => this.revealAnswer(), ANSWER_CONFIRM_DELAY_MS);
      return;
    }

    // После первого ответа в мультиплеере ограничиваем оставшееся время остальных игроков.
    if (this.mode === 'multiplayer' && !p.isBot && !this.firstAnswerReceived) {
      this.firstAnswerReceived = true;
      const remainingOriginal = QUESTION_TIME_MS - elapsed;
      const newRemaining = Math.min(remainingOriginal, SUDDEN_DEATH_MS);
      if (newRemaining < remainingOriginal && newRemaining > 0) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.revealAnswer(), newRemaining);
        for (const pl of this.players.values()) {
          if (pl.answered === null && !pl.isBot) {
            this.sendTo(pl.id, { type: 'time_pressure', remainingMs: newRemaining });
          }
        }
      }
    }
  }

  revealAnswer() {
    if (this.state !== 'question') return;
    this.clearTimer();
    this.state = 'reveal';
    const q = this.currentQuestion();

    // Сначала учитываем ошибки текущего раунда, включая ошибки бота.
    for (const p of this.players.values()) {
      if (p.lastAnswerActualIndex !== q.correctIndex) p.wrong += 1;
    }

    const board = this.leaderboard();
    const roundResults = Array.from(this.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      avatarUrl: p.avatarUrl,
      answerText: p.lastAnswerActualIndex != null ? optionLabel(q.options[p.lastAnswerActualIndex]) : null,
      correct: p.lastAnswerActualIndex === q.correctIndex,
      scoreDelta: p.roundScoreDelta,
      score: p.score,
      wrong: p.wrong,
    }));

    for (const p of this.players.values()) {
      if (p.isBot) continue;

      // В статистику попадают только библиотечные вопросы с метками тем.
      if (q._topicPackId) {
        const t = p.topicTally[q._topicPackId] || (p.topicTally[q._topicPackId] = {
          categoryId: q._topicCategoryId,
          categoryTitle: q._topicCategoryTitle,
          packTitle: q._topicPackTitle,
          correct: 0,
          total: 0,
        });
        t.total += 1;
        if (p.lastAnswerActualIndex === q.correctIndex) t.correct += 1;
      }

      // Сохраняем неверные и пропущенные ответы для разбора после игры.
      if (p.lastAnswerActualIndex !== q.correctIndex) {
        p.answerHistory.push({
          number: this.questionIndex + 1,
          text: q.text,
          yourAnswer: p.lastAnswerActualIndex != null
            ? optionLabel(q.options[p.lastAnswerActualIndex])
            : null,
          correctAnswer: optionLabel(q.options[q.correctIndex]),
          explanation: q.explanation || null,
        });
      }

      const correctIndex = p.optionMap ? p.optionMap.indexOf(q.correctIndex) : q.correctIndex;
      this.sendTo(p.id, {
        type: 'question_end',
        correctIndex,
        leaderboard: board,
        roundResults,
        revealTimeMs: REVEAL_TIME_MS,
        isLastQuestion: this.questionIndex + 1 >= this.pack.questions.length,
      });
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

  findPlayerRoom(clientId) {
    for (const room of this.rooms.values()) {
      const player = room.players.get(clientId);
      if (player && !player.isBot) return { room, player };
    }
    return null;
  }

  delete(code) {
    const room = this.rooms.get(code);
    if (room) room.clearTimer();
    this.rooms.delete(code);
  }
}

module.exports = { RoomManager, QUESTION_TIME_MS, REVEAL_TIME_MS };
