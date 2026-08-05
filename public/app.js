(function () {
  'use strict';

  const SUPPORT_PROFILE_URL = 'https://max.ru/u/f9LHodD0cOKZMBqCkQNDf8u-l0fg-_Qrqho9o_1VUQxSQReqL5dyAxN0luM';
  const BOT_USERNAME = 'id503303295000_bot';

  // --- MAX Bridge integration (safe no-ops if not running inside MAX) ---
  const MaxApp = window.WebApp || null;
  let maxUser = null;
  let startParam = null;
  try {
    if (MaxApp && typeof MaxApp.ready === 'function') MaxApp.ready();
    maxUser = MaxApp && MaxApp.initDataUnsafe && MaxApp.initDataUnsafe.user;
    startParam = (MaxApp && MaxApp.initDataUnsafe && MaxApp.initDataUnsafe.start_param) || null;
  } catch (e) {
    console.warn('MAX Bridge not available:', e);
  }

  // --- DOM helpers ---
  const $ = (id) => document.getElementById(id);

  // Player names come straight from MAX profiles, i.e. they're user-controlled.
  // Anything interpolated into innerHTML has to go through this first.
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const screens = ['home', 'lobby', 'question', 'reveal', 'final', 'banned', 'admin', 'ratings'];
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
  const avatarImg = $('user-avatar');
  function setAvatar(url) {
    if (!url) return;
    avatarImg.src = url;
    avatarImg.hidden = false;
  }
  if (maxUser && (maxUser.first_name || maxUser.name)) {
    nameInput.value = maxUser.first_name || maxUser.name;
    nameInput.disabled = true;
    setAvatar(maxUser.photo_url);
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
  let resumedIntoRoom = false; // set by 'resumed' — blocks the start_param auto-join from stealing an existing session
  let joinedViaStartParam = false;
  let lastGameRequest = null; // {mode, selection} of the last game started from this screen

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
        resumedIntoRoom = true;
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
          if (msg.answered) restoreAnsweredState(msg.answered);
          showScreen('question');
        } else if (msg.state === 'finished') {
          renderFinal(msg.leaderboard, msg.review, msg.totalQuestions);
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
        setAvatar(msg.photoUrl);
        if (msg.banned) {
          showScreen('banned');
          break;
        }
        showPlayArea();
        if (msg.profile) {
          $('rating-display').hidden = false;
          // Matchmaking rating isn't live yet (always 1000/0), so the bot rating
          // is shown first — it's the one with real numbers behind it right now.
          // A friends-rating line can slot in here the same way once that exists.
          $('rating-display').innerHTML =
            `🤖 Против бота: ${msg.profile.ratingVsBot} · игр: ${msg.profile.botGamesPlayed}<br>` +
            `🏆 Рейтинг: ${msg.profile.rating} · игр: ${msg.profile.gamesPlayed}`;
        }
        if (msg.isAdmin) {
          $('btn-admin').hidden = false;
        }
        // Opened via an invite link (?startapp=CODE) — join that room straight away
        // instead of making them type the code in by hand. MAX keeps re-supplying
        // the same start_param on every reload within this session, so once the
        // player deliberately leaves (leaveAndReload below), remember that and
        // don't auto-rejoin them right back in.
        let declinedStartParam = null;
        try { declinedStartParam = sessionStorage.getItem('declined_start_param'); } catch (e) {}
        if (
          startParam &&
          !joinedViaStartParam &&
          !resumedIntoRoom &&
          startParam !== declinedStartParam &&
          /^[A-Za-z0-9]{5}$/.test(startParam)
        ) {
          joinedViaStartParam = true;
          const name = (nameInput.value || 'Игрок').trim().slice(0, 24);
          send({ type: 'join_room', name, code: startParam.toUpperCase() });
        }
        break;

      case 'admin_users':
        renderAdminUsers(msg.users);
        break;

      case 'bot_leaderboard':
        renderBotLeaderboard(msg.entries);
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
        // Buttons were disabled when this player joined the room — re-enable them,
        // otherwise they're stranded on the home screen unable to start anything.
        setRoomButtonsDisabled(false);
        showRoomClosedNotice(msg.reason === 'host_left'
          ? 'Хост закрыл комнату'
          : 'Комната закрыта');
        break;

      case 'error':
        $('home-error').textContent = msg.message;
        $('lobby-error').textContent = msg.message;
        setRoomButtonsDisabled(false);
        $('btn-play-again').disabled = false;
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
        renderFinal(msg.leaderboard, msg.review, msg.totalQuestions);
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
    $('q-status').textContent = res.correct ? 'Верно!' : 'Неверно';

    const buttons = document.querySelectorAll('#q-options .opt-btn');
    buttons.forEach((b, i) => {
      if (i === res.correctIndex) b.classList.add('correct');
      else if (i === currentOptionIndex) b.classList.add('wrong');
    });
  }

  // Reconnected mid-question having already answered: put the board back the way
  // they left it, so the options aren't clickable again and the result is visible.
  function restoreAnsweredState(answered) {
    currentOptionIndex = answered.optionIndex;
    const buttons = document.querySelectorAll('#q-options .opt-btn');
    buttons.forEach((b) => b.classList.add('disabled'));
    const chosen = buttons[answered.optionIndex];
    if (chosen) chosen.style.outline = '2px solid var(--accent)';
    markOwnAnswer(answered);
  }

  function renderReveal(msg) {
    onQuestionScreen = false;
    clearInterval(timerInterval);
    const buttons = document.querySelectorAll('#q-options .opt-btn');
    buttons.forEach((b, i) => {
      if (i === msg.correctIndex) b.classList.add('correct');
      else if (i === currentOptionIndex) b.classList.add('wrong');
    });

    $('reveal-title').textContent = 'Правильный ответ дали';
    renderRoundAnswers(msg.roundResults || []);
    renderLeaderboard('reveal-leaderboard', msg.leaderboard);

    const revealDeadline = Date.now() + (msg.revealTimeMs || 4000);
    function updateRevealCountdown() {
      const left = Math.max(0, revealDeadline - Date.now());
      const secs = Math.ceil(left / 1000);
      if (msg.isLastQuestion) {
        $('reveal-wait').textContent = secs > 0
          ? `Результаты игры через ${secs}с…`
          : 'Результаты игры…';
      } else {
        $('reveal-wait').textContent = secs > 0
          ? `Следующий вопрос через ${secs}с…`
          : 'Следующий вопрос…';
      }
      if (left <= 0) clearInterval(timerInterval);
    }
    updateRevealCountdown();
    timerInterval = setInterval(updateRevealCountdown, 200);
  }

  function renderRoundAnswers(roundResults) {
    const ul = $('reveal-answers');
    ul.innerHTML = '';
    for (const r of roundResults) {
      const li = document.createElement('li');
      li.className = r.correct ? 'answer-row-correct' : 'answer-row-wrong';
      li.innerHTML = `<span>${esc(r.name)}</span>`;
      ul.appendChild(li);
    }
  }

  function renderFinal(leaderboard, review, totalQuestions) {
    onQuestionScreen = false;
    renderLeaderboard('final-leaderboard', leaderboard);

    const winnerEl = $('final-winner');
    if (!leaderboard.length) {
      winnerEl.textContent = '';
    } else if (leaderboard.length > 1 && leaderboard[0].score === leaderboard[1].score) {
      const tied = leaderboard.filter((p) => p.score === leaderboard[0].score).map((p) => p.name);
      winnerEl.textContent = `🤝 Ничья: ${tied.join(', ')}`;
    } else {
      winnerEl.textContent = `🏆 Победитель: ${leaderboard[0].name}`;
    }

    renderReview(review, totalQuestions);

    // Replaying only makes sense when you don't need anyone else to show up.
    const canReplay = gameMode !== 'multiplayer' && lastGameRequest !== null;
    $('btn-play-again').hidden = !canReplay;
    $('btn-play-again').disabled = false;
  }

  function renderReview(review, totalQuestions) {
    const block = $('review-block');
    const list = $('review-list');
    list.innerHTML = '';

    if (!Array.isArray(review)) {
      block.hidden = true;
      return;
    }

    block.hidden = false;

    if (review.length === 0) {
      $('review-title').textContent = totalQuestions
        ? `✅ Без ошибок, все ${totalQuestions} верно!`
        : '✅ Без единой ошибки!';
      return;
    }

    $('review-title').textContent = `📝 Разбор ошибок (${review.length})`;
    for (const item of review) {
      const li = document.createElement('li');
      const yours = item.yourAnswer
        ? `<span class="review-yours">${esc(item.yourAnswer)}</span>`
        : '<span class="review-yours">не ответил</span>';
      let html =
        `<div class="review-q">${esc(item.number)}. ${esc(item.text)}</div>` +
        `<div class="review-line">Ваш ответ: ${yours}<br>` +
        `Правильный: <span class="review-right">${esc(item.correctAnswer)}</span></div>`;
      if (item.explanation) {
        html += `<div class="review-explanation">${esc(item.explanation)}</div>`;
      }
      li.innerHTML = html;
      list.appendChild(li);
    }
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
      const scoreBoxes =
        `<span class="score-box">` +
        `<span class="score-correct" title="Верных ответов">${esc(p.score)}</span>` +
        `<span class="score-wrong" title="Неверных ответов">${esc(p.wrong || 0)}</span>` +
        `</span>`;
      li.innerHTML = `<span><span class="rank">${i + 1}.</span>${esc(p.name)}${badges}</span>${scoreBoxes}`;
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
      info.innerHTML = `<span>${esc(displayName)}</span><span class="admin-user-meta">рейтинг ${esc(u.rating)} · игр ${esc(u.gamesPlayed)}</span>`;
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

  function renderBotLeaderboard(entries) {
    const ol = $('bot-leaderboard');
    ol.innerHTML = '';
    $('bot-leaderboard-empty').hidden = entries.length > 0;
    entries.forEach((e, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span><span class="rank">${i + 1}.</span>${esc(e.name)}</span><span>${esc(e.rating)} (${esc(e.wins)}W/${esc(e.draws)}N/${esc(e.losses)}L)</span>`;
      ol.appendChild(li);
    });
  }

  function switchRatingsTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach((c) => { c.hidden = c.id !== `tab-${tab}`; });
    if (tab === 'bot') send({ type: 'get_bot_leaderboard' });
  }

  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchRatingsTab(b.dataset.tab));
  });

  $('btn-ratings').addEventListener('click', () => {
    showScreen('ratings');
    switchRatingsTab('bot');
  });

  $('btn-ratings-back').addEventListener('click', () => showScreen('home'));

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
  // Guards against a fast double-click sending two create/join requests before
  // the first response comes back (which would otherwise leave an orphaned
  // room on the server).
  const roomActionButtons = ['btn-create', 'btn-solo', 'btn-bot', 'btn-join'].map($);
  function setRoomButtonsDisabled(disabled) {
    roomActionButtons.forEach((b) => { b.disabled = disabled; });
  }

  let roomClosedNoticeTimer = null;
  function showRoomClosedNotice(text) {
    $('room-closed-text').textContent = text;
    $('room-closed-notice').hidden = false;
    clearTimeout(roomClosedNoticeTimer);
    roomClosedNoticeTimer = setTimeout(() => {
      $('room-closed-notice').hidden = true;
    }, 6000);
  }

  function createRoom(mode) {
    const name = (nameInput.value || 'Игрок').trim().slice(0, 24);
    const selection = buildSelection();
    lastGameRequest = { mode, selection }; // remembered so "Играть снова" can repeat it
    localStorage.setItem('quiz_name', name);
    $('home-error').textContent = '';
    setRoomButtonsDisabled(true);
    send({ type: 'create_room', name, selection, mode });
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
    setRoomButtonsDisabled(true);
    send({ type: 'join_room', name, code });
  });

  $('btn-start').addEventListener('click', () => {
    send({ type: 'start_game' });
  });

  function leaveAndReload() {
    // Tell the server this is a deliberate exit, not a dropped connection —
    // otherwise the reconnect logic would resume us right back into the room.
    send({ type: 'leave_room' });
    // Also remember we declined this invite link's room, so the start_param
    // auto-join (MAX keeps resupplying it on every reload) doesn't pull us
    // straight back in.
    if (startParam) {
      try { sessionStorage.setItem('declined_start_param', startParam); } catch (e) {}
    }
    setTimeout(() => location.reload(), 80);
  }

  function openConfirm(text, confirmLabel) {
    $('confirm-text').textContent = text;
    $('btn-confirm-abort').textContent = confirmLabel;
    $('confirm-modal').hidden = false;
  }

  $('btn-restart').addEventListener('click', leaveAndReload);

  // Replays the last solo/bot game with the same topic and settings, so you
  // don't have to walk back through the menu to pick everything again.
  // The server vacates the finished room on create_room, no explicit leave needed.
  $('btn-play-again').addEventListener('click', () => {
    if (!lastGameRequest) return;
    $('btn-play-again').disabled = true;
    const name = (nameInput.value || 'Игрок').trim().slice(0, 24);
    send({
      type: 'create_room',
      name,
      selection: lastGameRequest.selection,
      mode: lastGameRequest.mode,
    });
  });

  // --- Abort quiz (mid-game) ---
  $('btn-abort').addEventListener('click', () => {
    openConfirm(
      gameMode === 'bot'
        ? 'Вы точно хотите прервать викторину? Матч будет засчитан как поражение боту.'
        : gameMode === 'matchmaking'
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
    // Deep link with ?startapp= opens the mini-app straight into this room —
    // the code arrives in initDataUnsafe.start_param, no need to type it in.
    const inviteLink = `https://max.ru/${BOT_USERNAME}?startapp=${roomCode}`;
    try {
      if (MaxApp && typeof MaxApp.shareMaxContent === 'function') {
        MaxApp.shareMaxContent({ text, link: inviteLink });
        return;
      }
      if (MaxApp && typeof MaxApp.shareContent === 'function') {
        MaxApp.shareContent({ text, link: inviteLink });
        return;
      }
    } catch (e) {
      console.warn('Share failed:', e);
    }
    // Outside MAX (plain browser testing) — just copy the invite text instead.
    navigator.clipboard?.writeText(`${text} ${inviteLink}`).catch(() => {});
  });
})();
