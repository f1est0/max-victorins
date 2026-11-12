const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'custom-packs.json');

const MAX_PACKS_PER_USER = 10;
const MIN_QUESTIONS_PER_PACK = 10;
const MAX_QUESTIONS_PER_PACK = 100;

let packs = {}; // packId -> { id, ownerId, title, questions, createdAt }

function load() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    packs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read custom packs store, starting empty:', e.message);
    packs = {};
  }
}

const SAVE_DEBOUNCE_MS = 2000;
let saveTimer = null;
let dirty = false;

function writeNow() {
  if (!dirty) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(packs, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
  dirty = false;
}

function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeNow();
    } catch (e) {
      console.error('[customPacks] save failed:', e.message);
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
    console.error('[customPacks] flush failed:', e.message);
  }
}

load();

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Проверяет и ограничивает присланный игроком набор: недоверенные данные записываются непосредственно в хранилище.
function validatePack(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Некорректный формат' };
  const title = String(raw.title || '').trim().slice(0, 60);
  if (!title) return { ok: false, error: 'Укажите название пака' };
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return { ok: false, error: 'Нет вопросов' };
  }
  if (raw.questions.length < MIN_QUESTIONS_PER_PACK) {
    return { ok: false, error: `Нужно минимум ${MIN_QUESTIONS_PER_PACK} вопросов в паке` };
  }
  if (raw.questions.length > MAX_QUESTIONS_PER_PACK) {
    return { ok: false, error: `Максимум ${MAX_QUESTIONS_PER_PACK} вопросов в паке` };
  }

  const seenTexts = new Set();
  const questions = [];
  for (let i = 0; i < raw.questions.length; i++) {
    const q = raw.questions[i];
    const num = i + 1;
    const text = String((q && q.text) || '').trim().slice(0, 400);
    if (!text) return { ok: false, error: `Вопрос №${num}: нет текста` };

    if (!q || !Array.isArray(q.options) || q.options.length !== 4) {
      return { ok: false, error: `Вопрос №${num}: нужно ровно 4 варианта ответа` };
    }
    const options = q.options.map((o) => String((o && typeof o === 'object' ? o.text : o) || '').trim().slice(0, 200));
    if (options.some((o) => !o)) {
      return { ok: false, error: `Вопрос №${num}: пустой вариант ответа` };
    }

    const correctIndex = Number(q.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      return { ok: false, error: `Вопрос №${num}: некорректный correctIndex (0-3)` };
    }

    const norm = normalizeText(text);
    if (seenTexts.has(norm)) {
      return { ok: false, error: `Вопрос №${num}: дублирует другой вопрос в этом же паке` };
    }
    seenTexts.add(norm);

    const question = { text, options, correctIndex };
    if (q.explanation) question.explanation = String(q.explanation).trim().slice(0, 400);
    questions.push(question);
  }

  return { ok: true, pack: { title, questions } };
}

function listForUser(ownerId) {
  return Object.values(packs)
    .filter((p) => p.ownerId === String(ownerId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({ id: p.id, title: p.title, count: p.questions.length, createdAt: p.createdAt }));
}

function addPack(ownerId, raw) {
  if (listForUser(ownerId).length >= MAX_PACKS_PER_USER) {
    return { ok: false, error: `Максимум ${MAX_PACKS_PER_USER} своих паков на пользователя` };
  }
  const result = validatePack(raw);
  if (!result.ok) return result;

  const id = `custom_${ownerId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  packs[id] = {
    id,
    ownerId: String(ownerId),
    title: result.pack.title,
    questions: result.pack.questions,
    createdAt: Date.now(),
  };
  save();
  return { ok: true, packId: id };
}

function removePack(ownerId, packId) {
  const p = packs[packId];
  if (!p || p.ownerId !== String(ownerId)) return false;
  delete packs[packId];
  save();
  return true;
}

function get(packId) {
  return packs[packId] || null;
}

function listAll() {
  return Object.values(packs)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => ({ id: p.id, ownerId: p.ownerId, title: p.title, count: p.questions.length, createdAt: p.createdAt }));
}

module.exports = { addPack, removePack, listForUser, get, listAll, flush };
