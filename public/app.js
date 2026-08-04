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
  const screens = ['home', 'lobby', 'question', 'reveal', 'final'];
  function showScreen(name) {
    for (const s of screens) {
      $('screen-' + s).classList.toggle('active', s === name);
    }
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
  let questionDeadline = 0;
  let timerInterval = null;

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  ws.addEventListener('open', loadPacks);

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
      case 'room_created':
        isHost = msg.isHost;
        roomCode = msg.code;
        $('lobby-code').textContent = roomCode;
        $('btn-start').hidden = !isHost;
        $('lobby-wait').hidden = isHost;
        renderPlayers(msg.players);
        showScreen('lobby');
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

  function renderQuestion(q) {
    currentOptionIndex = null;
    $('q-progress').textContent = `Вопрос ${q.index + 1} из ${q.total}`;
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
  }

  function renderReveal(msg) {
    clearInterval(timerInterval);
    const buttons = document.querySelectorAll('#q-options .opt-btn');
    buttons.forEach((b, i) => {
      if (i === msg.correctIndex) b.classList.add('correct');
      else if (i === currentOptionIndex) b.classList.add('wrong');
    });

    $('reveal-title').textContent = 'Правильный ответ показан';
    renderLeaderboard('reveal-leaderboard', msg.leaderboard);
  }

  function renderFinal(leaderboard) {
    renderLeaderboard('final-leaderboard', leaderboard);
  }

  function renderLeaderboard(elId, leaderboard) {
    const ol = $(elId);
    ol.innerHTML = '';
    leaderboard.forEach((p, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><span class="rank">${i + 1}.</span>${p.name}</span><span>${p.score}</span>`;
      ol.appendChild(li);
    });
  }

  // --- Home screen actions ---
  $('btn-create').addEventListener('click', () => {
    const name = (nameInput.value || 'Хост').trim().slice(0, 24);
    localStorage.setItem('quiz_name', name);
    $('home-error').textContent = '';
    send({ type: 'create_room', name, packId: $('pack-select').value });
  });

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
})();
