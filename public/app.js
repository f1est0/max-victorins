(function () {
  'use strict';

  const SUPPORT_PROFILE_URL = 'https://max.ru/u/f9LHodD0cOKZMBqCkQNDf8u-l0fg-_Qrqho9o_1VUQxSQReqL5dyAxN0luM';

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
  const ABORTABLE_SCREENS = ['question', 'reveal'];
  const BACK_SCREENS = ['lobby'];
  function showScreen(name) {
    for (const s of screens) {
      $('screen-' + s).classList.toggle('active', s === name);
    }
    $('btn-abort').hidden = !ABORTABLE_SCREENS.includes(name);
    $('btn-back').hidden = !(BACK_SCREENS.includes(name) && !isHost);
    $('btn-close-lobby').hidden = !(name === 'lobby' && isHost);
  }

  // --- Persistent session id, so a reload/reconnect can resume the same game ---
  let sessionId = localStorage.getItem('quiz_session_id');
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('quiz_session_id', sessionId);
  }

  const nameInput = $('name-input');
  if (maxUser && (maxUser.first_name || maxUser.name)) {
    nameInput.value = maxUser.first_name || maxUser.name;
    nameInput.disabled = true;
  } else {
    const saved = localStorage.getItem('quiz_name');
    if (saved) nameInput.value = saved;
  }

  // --- Gate: only playable when opened inside MAX with a verified profile ---
  function showAccessBlocked() {
    $('access-checking').hidden = true;
    $('access-blocked').hidden = false;
    $('play-area').hidden = true;
  }

  function showPlayArea() {
    $('access-checking').hidden = true;
    $('access-blocked').hidden = true;
    $('play-area').hidden = false;
  }

  if (!MaxApp || !MaxApp.initData) {
    showAccessBlocked();
  } else {
    // Waiting on the server to verify the signed initData (see 'auth_result' below).
    setTimeout(() => {
      if ($('access-checking').hidden === false) showAccessBlocked();
    }, 8000);
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
  let lastPlayerCount = 0;

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  ws.addEventListener('open', () => {
    send({ type: 'hello', sessionId });
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
    $('connection-error').hidden = false;
    $('connection-error').textContent = 'Соединение потеряно. Обновите страницу.';
  });

  let packsData = { standalone: [], categories: [], overallCount: 0, maxQuestions: 30, defaultCount: 10 };

  function loadPacks() {
    fetch('/api/packs')
      .then((r) => r.json())
      .then((data) => {
        packsData = data;
        const sel = $('topic-select');
        sel.innerHTML = '';

        const allOpt = document.createElement('option');
        allOpt.value = 'all:all';
        allOpt.textContent = `Все темы (${data.overallCount})`;
        sel.appendChild(allOpt);

        for (const p of data.standalone) {
          const opt = document.createElement('option');
          opt.value = `pack:${p.id}`;
          opt.textContent = `${p.title} (${p.count})`;
          sel.appendChild(opt);
        }
        for (const c of data.categories) {
          const opt = document.createElement('option');
          opt.value = `category:${c.id}`;
          opt.textContent = `${c.title} (${c.totalCount})`;
          sel.appendChild(opt);
        }
        $('count-input').max = data.maxQuestions;
        onTopicChanged();
      });
  }

  function findCategory(id) {
    return packsData.categories.find((c) => c.id === id);
  }

  function onTopicChanged() {
    const [kind, id] = $('topic-select').value.split(':');
    if (kind === 'category') {
      const cat = findCategory(id);
      $('subtopic-wrap').hidden = false;
      const sub = $('subtopic-select');
      sub.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'ALL';
      allOpt.textContent = `Все темы раздела (из ${cat ? cat.totalCount : 0})`;
      sub.appendChild(allOpt);
      for (const t of cat ? cat.topics : []) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.title} (${t.count})`;
        sub.appendChild(opt);
      }
    } else {
      $('subtopic-wrap').hidden = true;
    }
    updateCountBounds();
  }

  function availableQuestionCount() {
    const [kind, id] = $('topic-select').value.split(':');
    if (kind === 'all') return packsData.overallCount;
    if (kind === 'category') {
      const cat = findCategory(id);
      if (!cat) return 0;
      const subVal = $('subtopic-select').value;
      if (subVal === 'ALL') return cat.totalCount;
      const t = cat.topics.find((t) => t.id === subVal);
      return t ? t.count : 0;
    }
    const p = packsData.standalone.find((p) => p.id === id);
    return p ? p.count : 0;
  }

  function updateCountBounds() {
    const max = Math.max(1, availableQuestionCount());
    const input = $('count-input');
    input.max = max;
    input.min = 1;
    if (!input.value || Number(input.value) > max) {
      input.value = Math.min(packsData.defaultCount || 10, max);
    }
  }

  function buildSelection() {
    const [kind, id] = $('topic-select').value.split(':');
    const max = Math.max(1, availableQuestionCount());
    const count = Math.min(max, Math.max(1, Number($('count-input').value) || 1));
    if (kind === 'all') return { kind: 'all', count };
    if (kind === 'category') {
      const subVal = $('subtopic-select').value;
      if (subVal === 'ALL') return { kind: 'category', categoryId: id, count };
      return { kind: 'pack', packId: subVal, count };
    }
    return { kind: 'pack', packId: id, count };
  }

  $('topic-select').addEventListener('change', onTopicChanged);
  $('subtopic-select').addEventListener('change', updateCountBounds);

  $('count-input').addEventListener('change', () => {
    const max = Math.max(1, availableQuestionCount());
    const input = $('count-input');
    const v = Number(input.value);
    if (!v || v < 1) input.value = 1;
    else if (v > max) input.value = max;
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'resumed':
        isHost = msg.isHost;
        roomCode = msg.code;
        gameMode = msg.mode || 'multiplayer';
        if (msg.state === 'lobby') {
          $('lobby-code').textContent = roomCode;
          $('lobby-topic').textContent = `Тема: ${msg.packTitle} · вопросов: ${msg.questionCount}`;
          renderPlayers(msg.players);
          showScreen('lobby');
        } else if (msg.state === 'question' && msg.current) {
          renderQuestion(msg.current);
          showScreen('question');
        } else if (msg.state === 'finished') {
          renderFinal(msg.leaderboard);
          showScreen('final');
        } else {
          // Reconnected during the brief reveal window between questions —
          // show the leaderboard and wait for the next 'question' broadcast.
          $('reveal-title').textContent = 'Переподключение…';
          $('reveal-answers').innerHTML = '';
          renderLeaderboard('reveal-leaderboard', msg.leaderboard);
          showScreen('reveal');
        }
        break;

      case 'auth_result':
        if (!msg.ok) {
          showAccessBlocked();
          break;
        }
        if (msg.name) {
          nameInput.value = msg.name;
          nameInput.disabled = true;
        }
        if (msg.banned) {
          showScreen('banned');
          break;
        }
        showPlayArea();
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
          $('lobby-topic').textContent = `Тема: ${msg.packTitle} · вопросов: ${msg.questionCount}`;
          renderPlayers(msg.players);
          showScreen('lobby');
        }
        break;

      case 'room_update':
        renderPlayers(msg.players);
        break;

      case 'room_closed':
        showScreen('home');
        $('home-error').textContent = msg.reason === 'host_left'
          ? 'Хост закрыл комнату'
          : 'Комната закрыта';
        break;

      case 'error':
        $('home-error').textContent = msg.message;
        $('lobby-error').textContent = msg.message;
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
    updateLobbyControls(players.length);
  }

  function updateLobbyControls(playerCount) {
    lastPlayerCount = playerCount;
    const enoughPlayers = gameMode !== 'multiplayer' || playerCount >= 2;
    $('btn-start').hidden = !(isHost && enoughPlayers);
    $('lobby-wait').hidden = isHost && enoughPlayers;
    $('lobby-wait').textContent = isHost
      ? 'Ждём ещё игроков (нужно минимум 2)…'
      : 'Ожидание хоста…';
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

    const media = $('q-media');
    media.innerHTML = '';
    if (q.image) {
      const img = document.createElement('img');
      img.className = 'q-image';
      img.src = '/media/' + q.image;
      img.alt = '';
      media.appendChild(img);
    }
    if (q.audio) {
      const audio = document.createElement('audio');
      audio.className = 'q-audio';
      audio.src = '/media/' + q.audio;
      audio.controls = true;
      media.appendChild(audio);
    }

    const box = $('q-options');
    box.innerHTML = '';
    q.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'opt-btn';
      if (typeof opt === 'string') {
        btn.textContent = opt;
      } else {
        if (opt.image) {
          const img = document.createElement('img');
          img.className = 'opt-image';
          img.src = '/media/' + opt.image;
          img.alt = '';
          btn.appendChild(img);
        }
        if (opt.text) {
          const span = document.createElement('span');
          span.textContent = opt.text;
          btn.appendChild(span);
        }
      }
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
    send({ type: 'create_room', name, selection: buildSelection(), mode });
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

  function leaveAndReload() {
    // Tell the server this is a deliberate exit, not a dropped connection —
    // otherwise the reconnect logic would resume us right back into the room.
    send({ type: 'leave_room' });
    setTimeout(() => location.reload(), 80);
  }

  function openConfirm(text, confirmLabel) {
    $('confirm-text').textContent = text;
    $('btn-confirm-abort').textContent = confirmLabel;
    $('confirm-modal').hidden = false;
  }

  $('btn-restart').addEventListener('click', leaveAndReload);

  // --- Abort quiz (mid-game) ---
  $('btn-abort').addEventListener('click', () => {
    openConfirm(
      gameMode === 'matchmaking'
        ? 'Вы точно хотите прервать викторину? Рейтинг понизится.'
        : 'Вы точно хотите прервать викторину?',
      'Прервать'
    );
  });

  // --- Close lobby (host only) — closes the room for everyone, so use a confirmation ---
  $('btn-close-lobby').addEventListener('click', () => {
    openConfirm(
      lastPlayerCount > 1
        ? 'Закрыть лобби? Все игроки будут отключены от комнаты.'
        : 'Закрыть лобби?',
      'Закрыть'
    );
  });

  $('btn-confirm-cancel').addEventListener('click', () => {
    $('confirm-modal').hidden = true;
  });

  $('btn-confirm-abort').addEventListener('click', leaveAndReload);

  // --- Leave lobby before the game has started (guest, no confirmation needed) ---
  $('btn-back').addEventListener('click', leaveAndReload);

  // --- Support: open the admin's MAX profile so people can message them ---
  $('btn-support').addEventListener('click', () => {
    try {
      if (MaxApp && typeof MaxApp.openMaxLink === 'function') {
        MaxApp.openMaxLink(SUPPORT_PROFILE_URL);
        return;
      }
    } catch (e) {
      console.warn('openMaxLink failed:', e);
    }
    window.open(SUPPORT_PROFILE_URL, '_blank');
  });

  // --- Copy room code ---
  $('btn-copy-code').addEventListener('click', async () => {
    const btn = $('btn-copy-code');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(roomCode);
      } else {
        const ta = document.createElement('textarea');
        ta.value = roomCode;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      const original = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch (e) {
      console.warn('Copy failed:', e);
    }
  });

  // --- Invite a friend via MAX's native share sheet ---
  $('btn-share').addEventListener('click', () => {
    const text = `Присоединяйся к моей викторине в Max! Код комнаты: ${roomCode}`;
    try {
      if (MaxApp && typeof MaxApp.shareMaxContent === 'function') {
        MaxApp.shareMaxContent({ text, link: location.origin });
        return;
      }
      if (MaxApp && typeof MaxApp.shareContent === 'function') {
        MaxApp.shareContent({ text, link: location.origin });
        return;
      }
    } catch (e) {
      console.warn('Share failed:', e);
    }
    // Outside MAX (plain browser testing) — just copy the invite text instead.
    navigator.clipboard?.writeText(`${text} ${location.origin}`).catch(() => {});
  });
})();
