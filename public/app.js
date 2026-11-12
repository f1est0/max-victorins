(function () {
  'use strict';

  const { botUsername: BOT_USERNAME = '', supportProfileUrl: SUPPORT_PROFILE_URL = '' } = window.QUIZ_CONFIG || {};

  // Интеграция с Max Bridge; вне Max вызовы безопасно пропускаются.
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

  // Вспомогательные функции для работы с DOM.
  const $ = (id) => document.getElementById(id);
  if (BOT_USERNAME) {
    $('bot-link').href = `https://max.ru/${encodeURIComponent(BOT_USERNAME)}`;
    $('bot-link').hidden = false;
  }
  $('btn-support').hidden = !SUPPORT_PROFILE_URL;

  // Имена пользователей Max необходимо экранировать перед вставкой в innerHTML.
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const screens = ['home', 'lobby', 'question', 'reveal', 'final', 'banned', 'admin', 'ratings', 'profile', 'multiplayer', 'pack-upload', 'pack-builder'];
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

  // Постоянный идентификатор сессии позволяет восстановить игру.
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

  // Профиль открывается нажатием на аватар.
  let profileSummary = null; // { name, photoUrl, rating, gamesPlayed, ratingVsBot, botGamesPlayed }
  let myCustomPacks = []; // наборы игрока для создания сетевой комнаты
  avatarImg.addEventListener('click', () => {
    if (!profileSummary) return;
    $('profile-avatar').src = profileSummary.photoUrl || '';
    $('profile-avatar').hidden = !profileSummary.photoUrl;
    $('profile-name').textContent = profileSummary.name || '';
    $('profile-rating').innerHTML =
      `🤖 Против бота: ${esc(profileSummary.ratingVsBot)} · игр: ${esc(profileSummary.botGamesPlayed)}<br>` +
      `🏆 Рейтинг: ${esc(profileSummary.rating)} · игр: ${esc(profileSummary.gamesPlayed)}`;
    $('profile-topics').innerHTML = '';
    $('profile-topics-empty').hidden = true;
    $('custom-pack-error').textContent = '';
    showScreen('profile');
    send({ type: 'get_topic_stats' });
    send({ type: 'get_custom_packs' });
  });
  if (maxUser && (maxUser.first_name || maxUser.name)) {
    nameInput.value = maxUser.first_name || maxUser.name;
    nameInput.disabled = true;
    setAvatar(maxUser.photo_url);
  } else {
    const saved = localStorage.getItem('quiz_name');
    if (saved) nameInput.value = saved;
  }

  // Играть можно только внутри Max с проверенным профилем.
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
    // Ожидаем проверки подписанного initData сервером (см. auth_result).
    setTimeout(() => {
      if ($('access-checking').hidden === false) showAccessBlocked();
    }, 8000);
  }

  // Соединение WebSocket.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');

  let isHost = false;
  let roomCode = null;
  let myId = null;
  let gameMode = 'multiplayer';
  let questionDeadline = 0;
  let timerInterval = null;
  let lastPlayerCount = 0;
  let resumedIntoRoom = false; // устанавливается при resumed и предотвращает автоматический вход по start_param
  let joinedViaStartParam = false;
  let lastGameRequest = null; // {mode, selection} последней игры с этого экрана

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
  // Ответ custom_packs может прийти раньше /api/packs. До загрузки данных не перестраиваем список, чтобы не показать нулевое число вопросов.
  let packsDataLoaded = false;

  function findCategory(id) {
    return packsData.categories.find((c) => c.id === id);
  }

  // Выбор темы и числа вопросов в одиночной и сетевой игре независим; оба списка создаются одной фабрикой.
  function makeSelectionController(ids, opts) {
    opts = opts || {};
    const topicSelect = $(ids.topic);
    const subtopicWrap = $(ids.subtopicWrap);
    const subtopicSelect = $(ids.subtopic);
    const countInput = $(ids.count);

    function populateTopics() {
      topicSelect.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all:all';
      allOpt.textContent = `Все темы (${packsData.overallCount})`;
      topicSelect.appendChild(allOpt);
      for (const p of packsData.standalone) {
        const opt = document.createElement('option');
        opt.value = `pack:${p.id}`;
        opt.textContent = `${p.title} (${p.count})`;
        topicSelect.appendChild(opt);
      }
      for (const c of packsData.categories) {
        const opt = document.createElement('option');
        opt.value = `category:${c.id}`;
        opt.textContent = `${c.title} (${c.totalCount})`;
        topicSelect.appendChild(opt);
      }
      // Пользовательские наборы доступны только при создании сетевой комнаты в разделе «Мои паки».
      if (opts.includeCustom && myCustomPacks.length > 0) {
        const opt = document.createElement('option');
        opt.value = 'customcat:mine';
        opt.textContent = `Мои паки (${myCustomPacks.length})`;
        topicSelect.appendChild(opt);
      }
      countInput.max = packsData.maxQuestions;
      onTopicChanged();
    }

    function onTopicChanged() {
      const [kind, id] = topicSelect.value.split(':');
      if (kind === 'category') {
        const cat = findCategory(id);
        subtopicWrap.hidden = false;
        subtopicSelect.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = 'ALL';
        allOpt.textContent = `Все темы раздела (из ${cat ? cat.totalCount : 0})`;
        subtopicSelect.appendChild(allOpt);
        for (const t of cat ? cat.topics : []) {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = `${t.title} (${t.count})`;
          subtopicSelect.appendChild(opt);
        }
      } else if (kind === 'customcat') {
        subtopicWrap.hidden = false;
        subtopicSelect.innerHTML = '';
        for (const p of myCustomPacks) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.title} (${p.count})`;
          subtopicSelect.appendChild(opt);
        }
      } else {
        subtopicWrap.hidden = true;
      }
      updateCountBounds();
    }

    function availableQuestionCount() {
      const [kind, id] = topicSelect.value.split(':');
      if (kind === 'customcat') {
        const p = myCustomPacks.find((p) => p.id === subtopicSelect.value);
        return p ? p.count : 0;
      }
      if (kind === 'all') return packsData.overallCount;
      if (kind === 'category') {
        const cat = findCategory(id);
        if (!cat) return 0;
        const subVal = subtopicSelect.value;
        if (subVal === 'ALL') return cat.totalCount;
        const t = cat.topics.find((t) => t.id === subVal);
        return t ? t.count : 0;
      }
      const p = packsData.standalone.find((p) => p.id === id);
      return p ? p.count : 0;
    }

    function updateCountBounds() {
      const max = Math.max(1, availableQuestionCount());
      countInput.max = max;
      countInput.min = 1;
      if (!countInput.value || Number(countInput.value) > max) {
        countInput.value = Math.min(packsData.defaultCount || 10, max);
      }
    }

    function buildSelection() {
      const [kind, id] = topicSelect.value.split(':');
      const max = Math.max(1, availableQuestionCount());
      const count = Math.min(max, Math.max(1, Number(countInput.value) || 1));
      if (kind === 'customcat') return { kind: 'custom', customPackId: subtopicSelect.value, count };
      if (kind === 'all') return { kind: 'all', count };
      if (kind === 'category') {
        const subVal = subtopicSelect.value;
        if (subVal === 'ALL') return { kind: 'category', categoryId: id, count };
        return { kind: 'pack', packId: subVal, count };
      }
      return { kind: 'pack', packId: id, count };
    }

    topicSelect.addEventListener('change', onTopicChanged);
    subtopicSelect.addEventListener('change', updateCountBounds);
    countInput.addEventListener('change', () => {
      const max = Math.max(1, availableQuestionCount());
      const v = Number(countInput.value);
      if (!v || v < 1) countInput.value = 1;
      else if (v > max) countInput.value = max;
    });

    return { populateTopics, buildSelection };
  }

  const homeSelection = makeSelectionController({
    topic: 'topic-select', subtopicWrap: 'subtopic-wrap', subtopic: 'subtopic-select', count: 'count-input',
  });
  const mpSelection = makeSelectionController({
    topic: 'mp-topic-select', subtopicWrap: 'mp-subtopic-wrap', subtopic: 'mp-subtopic-select', count: 'mp-count-input',
  }, { includeCustom: true });

  function loadPacks() {
    fetch('/api/packs')
      .then((r) => r.json())
      .then((data) => {
        packsData = data;
        packsDataLoaded = true;
        homeSelection.populateTopics();
        mpSelection.populateTopics();
      });
  }

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
          // При восстановлении между вопросами ждём следующего сообщения question.
          $('reveal-title').textContent = 'Переподключение…';
          $('reveal-answers').innerHTML = '';
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
          // Рейтинг подбора соперников ещё не работает, поэтому первым показывается рейтинг против бота.
          $('rating-display').innerHTML =
            `🤖 Против бота: ${msg.profile.ratingVsBot} · игр: ${msg.profile.botGamesPlayed}<br>` +
            `🏆 Рейтинг: ${msg.profile.rating} · игр: ${msg.profile.gamesPlayed}`;
          profileSummary = {
            name: msg.name,
            photoUrl: msg.photoUrl,
            rating: msg.profile.rating,
            gamesPlayed: msg.profile.gamesPlayed,
            ratingVsBot: msg.profile.ratingVsBot,
            botGamesPlayed: msg.profile.botGamesPlayed,
          };
        }
        if (msg.isAdmin) {
          $('btn-admin').hidden = false;
        }
        send({ type: 'get_custom_packs' }); // заранее загружаем наборы для выбора темы в сетевой игре
        // При открытии по приглашению сразу входим в комнату. После выхода запоминаем отказ, чтобы не подключать игрока снова.
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

      case 'duplicate_report':
        renderDuplicates(msg.groups);
        break;

      case 'bot_leaderboard':
        renderBotLeaderboard(msg.entries);
        break;

      case 'topic_stats':
        renderTopicStats(msg.categories);
        break;

      case 'custom_packs':
        myCustomPacks = msg.packs;
        renderMyPacks(msg.packs);
        if (packsDataLoaded) mpSelection.populateTopics();
        break;

      case 'custom_pack_result': {
        const errorText = msg.ok ? '' : (msg.error || 'Не удалось добавить пак');
        $('custom-pack-error').textContent = errorText;
        $('pb-error').textContent = errorText;
        myCustomPacks = msg.packs;
        renderMyPacks(msg.packs);
        if (packsDataLoaded) mpSelection.populateTopics();
        if (msg.ok) {
          pbResetAll();
          showScreen('profile');
        }
        break;
      }

      case 'admin_custom_packs':
        renderAdminCustomPacks(msg.packs);
        break;

      case 'admin_custom_pack_detail':
        renderAdminCustomPackDetail(msg.pack);
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
        // Повторно включаем кнопки, отключённые при входе в комнату.
        setRoomButtonsDisabled(false);
        showRoomClosedNotice(msg.reason === 'host_left'
          ? 'Хост закрыл комнату'
          : 'Комната закрыта');
        break;

      case 'error':
        $('home-error').textContent = msg.message;
        $('mp-error').textContent = msg.message;
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

  // После переподключения восстанавливаем данный ответ, чтобы нельзя было ответить повторно.
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

    const results = msg.roundResults || [];
    const correctCount = results.filter((r) => r.correct).length;
    $('reveal-title').textContent = `Правильный ответ дали: ${correctCount} из ${results.length}`;
    renderRoundAnswers(results);

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
      li.className = 'answer-square ' + (r.correct ? 'answer-square-correct' : 'answer-square-wrong');
      const avatarHtml = r.avatarUrl
        ? `<img class="answer-square-avatar" src="${esc(r.avatarUrl)}" alt="" />`
        : `<span class="answer-square-avatar answer-square-initial">${esc((r.name || '?').charAt(0).toUpperCase())}</span>`;
      const scoreBoxes =
        `<span class="score-box">` +
        `<span class="score-correct" title="Верных ответов">${esc(r.score)}</span>` +
        `<span class="score-wrong" title="Неверных ответов">${esc(r.wrong || 0)}</span>` +
        `</span>`;
      li.innerHTML = `${avatarHtml}<span class="answer-square-name">${esc(r.name)}</span>${scoreBoxes}`;
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

    // Повтор игры возможен, когда не нужно ждать других игроков.
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
      const avatarHtml = p.avatarUrl
        ? `<img class="rank-avatar" src="${esc(p.avatarUrl)}" alt="" />`
        : `<span class="rank">${i + 1}.</span>`;
      li.innerHTML = `<span>${avatarHtml}${esc(p.name)}${badges}</span>${scoreBoxes}`;
      ol.appendChild(li);
    });
  }

  function renderDuplicates(groups) {
    const ul = $('duplicates-list');
    ul.innerHTML = '';
    $('duplicates-empty').hidden = groups.length > 0;
    for (const group of groups) {
      const li = document.createElement('li');
      const locations = group.map((g) => `${esc(g.packTitle)} #${esc(g.index)}`).join(', ');
      li.innerHTML =
        `<div class="review-q">${esc(group[0].text)}</div>` +
        `<div class="review-line">Найдено в: ${locations}</div>`;
      ul.appendChild(li);
    }
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
      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';

      const btn = document.createElement('button');
      btn.className = 'ban-btn icon-btn' + (u.banned ? ' unban' : '');
      btn.textContent = u.banned ? '✅' : '🚫';
      btn.title = u.banned ? 'Разбанить' : 'Забанить';
      btn.addEventListener('click', () => {
        send({ type: 'admin_set_banned', userId: u.id, banned: !u.banned });
      });

      const resetBtn = document.createElement('button');
      resetBtn.className = 'ban-btn icon-btn';
      resetBtn.textContent = '🔄';
      resetBtn.title = 'Сбросить статистику';
      resetBtn.addEventListener('click', () => {
        openConfirm(
          `Сбросить всю статистику игрока «${displayName}»? Рейтинги и счётчики игр обнулятся, забаненность не изменится.`,
          'Сбросить',
          () => send({ type: 'admin_reset_stats', userId: u.id })
        );
      });

      actions.appendChild(resetBtn);
      actions.appendChild(btn);
      li.appendChild(info);
      li.appendChild(actions);
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

  function renderTopicStats(categories) {
    const container = $('profile-topics');
    container.innerHTML = '';
    $('profile-topics-empty').hidden = categories.length > 0;
    // При открытии категории закрываем предыдущую, чтобы профиль не разрастался.
    let openEntry = null;
    categories.forEach((cat) => {
      const pct = cat.total ? Math.round((cat.correct / cat.total) * 100) : 0;
      const card = document.createElement('div');
      card.className = 'topic-card';

      const row = document.createElement('div');
      row.className = 'topic-row expandable';
      row.innerHTML =
        `<span class="topic-name">${esc(cat.title)}</span>` +
        `<span class="topic-pct">${pct}% верных · ${esc(cat.total)} вопросов</span>` +
        `<span class="topic-caret">▾</span>`;
      card.appendChild(row);

      const sub = document.createElement('ul');
      sub.className = 'topic-subpanel';
      sub.hidden = true;
      cat.packs.forEach((p) => {
        const pPct = p.total ? Math.round((p.correct / p.total) * 100) : 0;
        const li = document.createElement('li');
        li.innerHTML = `<span>${esc(p.title)}</span><span>${pPct}% · ${esc(p.total)}</span>`;
        sub.appendChild(li);
      });
      card.appendChild(sub);
      row.addEventListener('click', () => {
        const opening = sub.hidden;
        if (openEntry && openEntry.sub !== sub) {
          openEntry.sub.hidden = true;
          openEntry.row.querySelector('.topic-caret').textContent = '▾';
        }
        sub.hidden = !opening;
        row.querySelector('.topic-caret').textContent = opening ? '▴' : '▾';
        openEntry = opening ? { sub, row } : null;
      });

      container.appendChild(card);
    });
  }

  function renderMyPacks(list) {
    const ul = $('my-packs-list');
    ul.innerHTML = '';
    $('my-packs-empty').hidden = list.length > 0;
    for (const p of list) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.textContent = `${p.title} (${p.count})`;
      const btn = document.createElement('button');
      btn.className = 'ban-btn';
      btn.textContent = 'Удалить';
      btn.addEventListener('click', () => {
        send({ type: 'remove_custom_pack', packId: p.id });
      });
      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  let pendingPackDetailTarget = null;

  function renderAdminCustomPacks(list) {
    const container = $('admin-custom-packs-list');
    container.innerHTML = '';
    $('admin-custom-packs-empty').hidden = list.length > 0;
    let openEntry = null;
    list.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'topic-card';

      const row = document.createElement('div');
      row.className = 'topic-row expandable';
      row.innerHTML =
        `<span class="topic-name">${esc(p.ownerName)}: ${esc(p.title)}</span>` +
        `<span class="topic-pct">${esc(p.count)} вопросов</span>` +
        `<span class="topic-caret">▾</span>`;
      card.appendChild(row);

      const detail = document.createElement('div');
      detail.className = 'admin-pack-detail';
      detail.hidden = true;
      card.appendChild(detail);

      row.addEventListener('click', () => {
        const opening = detail.hidden;
        if (openEntry && openEntry.detail !== detail) {
          openEntry.detail.hidden = true;
          openEntry.row.querySelector('.topic-caret').textContent = '▾';
        }
        detail.hidden = !opening;
        row.querySelector('.topic-caret').textContent = opening ? '▴' : '▾';
        openEntry = opening ? { detail, row } : null;
        if (opening && !detail.dataset.loaded) {
          detail.textContent = 'Загрузка…';
          pendingPackDetailTarget = detail;
          send({ type: 'admin_get_custom_pack', packId: p.id });
        }
      });

      container.appendChild(card);
    });
  }

  function renderAdminCustomPackDetail(pack) {
    const detail = pendingPackDetailTarget;
    pendingPackDetailTarget = null;
    if (!detail) return;
    detail.dataset.loaded = '1';
    if (!pack) {
      detail.textContent = 'Пак не найден (возможно, удалён владельцем).';
      return;
    }
    detail.innerHTML = '';
    const list = document.createElement('ul');
    list.className = 'review-list';
    pack.questions.forEach((q, i) => {
      const li = document.createElement('li');
      const optsHtml = q.options.map((o, idx) => {
        const label = typeof o === 'object' ? o.text : o;
        const content = idx === q.correctIndex ? `<span class="review-right">${esc(label)}</span>` : esc(label);
        return `<div class="review-line">${idx + 1}. ${content}</div>`;
      }).join('');
      li.innerHTML = `<div class="review-q">${i + 1}. ${esc(q.text)}</div>${optsHtml}`;
      list.appendChild(li);
    });
    detail.appendChild(list);
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

  function wireToggle(toggleId, bodyId) {
    const toggle = $(toggleId);
    const body = $(bodyId);
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      toggle.querySelector('.topic-caret').textContent = body.hidden ? '▾' : '▴';
    });
  }

  wireToggle('play-toggle', 'play-body');
  wireToggle('join-toggle', 'join-body');
  wireToggle('dup-toggle', 'dup-body');
  wireToggle('packs-toggle', 'packs-body');

  $('btn-multiplayer').addEventListener('click', () => {
    $('mp-error').textContent = '';
    showScreen('multiplayer');
  });
  $('btn-multiplayer-back').addEventListener('click', () => showScreen('home'));

  $('btn-ratings-back').addEventListener('click', () => showScreen('home'));

  $('btn-profile-back').addEventListener('click', () => showScreen('home'));

  $('btn-admin').addEventListener('click', () => {
    send({ type: 'admin_list_users' });
    showScreen('admin');
  });

  $('btn-open-pack-upload').addEventListener('click', () => {
    $('custom-pack-error').textContent = '';
    showScreen('pack-upload');
  });
  $('btn-pack-upload-back').addEventListener('click', () => showScreen('profile'));

  $('btn-add-pack').addEventListener('click', () => $('custom-pack-file').click());
  $('custom-pack-file').addEventListener('change', () => {
    const file = $('custom-pack-file').files[0];
    $('custom-pack-file').value = ''; // позволяет повторно выбрать тот же файл
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        $('custom-pack-error').textContent = 'Файл не является корректным JSON';
        return;
      }
      $('custom-pack-error').textContent = '';
      send({ type: 'add_custom_pack', title: data.title, questions: data.questions });
    };
    reader.onerror = () => {
      $('custom-pack-error').textContent = 'Не удалось прочитать файл';
    };
    reader.readAsText(file);
  });

  // Редактор набора проводит игрока по вопросам по одному.
  let pbQuestions = [];

  function pbUpdateCount() {
    $('pb-count').textContent = `Добавлено вопросов: ${pbQuestions.length} (нужно минимум 10)`;
    $('btn-pb-save').disabled = pbQuestions.length < 10;
  }

  function pbRenderList() {
    const ul = $('pb-questions-list');
    ul.innerHTML = '';
    pbQuestions.forEach((q, i) => {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.textContent = `${i + 1}. ${q.text}`;
      const btn = document.createElement('button');
      btn.className = 'ban-btn';
      btn.textContent = 'Удалить';
      btn.addEventListener('click', () => {
        pbQuestions.splice(i, 1);
        pbRenderList();
        pbUpdateCount();
      });
      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function pbResetForm() {
    $('pb-question-text').value = '';
    for (let i = 0; i < 4; i++) $(`pb-option-${i}`).value = '';
    document.querySelector('input[name="pb-correct"][value="0"]').checked = true;
    $('pb-question-number').textContent = pbQuestions.length + 1;
  }

  function pbResetAll() {
    pbQuestions = [];
    $('pb-title').value = '';
    $('pb-error').textContent = '';
    pbRenderList();
    pbUpdateCount();
    pbResetForm();
  }

  $('btn-open-pack-builder').addEventListener('click', () => {
    pbResetAll();
    showScreen('pack-builder');
  });
  $('btn-pb-back').addEventListener('click', () => showScreen('profile'));

  $('btn-pb-add-question').addEventListener('click', () => {
    const text = $('pb-question-text').value.trim();
    const options = [0, 1, 2, 3].map((i) => $(`pb-option-${i}`).value.trim());
    const correctIndex = Number(document.querySelector('input[name="pb-correct"]:checked').value);
    if (!text) {
      $('pb-error').textContent = 'Введите текст вопроса';
      return;
    }
    if (options.some((o) => !o)) {
      $('pb-error').textContent = 'Заполните все 4 варианта ответа';
      return;
    }
    $('pb-error').textContent = '';
    pbQuestions.push({ text, options, correctIndex });
    pbRenderList();
    pbUpdateCount();
    pbResetForm();
  });

  $('btn-pb-save').addEventListener('click', () => {
    const title = $('pb-title').value.trim();
    if (!title) {
      $('pb-error').textContent = 'Укажите название пака';
      return;
    }
    if (pbQuestions.length < 10) return;
    $('pb-error').textContent = '';
    send({ type: 'add_custom_pack', title, questions: pbQuestions });
  });

  $('btn-list-custom-packs').addEventListener('click', () => {
    send({ type: 'admin_list_custom_packs' });
  });

  $('btn-admin-back').addEventListener('click', () => showScreen('home'));

  $('btn-check-duplicates').addEventListener('click', () => {
    send({ type: 'admin_check_duplicates' });
  });

  // Античит отмечает переключение вкладки и потерю фокуса во время вопроса.
  function reportDistractionIfNeeded() {
    if (!onQuestionScreen || distractionReported) return;
    if (document.hidden || !document.hasFocus()) {
      distractionReported = true;
      send({ type: 'distracted' });
    }
  }
  document.addEventListener('visibilitychange', reportDistractionIfNeeded);
  window.addEventListener('blur', reportDistractionIfNeeded);

  // Действия на главном экране. Защита от двойного нажатия не даёт создать лишнюю комнату до ответа сервера.
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
    const selection = (mode === 'multiplayer' ? mpSelection : homeSelection).buildSelection();
    lastGameRequest = { mode, selection }; // запоминаем настройки для кнопки «Играть снова»
    localStorage.setItem('quiz_name', name);
    $('home-error').textContent = '';
    $('mp-error').textContent = '';
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
    // Сообщаем серверу о намеренном выходе, чтобы восстановление не вернуло игрока в комнату.
    send({ type: 'leave_room' });
    // Запоминаем отказ от приглашения, чтобы повторный start_param не подключил игрока обратно.
    if (startParam) {
      try { sessionStorage.setItem('declined_start_param', startParam); } catch (e) {}
    }
    setTimeout(() => location.reload(), 80);
  }

  let pendingConfirmAction = null;
  function openConfirm(text, confirmLabel, action) {
    $('confirm-text').textContent = text;
    $('btn-confirm-abort').textContent = confirmLabel;
    pendingConfirmAction = action;
    $('confirm-modal').hidden = false;
  }

  $('btn-restart').addEventListener('click', leaveAndReload);

  // Повторяем последнюю одиночную игру или игру с ботом с прежними настройками. Сервер сам освобождает завершённую комнату.
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

  // Прерывание игры.
  $('btn-abort').addEventListener('click', () => {
    openConfirm(
      gameMode === 'bot'
        ? 'Вы точно хотите прервать викторину? Матч будет засчитан как поражение боту.'
        : gameMode === 'matchmaking'
          ? 'Вы точно хотите прервать викторину? Рейтинг понизится.'
          : 'Вы точно хотите прервать викторину?',
      'Прервать',
      leaveAndReload
    );
  });

  // Закрытие лобби ведущим требует подтверждения: комната закроется для всех.
  $('btn-close-lobby').addEventListener('click', () => {
    openConfirm(
      lastPlayerCount > 1
        ? 'Закрыть лобби? Все игроки будут отключены от комнаты.'
        : 'Закрыть лобби?',
      'Закрыть',
      leaveAndReload
    );
  });

  $('btn-confirm-cancel').addEventListener('click', () => {
    $('confirm-modal').hidden = true;
    pendingConfirmAction = null;
  });

  $('btn-confirm-abort').addEventListener('click', () => {
    $('confirm-modal').hidden = true;
    const action = pendingConfirmAction;
    pendingConfirmAction = null;
    if (action) action();
  });

  // Выход гостя из лобби до начала игры не требует подтверждения.
  $('btn-back').addEventListener('click', leaveAndReload);

  // Ссылка на профиль поддержки в Max.
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

  // Копирование кода комнаты.
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

  // Приглашение друга через окно Max.
  $('btn-share').addEventListener('click', () => {
    const text = `Присоединяйся к моей викторине в Max! Код комнаты: ${roomCode}`;
    // Ссылка с startapp передаёт код комнаты через initDataUnsafe.start_param.
    const inviteLink = BOT_USERNAME ? `https://max.ru/${encodeURIComponent(BOT_USERNAME)}?startapp=${encodeURIComponent(roomCode)}` : '';
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
    // Вне Max копируем приглашение в буфер обмена.
    navigator.clipboard?.writeText(`${text} ${inviteLink}`).catch(() => {});
  });
})();
