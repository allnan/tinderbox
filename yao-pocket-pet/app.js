(function () {
  'use strict';

  const STORAGE_KEY = 'yao-pocket-pet-v2';
  const LEGACY_STORAGE_KEY = 'yao-pocket-pet-v1';
  const DAILY_CARE_GOAL = 3;
  const DAILY_GAME_INK_LIMIT = 15;
  const GAME_DURATION_MS = 12000;
  const DECAY_PER_HOUR = { fullness: 1.35, mood: 0.55, energy: 0.3, cleanliness: 0.35 };

  function dateKey(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function localDayNumber(key) {
    const parts = key.split('-').map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000;
  }

  const defaults = {
    fullness: 76,
    mood: 82,
    energy: 88,
    cleanliness: 94,
    bond: 12,
    ink: 8,
    daysTogether: 1,
    dailyCareCount: 0,
    dailyBonusClaimed: false,
    dailyGameInk: 0,
    bestScore: 0,
    petX: 50,
    petY: 56,
    isSleeping: false,
    lastDayKey: dateKey(new Date()),
    lastUpdatedAt: Date.now(),
    lastAction: 'hello',
    journal: []
  };

  const els = {
    clock: document.getElementById('clock'),
    mode: document.getElementById('mode-label'),
    dialogue: document.getElementById('pet-dialogue'),
    footer: document.getElementById('footer-message'),
    sprite: document.getElementById('pet-sprite'),
    eyes: document.getElementById('pet-eyes'),
    effect: document.getElementById('pet-effect'),
    petTap: document.getElementById('pet-tap'),
    world: document.getElementById('lcd-world'),
    activityObject: document.getElementById('activity-object'),
    gameHud: document.getElementById('game-hud'),
    gameTime: document.getElementById('game-time'),
    gameScore: document.getElementById('game-score'),
    gameTarget: document.getElementById('game-target'),
    panel: document.getElementById('interaction-panel'),
    panelTitle: document.getElementById('panel-title'),
    panelContent: document.getElementById('panel-content'),
    panelNote: document.getElementById('panel-note'),
    journalOpen: document.getElementById('journal-open'),
    values: {
      fullness: document.getElementById('value-fullness'),
      mood: document.getElementById('value-mood'),
      energy: document.getElementById('value-energy'),
      cleanliness: document.getElementById('value-cleanliness')
    },
    bars: {
      fullness: document.getElementById('bar-fullness'),
      mood: document.getElementById('bar-mood'),
      energy: document.getElementById('bar-energy')
    },
    bondLabel: document.getElementById('bond-label'),
    inkValue: document.getElementById('ink-value'),
    dailyProgress: document.getElementById('daily-progress'),
    careButtonLabel: document.getElementById('care-button-label')
  };

  function clamp(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function clampFloat(value) {
    return Math.max(0, Math.min(100, Number(value) || 0));
  }

  function clampInk(value) {
    return Math.max(0, Math.min(99, Math.round(Number(value) || 0)));
  }

  function normalizeState(saved) {
    return {
      ...defaults,
      fullness: clamp(saved.fullness ?? defaults.fullness),
      mood: clamp(saved.mood ?? defaults.mood),
      energy: clamp(saved.energy ?? defaults.energy),
      cleanliness: clamp(saved.cleanliness ?? defaults.cleanliness),
      bond: clamp(saved.bond ?? defaults.bond),
      ink: clampInk(saved.ink ?? defaults.ink),
      daysTogether: Math.max(1, Math.min(9999, Math.round(Number(saved.daysTogether) || 1))),
      dailyCareCount: Math.max(0, Math.min(DAILY_CARE_GOAL, Math.round(Number(saved.dailyCareCount) || 0))),
      dailyBonusClaimed: Boolean(saved.dailyBonusClaimed),
      dailyGameInk: Math.max(0, Math.min(DAILY_GAME_INK_LIMIT, Math.round(Number(saved.dailyGameInk) || 0))),
      bestScore: Math.max(0, Math.min(999, Math.round(Number(saved.bestScore) || 0))),
      petX: Math.max(24, Math.min(76, Number(saved.petX) || 50)),
      petY: Math.max(40, Math.min(78, Number(saved.petY) || 56)),
      isSleeping: Boolean(saved.isSleeping),
      lastDayKey: typeof saved.lastDayKey === 'string' ? saved.lastDayKey : defaults.lastDayKey,
      lastUpdatedAt: Number(saved.lastUpdatedAt) > 0 ? Number(saved.lastUpdatedAt) : Date.now(),
      lastAction: typeof saved.lastAction === 'string' ? saved.lastAction : 'hello',
      journal: Array.isArray(saved.journal)
        ? saved.journal.filter(function (entry) { return entry && typeof entry.text === 'string'; }).slice(0, 12)
        : []
    };
  }

  let migratedLegacySave = false;

  function readState() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        migratedLegacySave = Boolean(raw);
      }
      const saved = JSON.parse(raw || 'null');
      if (!saved || typeof saved !== 'object') return { ...defaults };
      return normalizeState(saved);
    } catch (_) {
      return { ...defaults };
    }
  }

  let state = readState();
  let reaction = null;
  let reactionUntil = 0;
  let reactionTimer = 0;
  let lastPetAt = 0;
  let game = null;
  let poseTimer = 0;
  let effectTimer = 0;
  let blinkTimer = 0;
  let hideTimer = 0;
  let leafTimer = 0;

  const poseClasses = [
    'is-patting', 'is-booped', 'is-tickled', 'is-walking', 'is-eating',
    'is-brushing', 'is-washing', 'is-waking', 'is-cuddling', 'is-sniffing',
    'is-stretching', 'is-celebrating', 'is-hiding', 'is-popping', 'is-curious'
  ];

  const foods = {
    berry: {
      title: '野地莓果', detail: '酸甜解馋 · 饱食 +18', cost: 0,
      effect: { fullness: 18, mood: 3, bond: 1 }, message: '阿咬两口吃掉莓果，嘴角沾了一点汁。'
    },
    rice: {
      title: '墨香团子', detail: '最喜欢的点心 · 饱食 +27，心情 +8', cost: 2,
      effect: { fullness: 27, mood: 8, cleanliness: -4, bond: 2 }, message: '咕噜！墨香团子果然是阿咬的最爱。'
    },
    mushroom: {
      title: '清心菌菇', detail: '轻盈暖胃 · 饱食 +12，体力 +10', cost: 1,
      effect: { fullness: 12, energy: 10, mood: 2, bond: 1 }, message: '阿咬闻了闻菌菇，吃完精神好多了。'
    }
  };

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      migratedLegacySave = false;
    } catch (_) {
      els.footer.textContent = '暂时无法保存这次照料，存储空间可能已满。';
    }
  }

  function addJournal(text) {
    state.journal.unshift({ day: state.daysTogether, time: clockText(), text: text });
    state.journal = state.journal.slice(0, 12);
  }

  function updateCalendar(now) {
    const today = dateKey(new Date(now));
    if (!state.lastDayKey) {
      state.lastDayKey = today;
      return;
    }
    if (state.lastDayKey === today) return;

    const passedDays = Math.max(1, localDayNumber(today) - localDayNumber(state.lastDayKey));
    state.daysTogether = Math.min(9999, state.daysTogether + passedDays);
    state.dailyCareCount = 0;
    state.dailyBonusClaimed = false;
    state.dailyGameInk = 0;
    state.lastDayKey = today;
    addJournal('新的一天开始了，你们又一起出发。');
  }

  function applyOfflineDrift() {
    const now = Date.now();
    const elapsedHours = Math.min(48, Math.max(0, (now - state.lastUpdatedAt) / 3600000));
    if (elapsedHours > 0) {
      if (state.isSleeping) {
        state.energy = clampFloat(state.energy + elapsedHours * 18);
        state.fullness = clampFloat(state.fullness - elapsedHours * 0.55);
        state.mood = clampFloat(state.mood + elapsedHours * 0.2);
        state.cleanliness = clampFloat(state.cleanliness - elapsedHours * 0.12);
        if (state.energy >= 100) {
          state.isSleeping = false;
          addJournal('阿咬睡饱醒来，伸了个懒腰。');
        }
      } else {
        state.fullness = clampFloat(state.fullness - elapsedHours * DECAY_PER_HOUR.fullness);
        state.mood = clampFloat(state.mood - elapsedHours * DECAY_PER_HOUR.mood);
        state.energy = clampFloat(state.energy - elapsedHours * DECAY_PER_HOUR.energy);
        state.cleanliness = clampFloat(state.cleanliness - elapsedHours * DECAY_PER_HOUR.cleanliness);
      }
    }
    state.lastUpdatedAt = now;
    updateCalendar(now);
    saveState();
  }

  function clockText() {
    const now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }

  function updateClock() {
    const now = new Date();
    els.clock.textContent = clockText();
    els.clock.dateTime = now.toISOString();
    const hour = now.getHours();
    els.world.dataset.time = hour < 6 || hour >= 21 ? 'night' : hour < 9 ? 'dawn' : hour < 17 ? 'day' : 'dusk';
  }

  function bondLevel() {
    const level = Math.min(5, 1 + Math.floor(state.bond / 20));
    const names = ['', '初识', '同行', '熟络', '默契', '知己'];
    return { level: level, name: names[level] };
  }

  function statusMessage() {
    if (state.isSleeping) return ['阿咬缩成一团，呼噜呼噜……', 'REST / SAFE'];
    if (state.fullness < 20) return ['肚子咕咕叫……有吃的吗？', 'NEEDS A SNACK'];
    if (state.energy < 20) return ['阿咬打了个哈欠，想歇会儿。', 'LOW ENERGY'];
    if (state.cleanliness < 22) return ['身上沾了些墨迹，想整理一下。', 'NEEDS CARE'];
    if (state.mood < 25) return ['阿咬有点闷，陪它玩一会儿吧。', 'CHEER UP'];
    return ['咬！今天也一起出发吧。', 'FIELD / IDLE'];
  }

  function renderValues() {
    ['fullness', 'mood', 'energy'].forEach(function (key) {
      const value = clamp(state[key]);
      els.values[key].textContent = String(value).padStart(2, '0');
      els.bars[key].style.width = value + '%';
      els.bars[key].setAttribute('aria-valuenow', String(value));
    });
    els.values.cleanliness.textContent = String(clamp(state.cleanliness)).padStart(2, '0');
    els.bondLabel.textContent = 'Lv.' + bondLevel().level + ' ' + bondLevel().name;
    els.inkValue.textContent = String(state.ink).padStart(2, '0');
    els.dailyProgress.textContent = state.dailyBonusClaimed
      ? '今日 ✓'
      : '今日 ' + state.dailyCareCount + '/' + DAILY_CARE_GOAL;
    els.careButtonLabel.textContent = state.isSleeping ? '起床' : '护理';
  }

  function render() {
    renderValues();
    const current = reaction && Date.now() < reactionUntil ? [reaction.message, reaction.mode] : statusMessage();
    if (reaction && Date.now() >= reactionUntil) reaction = null;
    els.dialogue.textContent = current[0];
    els.mode.textContent = game && game.active ? 'FIELD / CATCH' : current[1];
    els.sprite.classList.toggle('is-resting', state.isSleeping);
    els.sprite.style.left = state.petX + '%';
    els.sprite.style.top = state.petY + '%';
  }

  function animatePet(pose, duration) {
    window.clearTimeout(poseTimer);
    poseClasses.forEach(function (name) { els.sprite.classList.remove(name); });
    if (!pose || state.isSleeping) return;
    const className = 'is-' + pose;
    void els.sprite.offsetWidth;
    els.sprite.classList.add(className);
    if (duration !== 0) {
      poseTimer = window.setTimeout(function () { els.sprite.classList.remove(className); }, duration || 1500);
    }
  }

  function showPetEffect(effect, duration) {
    window.clearTimeout(effectTimer);
    els.effect.dataset.effect = effect;
    els.effect.classList.remove('is-visible');
    void els.effect.offsetWidth;
    els.effect.classList.add('is-visible');
    effectTimer = window.setTimeout(function () { els.effect.classList.remove('is-visible'); }, duration || 1600);
  }

  function blinkEyes() {
    window.clearTimeout(blinkTimer);
    els.eyes.classList.remove('is-blinking');
    void els.eyes.offsetWidth;
    els.eyes.classList.add('is-blinking');
    blinkTimer = window.setTimeout(function () { els.eyes.classList.remove('is-blinking'); }, 190);
  }

  function react(message, mode, pose, effect) {
    reaction = { message: message, mode: mode || 'FIELD / ACTIVE' };
    reactionUntil = Date.now() + 5000;
    window.clearTimeout(reactionTimer);
    reactionTimer = window.setTimeout(function () {
      reaction = null;
      render();
    }, 5000);
    state.lastUpdatedAt = Date.now();
    if (pose) animatePet(pose, 1900);
    if (effect) showPetEffect(effect);
    render();
    saveState();
  }

  function countDailyCare() {
    if (state.dailyCareCount < DAILY_CARE_GOAL) state.dailyCareCount += 1;
    if (state.dailyCareCount >= DAILY_CARE_GOAL && !state.dailyBonusClaimed) {
      state.dailyBonusClaimed = true;
      state.ink = clampInk(state.ink + 3);
      return 3;
    }
    return 0;
  }

  function setPanel(title, note) {
    els.panelTitle.textContent = title;
    els.panelNote.textContent = note || '';
    els.panelContent.replaceChildren();
    els.panel.hidden = false;
    els.panel.setAttribute('aria-hidden', 'false');
  }

  function closePanel(returnFocus) {
    if (els.panel.hidden) return;
    els.panel.hidden = true;
    els.panel.setAttribute('aria-hidden', 'true');
    if (returnFocus) returnFocus.focus();
  }

  function appendChoice(id, title, detail, cost) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'panel-choice';
    choice.dataset.choice = id;
    if (cost > state.ink) choice.disabled = true;

    const copy = document.createElement('span');
    copy.className = 'panel-choice-copy';
    const name = document.createElement('strong');
    name.textContent = title;
    const description = document.createElement('small');
    description.textContent = detail;
    copy.append(name, description);

    const price = document.createElement('span');
    price.className = 'panel-choice-price';
    price.textContent = cost ? '墨 ' + cost : '免费';
    choice.append(copy, price);
    els.panelContent.append(choice);
  }

  function openFeedMenu() {
    setPanel('给阿咬挑点吃的', '墨点来自抓墨点小游戏；莓果每天都可以免费喂。');
    Object.keys(foods).forEach(function (key) {
      const food = foods[key];
      appendChoice('food:' + key, food.title, food.detail, food.cost);
    });
    els.panelContent.querySelector('button:not(:disabled)')?.focus();
  }

  function openCareMenu() {
    setPanel('照料阿咬', '每天完成 3 次照料，可领取 3 枚墨点。');
    appendChoice('care:brush', '梳理一下', '整理毛发 · 洁净 +18，心情 +4', 0);
    appendChoice('care:wash', '温水擦拭', '仔细打理 · 洁净 +32，亲密 +2', 1);
    if (state.isSleeping) {
      appendChoice('care:wake', '叫醒阿咬', '结束休息，一起继续出发', 0);
    } else {
      appendChoice('care:sleep', '打个盹', '休息时每小时恢复 18 点体力', 0);
    }
    els.panelContent.querySelector('button:not(:disabled)')?.focus();
  }

  function openPlayMenu() {
    setPanel('陪阿咬玩一会儿', '选一个轻松的小互动；点 LCD 空地，阿咬也会跟着走。');
    appendChoice('play:leaf', '追一片叶子', '看阿咬小跑着追叶子，碰到叶子还有额外回应', 0);
    appendChoice('play:hide', '躲猫猫', '阿咬躲进小山后，点屏幕把它找出来', 0);
    appendChoice('play:cuddle', '贴贴', '靠过来蹭蹭，心情 +6，亲密 +2', 0);
    appendChoice('play:listen', '听阿咬说话', '看看它此刻想和你分享什么', 0);
    appendChoice('play:challenge', '追墨点挑战', '保留的 12 秒小挑战，可随时跳过', 0);
    els.panelContent.querySelector('button:not(:disabled)')?.focus();
  }

  function openJournal() {
    setPanel('旅途记事', '相伴第 ' + state.daysTogether + ' 天 · 最佳抓墨点 ' + state.bestScore + ' 枚');
    const summary = document.createElement('p');
    summary.className = 'journal-summary';
    summary.textContent = '亲密等级：Lv.' + bondLevel().level + ' ' + bondLevel().name + '　·　墨点：' + state.ink;
    els.panelContent.append(summary);
    if (!state.journal.length) {
      const empty = document.createElement('p');
      empty.className = 'journal-empty';
      empty.textContent = '你们的第一段旅程正等着写下。';
      els.panelContent.append(empty);
    } else {
      state.journal.slice(0, 8).forEach(function (entry) {
        const row = document.createElement('p');
        row.className = 'journal-entry';
        row.textContent = 'D' + String(entry.day).padStart(2, '0') + ' · ' + entry.time + '　' + entry.text;
        els.panelContent.append(row);
      });
    }
    els.panel.querySelector('[data-close-panel]').focus();
  }

  function applyEffect(effect) {
    Object.keys(effect).forEach(function (key) {
      if (key === 'bond') state.bond = clamp(state.bond + effect[key]);
      else if (key === 'cleanliness') state.cleanliness = clamp(state.cleanliness + effect[key]);
      else if (key === 'fullness' || key === 'mood' || key === 'energy') state[key] = clamp(state[key] + effect[key]);
    });
  }

  function careBonusText(bonus) {
    return bonus ? ' 今日照料完成，拿到 3 枚墨点！' : '';
  }

  function walkTo(x, y) {
    state.petX = Math.max(24, Math.min(76, x));
    state.petY = Math.max(40, Math.min(78, y));
    animatePet('walking', 1500);
    react('阿咬跟着你的手指，小跑到那里看看。', 'FIELD / FOLLOW', 'walking');
  }

  function startLeafChase() {
    if (state.isSleeping) {
      react('阿咬还在睡觉，先叫醒它吧。', 'REST / SAFE', undefined, 'sleep');
      return;
    }
    closePanel();
    window.clearTimeout(leafTimer);
    state.mood = clamp(state.mood + 5);
    state.bond = clamp(state.bond + 1);
    const bonus = countDailyCare();
    addJournal('和阿咬追了一片落叶。');
    els.activityObject.hidden = false;
    els.activityObject.classList.remove('is-flying');
    void els.activityObject.offsetWidth;
    els.activityObject.classList.add('is-flying');
    state.petX = 67;
    state.petY = 57;
    react('叶子飞起来啦！阿咬摇摇晃晃追过去。' + careBonusText(bonus), 'PLAY / LEAF', 'walking', 'sparkle');
    leafTimer = window.setTimeout(function () {
      els.activityObject.hidden = true;
      els.activityObject.classList.remove('is-flying');
      state.petX = 50;
      state.petY = 56;
      animatePet('sniffing', 1300);
      showPetEffect('leaf');
      reaction = { message: '阿咬叼着叶子回来，认真地放到你手边。', mode: 'PLAY / FOUND' };
      reactionUntil = Date.now() + 3500;
      render();
      saveState();
    }, 2600);
  }

  function catchLeaf() {
    if (els.activityObject.hidden) return;
    window.clearTimeout(leafTimer);
    els.activityObject.hidden = true;
    els.activityObject.classList.remove('is-flying');
    state.mood = clamp(state.mood + 4);
    state.bond = clamp(state.bond + 1);
    state.petX = 50;
    state.petY = 56;
    addJournal('你帮阿咬接住了落叶。');
    react('接住啦！阿咬围着叶子开心地转了一圈。', 'PLAY / FOUND', 'celebrating', 'sparkle');
  }

  function revealFromHide(found) {
    window.clearTimeout(hideTimer);
    els.sprite.classList.remove('is-hidden');
    els.world.classList.remove('is-hide-seek');
    state.petX = 50;
    state.petY = 56;
    if (found) {
      state.mood = clamp(state.mood + 4);
      state.bond = clamp(state.bond + 1);
      addJournal('你在小山后找到了阿咬。');
      react('找到啦！阿咬从小山后探出头，开心地蹭蹭你。', 'PLAY / FOUND', 'popping', 'heart');
    } else {
      react('阿咬等了一会儿，自己从小山后探出头。', 'PLAY / PEEK', 'popping', 'sparkle');
    }
  }

  function startHideAndSeek() {
    if (state.isSleeping) {
      react('阿咬还在睡觉，先叫醒它吧。', 'REST / SAFE', undefined, 'sleep');
      return;
    }
    closePanel();
    window.clearTimeout(hideTimer);
    state.mood = clamp(state.mood + 3);
    const bonus = countDailyCare();
    addJournal('和阿咬玩了一次躲猫猫。');
    state.petX = 70;
    state.petY = 78;
    els.world.classList.add('is-hide-seek');
    react('阿咬躲进小山后啦，点一下屏幕把它找出来！' + careBonusText(bonus), 'PLAY / HIDE', 'hiding');
    window.setTimeout(function () {
      if (els.world.classList.contains('is-hide-seek')) els.sprite.classList.add('is-hidden');
    }, 520);
    hideTimer = window.setTimeout(function () {
      revealFromHide(false);
    }, 6500);
  }

  function cuddle() {
    if (state.isSleeping) {
      react('阿咬在睡觉，贴近一点陪它就好。', 'REST / SAFE', undefined, 'heart');
      return;
    }
    closePanel();
    state.mood = clamp(state.mood + 6);
    state.bond = clamp(state.bond + 2);
    const bonus = countDailyCare();
    addJournal('阿咬靠过来和你贴贴。');
    react('阿咬靠过来贴了贴你，口水轻轻晃了一下。' + careBonusText(bonus), 'BOND / CLOSE', 'cuddling', 'heart');
  }

  function listenToYao() {
    if (state.isSleeping) {
      react('阿咬已经睡着了，呼噜声像在说晚安。', 'REST / SAFE', undefined, 'notes');
      return;
    }
    closePanel();
    const lines = [
      '阿咬抬起脸：前面好像有新的路。',
      '阿咬轻轻哼了一声，挨着你不肯走远。',
      '阿咬闻了闻风里的味道，像是在打招呼。',
      '阿咬看着你，嘴角的口水晃出了一点光。'
    ];
    state.mood = clamp(state.mood + 3);
    const bonus = countDailyCare();
    addJournal('停下来听阿咬说了会儿话。');
    react(lines[Math.floor(Math.random() * lines.length)] + careBonusText(bonus), 'BOND / CHAT', 'sniffing', 'notes');
  }

  function performPlay(action) {
    if (action !== 'hide' && els.world.classList.contains('is-hide-seek')) revealFromHide(false);
    if (action === 'leaf') startLeafChase();
    if (action === 'hide') startHideAndSeek();
    if (action === 'cuddle') cuddle();
    if (action === 'listen') listenToYao();
    if (action === 'challenge') startGame();
  }

  function feed(id) {
    const food = foods[id];
    if (!food) return;
    if (state.isSleeping) {
      els.panelNote.textContent = '阿咬在睡觉，先叫醒它再喂食。';
      return;
    }
    if (state.ink < food.cost) return;
    state.ink -= food.cost;
    applyEffect(food.effect);
    const bonus = countDailyCare();
    addJournal('吃了' + food.title + '。');
    closePanel();
    react(food.message + careBonusText(bonus), 'FEED / YUM', 'eating', 'food-' + id);
  }

  function care(action) {
    if (action === 'brush') {
      state.cleanliness = clamp(state.cleanliness + 18);
      state.mood = clamp(state.mood + 4);
      state.bond = clamp(state.bond + 1);
      const bonus = countDailyCare();
      addJournal('陪阿咬梳理了一下。');
      closePanel();
      react('阿咬抖抖身上的墨点，舒服多了。' + (bonus ? ' 今日照料完成，拿到 3 枚墨点！' : ''), 'CARE / BRUSH', 'brushing', 'sparkle');
      return;
    }
    if (action === 'wash') {
      if (state.ink < 1) {
        els.panelNote.textContent = '还差 1 枚墨点；抓墨点小游戏可以获得墨点。';
        return;
      }
      state.ink -= 1;
      state.cleanliness = clamp(state.cleanliness + 32);
      state.mood = clamp(state.mood + 5);
      state.bond = clamp(state.bond + 2);
      const bonus = countDailyCare();
      addJournal('用温水给阿咬擦拭干净。');
      closePanel();
      react('阿咬甩甩水珠，整只都清爽了。' + (bonus ? ' 今日照料完成，拿到 3 枚墨点！' : ''), 'CARE / CLEAN', 'washing', 'water');
      return;
    }
    if (action === 'sleep') {
      state.isSleeping = true;
      state.lastUpdatedAt = Date.now();
      addJournal('阿咬钻进小窝睡了一会儿。');
      closePanel();
      react('晚安，阿咬。醒来后再一起出发。', 'REST / SAFE', undefined, 'sleep');
      return;
    }
    if (action === 'wake') {
      state.isSleeping = false;
      state.lastUpdatedAt = Date.now();
      addJournal('你轻轻叫醒了阿咬。');
      closePanel();
      react('阿咬揉揉眼睛，醒啦。', 'FIELD / HELLO', 'waking', 'sparkle');
    }
  }

  function moveGameTarget() {
    const width = Math.max(20, els.world.clientWidth - 20);
    const height = Math.max(24, els.world.clientHeight - 26);
    const left = 8 + Math.random() * Math.max(1, width - 16);
    const top = 18 + Math.random() * Math.max(1, height - 18);
    els.gameTarget.style.left = left + 'px';
    els.gameTarget.style.top = top + 'px';
  }

  function renderGameHud() {
    if (!game || !game.active) return;
    const remaining = Math.max(0, game.endsAt - Date.now());
    els.gameTime.textContent = (remaining / 1000).toFixed(1);
    els.gameScore.textContent = String(game.score);
    if (remaining <= 0) finishGame();
  }

  function startGame() {
    if (game && game.active) return;
    if (state.isSleeping) {
      react('阿咬还在睡觉，先叫醒它吧。', 'REST / SAFE', undefined, 'sleep');
      return;
    }
    if (state.energy < 12) {
      react('阿咬累得跑不动了，先让它休息一会儿。', 'LOW ENERGY');
      return;
    }
    closePanel();
    state.energy = clamp(state.energy - 7);
    state.fullness = clamp(state.fullness - 3);
    state.lastUpdatedAt = Date.now();
    game = { active: true, score: 0, endsAt: Date.now() + GAME_DURATION_MS, timer: null };
    els.world.classList.add('is-playing');
    els.gameHud.hidden = false;
    els.gameTarget.hidden = false;
    els.mode.textContent = 'FIELD / CATCH';
    els.dialogue.textContent = '抓住墨点！12 秒内点得越多越好。';
    moveGameTarget();
    saveState();
    game.timer = window.setInterval(renderGameHud, 100);
    renderGameHud();
  }

  function finishGame() {
    if (!game || !game.active) return;
    window.clearInterval(game.timer);
    const score = game.score;
    const possibleReward = Math.min(6, Math.floor(score / 3) + (score >= 9 ? 1 : 0));
    const roomToday = Math.max(0, DAILY_GAME_INK_LIMIT - state.dailyGameInk);
    const reward = Math.min(possibleReward, roomToday, 99 - state.ink);
    state.ink = clampInk(state.ink + reward);
    state.dailyGameInk += reward;
    state.bestScore = Math.max(state.bestScore, score);
    state.mood = clamp(state.mood + Math.min(18, score * 2));
    state.bond = clamp(state.bond + Math.min(5, 1 + Math.floor(score / 3)));
    const bonus = countDailyCare();
    addJournal('抓到了 ' + score + ' 枚墨点，带回 ' + reward + ' 枚墨点。');
    game.active = false;
    els.world.classList.remove('is-playing');
    els.gameHud.hidden = true;
    els.gameTarget.hidden = true;
    game = null;
    render();
    react(score > 0
      ? '抓到 ' + score + ' 枚墨点，收获 ' + reward + ' 枚！' + (bonus ? ' 今日照料完成，再奖励 3 枚。' : '')
      : '墨点跑得太快了，再试一次吧！', 'FIELD / CAUGHT', score > 0 ? 'celebrating' : 'sniffing', score > 0 ? 'sparkle' : undefined);
  }

  function interactWithPet(kind) {
    if (game && game.active) return;
    const now = Date.now();
    if (now - lastPetAt < 650) return;
    lastPetAt = now;
    if (state.isSleeping) {
      care('wake');
      return;
    }

    const reactions = {
      head: ['阿咬把头顶凑过来，让你再摸一下。', 'BOND / PAT', 'patting', 'heart', '你摸了摸阿咬的头。'],
      face: ['指尖碰到阿咬脸上的绿纹，它闭眼蹭了一下。', 'BOND / BOOP', 'booped', 'sparkle', '你轻轻碰了碰阿咬的脸。'],
      feet: ['阿咬抬起一只短脚，扑腾着躲开你的手。', 'BOND / TICKLE', 'tickled', 'surprise', '你挠了挠阿咬的脚边。'],
      drool: ['阿咬转过脸看你，生物左侧的口水轻轻晃了晃。', 'BOND / CURIOUS', 'curious', 'drool', '你碰了碰阿咬嘴角边的口水。']
    };
    const item = reactions[kind] || reactions.head;
    state.mood = clamp(state.mood + 4);
    state.bond = clamp(state.bond + 1);
    const bonus = countDailyCare();
    addJournal(item[4]);
    if (kind === 'face') blinkEyes();
    react(item[0] + careBonusText(bonus), item[1], item[2], item[3]);
  }

  function handleSceneTap(event) {
    if (game && game.active) return;
    if (els.sprite.classList.contains('is-hidden')) {
      revealFromHide(true);
      return;
    }
    if (state.isSleeping) {
      care('wake');
      return;
    }

    const rect = els.sprite.getBoundingClientRect();
    const hasPoint = event.detail !== 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
    const hitSprite = els.sprite.contains(event.target) || (hasPoint && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (!hitSprite && hasPoint) {
      const scene = els.petTap.getBoundingClientRect();
      walkTo((event.clientX - scene.left) / scene.width * 100, (event.clientY - scene.top) / scene.height * 100);
      return;
    }

    const localY = hasPoint ? (event.clientY - rect.top) / rect.height : 0.2;
    const localX = hasPoint ? (event.clientX - rect.left) / rect.width : 0.5;
    if (localY < 0.36) interactWithPet('head');
    else if (localY > 0.79) interactWithPet('feet');
    else if (localX > 0.64 && localY > 0.49) interactWithPet('drool');
    else interactWithPet('face');
  }

  function ambientMoment() {
    if (state.isSleeping || (game && game.active) || !els.panel.hidden || !els.activityObject.hidden || els.world.classList.contains('is-hide-seek')) return;
    if (reaction && Date.now() < reactionUntil) return;
    const choice = Math.random();
    if (choice < 0.43) {
      blinkEyes();
    } else if (choice < 0.69) {
      animatePet('sniffing', 1200);
    } else if (choice < 0.88) {
      animatePet('stretching', 1500);
    } else {
      state.petX = 34 + Math.random() * 32;
      state.petY = 48 + Math.random() * 20;
      animatePet('walking', 1600);
      render();
      saveState();
    }
  }

  function perform(action) {
    if (els.world.classList.contains('is-hide-seek')) revealFromHide(false);
    if (action === 'feed') openFeedMenu();
    if (action === 'play') openPlayMenu();
    if (action === 'care') openCareMenu();
  }

  document.querySelectorAll('[data-action]').forEach(function (button) {
    button.addEventListener('click', function () {
      perform(button.dataset.action);
    });
  });

  els.petTap.addEventListener('click', handleSceneTap);
  els.activityObject.addEventListener('click', catchLeaf);
  els.journalOpen.addEventListener('click', openJournal);
  els.panel.querySelector('[data-close-panel]').addEventListener('click', function () {
    closePanel(els.journalOpen);
  });
  els.panelContent.addEventListener('click', function (event) {
    const button = event.target.closest('[data-choice]');
    if (!button || button.disabled) return;
    const parts = button.dataset.choice.split(':');
    if (parts[0] === 'food') feed(parts[1]);
    if (parts[0] === 'care') care(parts[1]);
    if (parts[0] === 'play') performPlay(parts[1]);
  });
  els.gameTarget.addEventListener('click', function () {
    if (!game || !game.active) return;
    game.score += 1;
    els.gameScore.textContent = String(game.score);
    els.gameTarget.classList.remove('is-hit');
    void els.gameTarget.offsetWidth;
    els.gameTarget.classList.add('is-hit');
    moveGameTarget();
  });

  document.addEventListener('keydown', function (event) {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && !els.panel.hidden) {
      closePanel(els.journalOpen);
      return;
    }
    const target = event.target;
    if (target && /INPUT|TEXTAREA|SELECT|BUTTON/.test(target.tagName)) return;
    const keyMap = { a: 'feed', s: 'play', d: 'care', '1': 'feed', '2': 'play', '3': 'care' };
    const action = keyMap[event.key.toLowerCase()];
    if (action) perform(action);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      applyOfflineDrift();
      if (game && Date.now() >= game.endsAt) finishGame();
      render();
    }
  });

  if (migratedLegacySave) addJournal('旧存档已保留，并加入新的照料记录。');
  applyOfflineDrift();
  updateClock();
  render();
  window.setInterval(updateClock, 15000);
  window.setInterval(ambientMoment, 4800);
  window.setInterval(function () {
    applyOfflineDrift();
    render();
  }, 60000);

  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./service-worker.js').catch(function () {});
    });
  }
})();
