(function () {
  'use strict';

  // --- MAX Bridge integration (safe no-ops if not running inside MAX) ---
  const MaxApp = window.WebApp || null;
  let maxUser = null;
  try {
    if (MaxApp && typeof MaxApp.ready === 'function') MaxApp.ready();
    maxUser = MaxApp && MaxApp.initDataUnsafe && MaxApp.initDataUnsafe.user;
  } catch (e) {
    console.warn('MAX Bridge not available:', e);
  }

  // --- DOM helpers ---
  const $ = (id) => document.getElementById(id);
  const screens = ['home', 'lobby', 'question', 'reveal', 'final', 'banned', 'admin'];
  const ABORTABLE_SCREENS = ['lobby', 'question', 'reveal'];
  function showScreen(name) {
    for (const s of screens) {
      $('screen-' + s).classList.toggle('active', s === name);
    }
    $('btn-abort').hidden = !ABORTABLE_SCREENS.includes(name);
  }

  const nameInput = $('name-input');
  if (maxUser && (maxUser.first_name || maxUser.name)) {
    nameInput.value = maxUser.first_name || maxUser.name;
  } else {
    const saved = localStorage.getItem('quiz_name');
    if (saved) nameInput.value = saved;
  }

  // --- WebSocket ---
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');

  let isHost = false;
  let roomCode = null;
  let myId = null;
  let gameMode = 'multiplayer';
  let questionDeadline = 0;
  let timerInterval = null;

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  ws.addEventListener('open', () => {
    loadPacks();
    if (MaxApp && MaxApp.initData) {
      send({ type: 'auth', initData: MaxApp.initData });
    }
  });

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    $('home-error').textContent = 'Соединение потеряно. Обновите страницу.';
  });

  function loadPacks() {
    fetch('/api/packs')
      .then((r) => r.json())
      .then((packs) => {
        const sel = $('pack-select');
        sel.innerHTML = '';
        for (const p of packs) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.title} (${p.count} вопросов)`;
          sel.appendChild(opt);
        }
      });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth_result':
        if (!msg.ok) break;
        if (msg.name) nameInput.value = msg.name;
        if (msg.banned) {
          showScreen('banned');
          break;
        }
        if (msg.profile) {
          $('rating-display').hidden = false;
          $('rating-display').textContent = `Рейтинг: ${msg.profile.rating} · игр сыграно: ${msg.profile.gamesPlayed}`;
        }
        if (msg.isAdmin) {
          $('btn-admin').hidden = false;
        }
        break;

      case 'admin_users':
        renderAdminUsers(msg.users);
        break;

      case 'room_created':
        isHost = msg.isHost;
        roomCode = msg.code;
        gameMode = msg.mode || 'multiplayer';
        if (gameMode === 'multiplayer') {
          $('lobby-code').textContent = roomCode;
          $('btn-start').hidden = !isHost;
          $('lobby-wait').hidden = isHost;
          renderPlayers(msg.players);
          showScreen('lobby');
        }
        break;

      case 'room_update':
        renderPlayers(msg.players);
        break;

      case 'error':
        $('home-error').textContent = msg.message;
        break;

      case 'game_started':
        break;

      case 'question':
        renderQuestion(msg);
        showScreen('question');
        break;

      case 'player_answered':
        break;

      case 'answer_result':
        markOwnAnswer(msg);
        break;

      case 'time_pressure':
        questionDeadline = Date.now() + msg.remainingMs;
        $('q-timer').classList.add('urgent');
        $('q-status').textContent = $('q-status').textContent || 'Соперник ответил! Осталось меньше времени';
        break;

      case 'question_end':
        renderReveal(msg);
        showScreen('reveal');
        break;

      case 'game_over':
        renderFinal(msg.leaderboard);
        showScreen('final');
        break;

      default:
        break;
    }
  }

  function renderPlayers(players) {
    const ul = $('lobby-players');
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.textContent = p.name;
      ul.appendChild(li);
    }
  }

  let currentOptionIndex = null;
  let onQuestionScreen = false;
  let distractionReported = false;

  function renderQuestion(q) {
    currentOptionIndex = null;
    onQuestionScreen = true;
    distractionReported = false;
    $('q-timer').classList.remove('urgent');
    const modeSuffix = gameMode === 'bot' ? ' · против бота' : gameMode === 'solo' ? ' · одиночная' : '';
    $('q-progress').textContent = `Вопрос ${q.index + 1} из ${q.total}${modeSuffix}`;
    $('q-text').textContent = q.text;
    $('q-status').textContent = '';

    const box = $('q-options');
    box.innerHTML = '';
    q.options.forEach((optText, i) => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn';
      btn.textContent = optText;
      btn.addEventListener('click', () => selectOption(i, btn));
      box.appendChild(btn);
    });

    questionDeadline = Date.now() + q.timeLimitMs;
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 200);
    updateTimer();
  }

  function updateTimer() {
    const left = Math.max(0, questionDeadline - Date.now());
    $('q-timer').textContent = Math.ceil(left / 1000) + 'с';
    if (left <= 0) clearInterval(timerInterval);
  }

  function selectOption(index, btn) {
    if (currentOptionIndex !== null) return;
    currentOptionIndex = index;
    document.querySelectorAll('.opt-btn').forEach((b) => b.classList.add('disabled'));
    btn.style.outline = '2px solid var(--accent)';
    send({ type: 'answer', optionIndex: index });
    $('q-status').textContent = 'Ответ отправлен, ждём остальных…';
  }

  function markOwnAnswer(res) {
    $('q-status').textContent = res.correct
      ? `Верно! +${res.scoreDelta} очков`
      : 'Неверно';

    const buttons = document.querySelectorAll('#q-options .opt-btn');
    buttons.forEach((b, i) => {
      if (i === res.correctIndex) b.classList.add('correct');
      else if (i === currentOptionIndex) b.classList.add('wrong');
    });
  }

  function renderReveal(msg) {
    onQuestionScreen = false;
    clearInterval(timerInterval);
    const buttons = document.querySelectorAll('#q-options .opt-btn');
    buttons.forEach((b, i) => {
      if (i === msg.correctIndex) b.classList.add('correct');
      else if (i === currentOptionIndex) b.classList.add('wrong');
    });

    $('reveal-title').textContent = 'Правильный ответ показан';
    renderRoundAnswers(msg.roundResults || []);
    renderLeaderboard('reveal-leaderboard', msg.leaderboard);
  }

  function renderRoundAnswers(roundResults) {
    const ul = $('reveal-answers');
    ul.innerHTML = '';
    for (const r of roundResults) {
      const li = document.createElement('li');
      const answerText = r.answerText || 'не ответил';
      const sign = r.scoreDelta > 0 ? '+' : '';
      li.innerHTML = `<span>${r.name}</span><span class="${r.correct ? 'answer-correct' : 'answer-wrong'}">${answerText} (${sign}${r.scoreDelta})</span>`;
      ul.appendChild(li);
    }
  }

  function renderFinal(leaderboard) {
    onQuestionScreen = false;
    renderLeaderboard('final-leaderboard', leaderboard);
  }

  function renderLeaderboard(elId, leaderboard) {
    const ol = $(elId);
    ol.innerHTML = '';
    leaderboard.forEach((p, i) => {
      const li = document.createElement('li');
      let badges = '';
      if (p.distractions > 0) {
        badges += `<span class="badge" title="Отвлекался во время вопросов">👀${p.distractions}</span>`;
      }
      if (p.fastCorrectCount >= 3) {
        badges += `<span class="badge" title="Много очень быстрых верных ответов">⚡${p.fastCorrectCount}</span>`;
      }
      li.innerHTML = `<span><span class="rank">${i + 1}.</span>${p.name}${badges}</span><span>${p.score}</span>`;
      ol.appendChild(li);
    });
  }

  function renderAdminUsers(users) {
    const ul = $('admin-users');
    ul.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.id;
      const info = document.createElement('div');
      info.className = 'admin-user-info';
      info.innerHTML = `<span>${displayName}</span><span class="admin-user-meta">рейтинг ${u.rating} · игр ${u.gamesPlayed}</span>`;
      const btn = document.createElement('button');
      btn.className = 'ban-btn' + (u.banned ? ' unban' : '');
      btn.textContent = u.banned ? 'Разбанить' : 'Забанить';
      btn.addEventListener('click', () => {
        send({ type: 'admin_set_banned', userId: u.id, banned: !u.banned });
      });
      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  $('btn-admin').addEventListener('click', () => {
    send({ type: 'admin_list_users' });
    showScreen('admin');
  });

  $('btn-admin-back').addEventListener('click', () => showScreen('home'));

  // --- Anti-cheat: flag tab-switching / losing focus while a question is live ---
  function reportDistractionIfNeeded() {
    if (!onQuestionScreen || distractionReported) return;
    if (document.hidden || !document.hasFocus()) {
      distractionReported = true;
      send({ type: 'distracted' });
    }
  }
  document.addEventListener('visibilitychange', reportDistractionIfNeeded);
  window.addEventListener('blur', reportDistractionIfNeeded);

  // --- Home screen actions ---
  function createRoom(mode) {
    const name = (nameInput.value || 'Игрок').trim().slice(0, 24);
    localStorage.setItem('quiz_name', name);
    $('home-error').textContent = '';
    send({ type: 'create_room', name, packId: $('pack-select').value, mode });
  }

  $('btn-create').addEventListener('click', () => createRoom('multiplayer'));
  $('btn-solo').addEventListener('click', () => createRoom('solo'));
  $('btn-bot').addEventListener('click', () => createRoom('bot'));

  $('btn-join').addEventListener('click', () => {
    const name = (nameInput.value || 'Игрок').trim().slice(0, 24);
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 5) {
      $('home-error').textContent = 'Введите 5-значный код комнаты';
      return;
    }
    localStorage.setItem('quiz_name', name);
    $('home-error').textContent = '';
    send({ type: 'join_room', name, code });
  });

  $('btn-start').addEventListener('click', () => {
    send({ type: 'start_game' });
  });

  $('btn-restart').addEventListener('click', () => {
    location.reload();
  });

  // --- Abort quiz ---
  $('btn-abort').addEventListener('click', () => {
    $('confirm-text').textContent = gameMode === 'multiplayer'
      ? 'Вы точно хотите прервать викторину? Рейтинг понизится.'
      : 'Вы точно хотите прервать викторину?';
    $('confirm-modal').hidden = false;
  });

  $('btn-confirm-cancel').addEventListener('click', () => {
    $('confirm-modal').hidden = true;
  });

  $('btn-confirm-abort').addEventListener('click', () => {
    location.reload();
  });
})();
