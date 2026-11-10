'use strict';

const debug = { errors: [], transitions: [], speech: [], state: null, ready: false };
window.__PET_DEBUG__ = debug;

function reportError(err) {
  const message = err && err.stack ? err.stack : String(err);
  debug.errors.push(message);
  if (window.petApi) window.petApi.reportError(message);
}

window.addEventListener('error', (event) => reportError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportError(event.reason));

const STATE_LABELS = { idle: '发呆', walk: '散步', dragged: '被拎起来', falling: '下落中', chatting: '聊天中' };
const GESTURE_LABELS = { think: '思考', resigned: '无奈', mock_angry: '佯怒', 'idle.smoke': '抽烟' };
const FADE_MS = 160;
const MAX_SWAY_DEG = 12;
const DOUBLE_CLICK_MS = 260;
const CHUNK_CHARS = 46;
const TYPE_MS = 32;

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const chance = (p) => Math.random() < p;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const lastPicked = new Map();
function pick(list) {
  if (!list || !list.length) return null;
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && lastPicked.get(list) === i) i = (i + 1) % list.length;
  lastPicked.set(list, i);
  return list[i];
}

// Split a reply into bubble-sized chunks, preferring sentence boundaries.
function chunkText(text) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().match(/[^。！？!?~…]+[。！？!?~…]*/g) || [];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length <= CHUNK_CHARS) {
      current += sentence;
      continue;
    }
    if (current) chunks.push(current.trim());
    current = sentence;
    while (current.length > CHUNK_CHARS) {
      chunks.push(current.slice(0, CHUNK_CHARS));
      current = current.slice(CHUNK_CHARS);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function loadImages(manifest) {
  return Promise.all(Object.entries(manifest.actions).map(([action, info]) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.decode().catch(() => {}).then(() => resolve([action, image]));
    image.onerror = () => reject(new Error(`无法读取 ${info.image}`));
    image.src = info.image;
  }))).then(Object.fromEntries);
}

(async function main() {
  const api = window.petApi;
  if (!api) throw new Error('preload 未注入 petApi');
  const LINES = window.PET_LINES;

  const init = await api.init();
  let metrics = init.metrics;
  let settings = init.settings;

  const clips = PetAnimation.buildClips(init.manifest);
  const images = await loadImages(init.manifest);
  const anim = new PetAnimation.Animator(clips, images);

  const canvas = document.getElementById('pet');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const fadeCanvas = document.createElement('canvas');
  const fadeCtx = fadeCanvas.getContext('2d');
  const shadow = document.getElementById('shadow');
  const bubbleEl = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const emoteEl = document.getElementById('emote');
  const chatEl = document.getElementById('chat');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');

  // ---------- presentation ----------

  const fx = { angle: 0, angleVel: 0, angleTarget: 0, squash: 0, squashVel: 0, fadeT: 1, active: false };

  anim.onClipChange = () => {
    if (!canvas.width || !canvas.height) return;
    fadeCanvas.width = canvas.width;
    fadeCanvas.height = canvas.height;
    fadeCtx.clearRect(0, 0, fadeCanvas.width, fadeCanvas.height);
    fadeCtx.drawImage(canvas, 0, 0);
    fx.fadeT = 0;
  };

  function applyLayout(next) {
    metrics = next;
    const dpr = window.devicePixelRatio || 1;
    const root = document.documentElement.style;
    root.setProperty('--win-w', `${metrics.width}px`);
    root.setProperty('--win-h', `${metrics.height}px`);
    root.setProperty('--cell-w', `${metrics.cellWidth}px`);
    root.setProperty('--cell-h', `${metrics.cellHeight}px`);
    canvas.style.left = `${Math.round((metrics.width - metrics.cellWidth) / 2)}px`;
    canvas.width = Math.round(metrics.cellWidth * dpr);
    canvas.height = Math.round(metrics.cellHeight * dpr);
    fx.fadeT = 1;
    anim.dirty = true;
  }

  function watchPixelRatio() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', () => {
      applyLayout(metrics);
      watchPixelRatio();
    }, { once: true });
  }

  function setShadow(onGround) {
    shadow.classList.toggle('away', !onGround);
  }

  function kickSquash(amount) {
    fx.squash = amount;
    fx.squashVel = 0;
  }

  function showEmote(symbol) {
    if (!symbol) return;
    emoteEl.textContent = symbol;
    emoteEl.classList.remove('pop');
    void emoteEl.offsetWidth;
    emoteEl.classList.add('pop');
  }

  function stepFx(dt) {
    let active = false;
    if (!machine.is('dragged')) fx.angleTarget = 0;
    else fx.angleTarget *= Math.exp(-5 * dt);
    fx.angleVel += (90 * (fx.angleTarget - fx.angle) - 9 * fx.angleVel) * dt;
    fx.angle += fx.angleVel * dt;
    if (fx.angleTarget === 0 && Math.abs(fx.angle) < 0.03 && Math.abs(fx.angleVel) < 0.05) {
      fx.angle = 0;
      fx.angleVel = 0;
    } else {
      active = true;
    }

    fx.squashVel += (-260 * fx.squash - 14 * fx.squashVel) * dt;
    fx.squash += fx.squashVel * dt;
    if (Math.abs(fx.squash) < 0.0005 && Math.abs(fx.squashVel) < 0.005) {
      fx.squash = 0;
      fx.squashVel = 0;
    } else {
      active = true;
    }

    if (fx.fadeT < 1) {
      fx.fadeT = Math.min(1, fx.fadeT + (dt * 1000) / FADE_MS);
      active = true;
    }
    const changed = active || fx.active;
    fx.active = active;
    return changed;
  }

  function draw() {
    const W = canvas.width;
    const H = canvas.height;
    const clip = anim.clip;
    const f = anim.frame;
    const ax = (clip.anchor.x / clip.cell.w) * W;
    const ay = (clip.anchor.y / clip.cell.h) * H;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.save();
    if (fx.squash) {
      g.translate(ax, ay);
      g.scale(1 + fx.squash * 0.6, 1 - fx.squash);
      g.translate(-ax, -ay);
    }
    if (fx.angle) {
      const px = W / 2;
      const py = H * 0.05;
      g.translate(px, py);
      g.rotate((fx.angle * Math.PI) / 180);
      g.translate(-px, -py);
    }
    if (anim.flipX) {
      g.translate(ax, 0);
      g.scale(-1, 1);
      g.translate(-ax, 0);
    }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(anim.image, f.x, f.y, f.w, f.h, 0, 0, W, H);
    g.restore();
    if (fx.fadeT < 1) {
      const t = 1 - fx.fadeT;
      g.globalAlpha = t * t;
      g.drawImage(fadeCanvas, 0, 0);
      g.globalAlpha = 1;
    }
  }

  // ---------- speech bubble: typewriter, multi-part replies, thinking dots ----------

  const speech = {
    queue: [],
    timer: null,
    typer: null,

    say(text, { force = false } = {}) {
      if (!text || (!settings.bubbles && !force)) return;
      debug.speech.push(text);
      if (debug.speech.length > 20) debug.speech.shift();
      this.queue = chunkText(text);
      this.next();
    },

    next() {
      this.stop();
      const chunk = this.queue.shift();
      if (!chunk) {
        bubbleEl.classList.remove('show');
        return;
      }
      bubbleEl.classList.remove('thinking');
      bubbleText.textContent = '';
      this.pop();
      let shown = 0;
      this.typer = setInterval(() => {
        shown += 1;
        bubbleText.textContent = chunk.slice(0, shown);
        if (shown >= chunk.length) {
          clearInterval(this.typer);
          this.typer = null;
          const hold = this.queue.length ? 1400 + chunk.length * 60 : 2200 + chunk.length * 110;
          this.timer = setTimeout(() => this.next(), hold);
        }
      }, TYPE_MS);
    },

    thinking() {
      this.stop();
      this.queue = [];
      bubbleEl.classList.add('thinking');
      bubbleText.replaceChildren();
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
      bubbleText.append(dots);
      this.pop();
    },

    pop() {
      bubbleEl.classList.remove('show');
      void bubbleEl.offsetWidth;
      bubbleEl.classList.add('show');
    },

    stop() {
      clearInterval(this.typer);
      clearTimeout(this.timer);
      this.typer = null;
      this.timer = null;
    },

    hide() {
      this.stop();
      this.queue = [];
      bubbleEl.classList.remove('show', 'thinking');
    }
  };

  // ---------- behaviour ----------

  const ctx = { mood: 0, userAway: false };
  let chatOpen = false;
  let waitingReply = false;

  function lineFor(name) {
    return {
      think: LINES.muse,
      resigned: LINES.sigh,
      mock_angry: LINES.pokeAngry,
      'idle.smoke': LINES.smoke
    }[name];
  }

  function gesture(name, line, lineChance = 1, emote = null) {
    return ['gesture', { name, line, chance: lineChance, emote }];
  }

  function pokeReaction(c) {
    c.mood = Math.min(6, c.mood + 1.2);
    if (c.mood >= 3.6) {
      c.mood = 2.2;
      return gesture('mock_angry', pick(LINES.pokeAngry), 1, '💢');
    }
    if (c.mood >= 2.2) return gesture('resigned', pick(LINES.pokeSigh), 1, '…');
    return gesture('think', pick(LINES.pokeCurious), 1, '?');
  }

  function landingReaction(p = {}) {
    const speed = p.speed || 0;
    const height = p.height || 0;
    setShadow(true);
    if (speed > 300) kickSquash(Math.min(0.12, speed / 22000));
    if (height > 260 || speed > 2000) return gesture('mock_angry', pick(LINES.landHard), 1, '💢');
    if (height > 60) return gesture('resigned', pick(LINES.landSoft), 0.7, '…');
    return 'idle';
  }

  function commandTarget(cmd) {
    if (!cmd) return null;
    if (cmd.type === 'gesture') return gesture(cmd.name, pick(lineFor(cmd.name)), 0.6);
    if (cmd.type === 'walk') return ['walk', { dir: cmd.dir, duration: rand(4, 8) }];
    if (cmd.type === 'stop') return machine.is('idle') ? null : 'idle';
    if (cmd.type === 'chat') {
      openChat();
      return null;
    }
    return null;
  }

  function decideIdle() {
    const r = Math.random();
    if (r < 0.5) return ['walk', { line: chance(0.25) ? pick(LINES.walk) : null }];
    if (r < 0.64) return gesture('think', pick(LINES.muse), 0.5);
    if (r < 0.72) return gesture('resigned', pick(LINES.sigh), 0.4);
    return null;
  }

  // Turns an agent reply ({ text, actions }) into speech plus the next state.
  function performReply(p, m) {
    speech.say(p.text, { force: Boolean(p.force || p.important) });
    const actions = p.actions || [];
    const act = actions.find((a) => a.type === 'gesture');
    const walk = actions.find((a) => a.type === 'walk');
    if (act && act.emote) showEmote(act.emote);
    if (m.is('dragged', 'falling')) return null;
    const walkState = walk ? ['walk', { dir: walk.dir, duration: walk.seconds }] : null;
    if (act) return ['gesture', { name: act.name, then: walkState }];
    if (walkState) return walkState;
    return m.is('chatting') ? 'idle' : null;
  }

  async function startWalking(m, dir) {
    const token = m.data.token;
    m.data.dir = dir || 1;
    anim.setFlip(m.data.dir < 0);
    const actual = await api.walk(dir || 0);
    if (!machine.is('walk') || m.data.token !== token) return;
    m.data.dir = actual;
    m.data.walking = true;
    anim.setFlip(actual < 0);
  }

  const states = {
    idle: {
      enter(c, _p, m) {
        m.data.loops = 0;
        m.data.smokeAfter = randInt(5, 9);
        m.data.decideIn = rand(6, 15);
        setShadow(true);
        anim.play('idle.breathe', {
          onLoop: () => {
            if (!machine.is('idle')) return;
            m.data.loops += 1;
            if (m.data.loops >= m.data.smokeAfter) {
              machine.transition('gesture', { name: 'idle.smoke', line: pick(LINES.smoke), chance: 0.2 });
            }
          }
        });
      },
      update(c, dt, m) {
        if (!settings.autonomous || c.userAway || chatOpen) return null;
        m.data.decideIn -= dt;
        if (m.data.decideIn > 0) return null;
        m.data.decideIn = rand(6, 15);
        return decideIdle();
      }
    },

    walk: {
      enter(c, p, m) {
        m.data.token = Symbol('walk');
        m.data.remaining = p.duration || rand(3.5, 9);
        setShadow(true);
        anim.play('walk', { flipX: p.dir < 0 });
        if (p.line) speech.say(p.line);
        startWalking(m, p.dir);
      },
      update(c, dt, m) {
        if (!m.data.walking) return null;
        m.data.remaining -= dt;
        return m.data.remaining <= 0 ? 'idle' : null;
      },
      exit() {
        api.stopWalk();
      },
      on: {
        WALL: (c, _p, m) => {
          if (!chance(0.7)) return 'idle';
          if (chance(0.3)) speech.say(pick(LINES.wall));
          showEmote('!');
          m.data.walking = false;
          m.data.remaining = Math.max(m.data.remaining, rand(2, 4));
          startWalking(m, -m.data.dir);
          return null;
        },
        CMD: (c, cmd, m) => {
          if (cmd && cmd.type === 'walk') {
            m.data.remaining = rand(4, 8);
            startWalking(m, cmd.dir);
            return null;
          }
          return commandTarget(cmd);
        }
      }
    },

    gesture: {
      enter(c, p, m) {
        m.data.name = p.name;
        m.data.then = p.then || null;
        setShadow(true);
        anim.play(p.name, { loop: false, restart: true, onEnd: () => machine.send('ANIM_END') });
        if (p.emote) showEmote(p.emote);
        if (p.line && chance(p.chance === undefined ? 1 : p.chance)) speech.say(p.line);
      },
      on: {
        ANIM_END: (c, _p, m) => m.data.then || 'idle',
        POKE: (c, _p, m) => {
          const next = pokeReaction(c);
          if (next[1].name === m.data.name) {
            speech.say(next[1].line);
            showEmote(next[1].emote);
            return null;
          }
          return next;
        }
      }
    },

    chatting: {
      enter() {
        setShadow(true);
        anim.hold('think', 3);
        speech.thinking();
      },
      update(c, _dt, m) {
        return performance.now() - m.enteredAt > 45000 ? 'idle' : null;
      },
      on: {
        POKE: () => {
          showEmote('💢');
          return null;
        },
        CMD: (c, cmd) => (cmd && cmd.type === 'chat' ? commandTarget(cmd) : null),
        CHAT_START: null
      }
    },

    dragged: {
      enter() {
        api.dragStart();
        setShadow(false);
        anim.hold('resigned', 2);
        showEmote('!');
        if (chance(0.6)) speech.say(pick(LINES.dragged));
      },
      on: {
        DRAG_START: null,
        POKE: null,
        CMD: null,
        AIRBORNE: null,
        LANDED: null,
        CHAT_START: null,
        DRAG_END: () => {
          api.dragEnd();
          return 'falling';
        }
      }
    },

    falling: {
      enter() {
        setShadow(false);
        anim.hold('resigned', 1);
      },
      update(c, _dt, m) {
        return performance.now() - m.enteredAt > 8000 ? 'idle' : null;
      },
      on: {
        POKE: null,
        CMD: null,
        AIRBORNE: null,
        CHAT_START: null,
        LANDED: (c, p) => landingReaction(p)
      }
    }
  };

  const machine = new StateMachine({
    context: ctx,
    states,
    global: {
      POKE: (c) => pokeReaction(c),
      DRAG_START: 'dragged',
      AIRBORNE: 'falling',
      LANDED: (c, p) => landingReaction(p),
      CMD: (c, cmd) => commandTarget(cmd),
      CHAT_START: 'chatting',
      SAY: (c, p, m) => performReply(p, m),
      USER_AWAY: (c) => {
        c.userAway = true;
        return null;
      },
      USER_BACK: (c, _p, m) => {
        c.userAway = false;
        return m.is('idle') && !settings.llm ? gesture('think', pick(LINES.welcomeBack)) : null;
      }
    }
  });

  machine.onTransition(({ from, to, payload }) => {
    const detail = payload && payload.name ? payload.name : null;
    api.notifyState(to === 'gesture' ? (GESTURE_LABELS[detail] || detail) : STATE_LABELS[to]);
    debug.state = to;
    debug.transitions.push({ at: Math.round(performance.now()), from, to, detail });
    if (debug.transitions.length > 60) debug.transitions.shift();
  });

  // ---------- chat ----------

  function openChat() {
    if (!chatOpen) {
      chatOpen = true;
      chatEl.classList.add('open');
      if (!settings.llm) {
        speech.say('还没给我接上脑子……右键我 → 设置，填一下 DeepSeek 的 API Key。', { force: true });
      }
    }
    setIgnore(false);
    api.focusWindow();
    setTimeout(() => chatInput.focus(), 40);
  }

  function closeChat() {
    chatOpen = false;
    chatEl.classList.remove('open');
    chatInput.blur();
  }

  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text || waitingReply) return;
    chatInput.value = '';
    waitingReply = true;
    chatSend.disabled = true;
    machine.send('CHAT_START');
    let res;
    try {
      res = await api.chat(text);
    } catch (err) {
      reportError(err);
      res = { error: 'IPC', text: '……脑子卡了一下。' };
    }
    waitingReply = false;
    chatSend.disabled = false;
    if (res.error) {
      machine.send('SAY', {
        text: res.text || '……',
        actions: [{ type: 'gesture', name: 'resigned', emote: '…' }],
        force: true
      });
      if (res.error === 'NO_KEY' || res.error === 'AUTH') api.openSettings();
      return;
    }
    machine.send('SAY', { text: res.reply, actions: res.actions, force: true });
  }

  chatEl.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeChat();
  });
  chatInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (chatOpen && document.activeElement !== chatInput && !chatInput.value.trim()) closeChat();
    }, 150);
  });

  // ---------- input ----------

  let ignoring = true;
  function setIgnore(value) {
    if (value !== ignoring) {
      ignoring = value;
      api.setIgnoreMouse(value);
    }
  }

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) * canvas.width) / rect.width);
    const y = Math.floor(((clientY - rect.top) * canvas.height) / rect.height);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    const data = g.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 24) return true;
    }
    return false;
  }

  function overInteractive(clientX, clientY) {
    if (!chatOpen) return false;
    const el = document.elementFromPoint(clientX, clientY);
    return Boolean(el && el.closest('.interactive'));
  }

  const pointer = { down: false, dragging: false, startX: 0, startY: 0, lastX: 0, lastT: 0, vx: 0 };
  let clickTimer = null;

  window.addEventListener('pointermove', (e) => {
    if (!pointer.down) {
      setIgnore(!hitTest(e.clientX, e.clientY) && !overInteractive(e.clientX, e.clientY));
      return;
    }
    if (!pointer.dragging && Math.hypot(e.screenX - pointer.startX, e.screenY - pointer.startY) > 4) {
      pointer.dragging = true;
      pointer.lastX = e.screenX;
      pointer.lastT = e.timeStamp;
      machine.send('DRAG_START');
    }
    if (pointer.dragging) {
      const dt = Math.max(1, e.timeStamp - pointer.lastT) / 1000;
      pointer.vx = pointer.vx * 0.7 + ((e.screenX - pointer.lastX) / dt) * 0.3;
      pointer.lastX = e.screenX;
      pointer.lastT = e.timeStamp;
      fx.angleTarget = clamp(pointer.vx * 0.012, -MAX_SWAY_DEG, MAX_SWAY_DEG);
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!hitTest(e.clientX, e.clientY)) {
      if (!overInteractive(e.clientX, e.clientY)) setIgnore(true);
      return;
    }
    if (e.button !== 0) return;
    pointer.down = true;
    pointer.dragging = false;
    pointer.startX = e.screenX;
    pointer.startY = e.screenY;
    pointer.vx = 0;
    canvas.setPointerCapture(e.pointerId);
  });

  function handleClick() {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      openChat();
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      machine.send('POKE');
    }, DOUBLE_CLICK_MS);
  }

  function finishPointer(e, cancelled) {
    if (!pointer.down) return;
    const wasDragging = pointer.dragging;
    pointer.down = false;
    pointer.dragging = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_err) {
      /* already released */
    }
    if (wasDragging) machine.send('DRAG_END');
    else if (!cancelled) handleClick();
  }

  canvas.addEventListener('pointerup', (e) => {
    if (e.button === 0) finishPointer(e, false);
  });
  canvas.addEventListener('pointercancel', (e) => finishPointer(e, true));
  canvas.addEventListener('lostpointercapture', (e) => finishPointer(e, true));
  document.addEventListener('mouseleave', () => {
    if (!pointer.down) setIgnore(true);
  });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (hitTest(e.clientX, e.clientY)) api.showMenu();
  });

  api.on('pet:command', (cmd) => machine.send('CMD', cmd));
  api.on('pet:walk-blocked', (p) => machine.send('WALL', p));
  api.on('pet:airborne', () => machine.send('AIRBORNE'));
  api.on('pet:landed', (p) => machine.send('LANDED', p));
  api.on('pet:user-away', () => machine.send('USER_AWAY'));
  api.on('pet:user-back', () => machine.send('USER_BACK'));
  api.on('pet:say', (p) => machine.send('SAY', p));
  api.on('pet:layout', (next) => applyLayout(next));
  api.on('pet:settings', (next) => {
    settings = next;
    if (!settings.bubbles) speech.hide();
  });

  // ---------- loop ----------

  applyLayout(metrics);
  watchPixelRatio();
  machine.start('idle');

  let last = performance.now();
  function tick(now) {
    const dtMs = Math.min(100, now - last);
    last = now;
    const dt = dtMs / 1000;
    try {
      ctx.mood = Math.max(0, ctx.mood - 0.18 * dt);
      machine.update(dt);
      anim.update(dtMs);
      const fxChanged = stepFx(dt);
      if (anim.dirty || fxChanged) {
        draw();
        anim.dirty = false;
      }
      debug.clip = anim.clip.name;
      debug.frame = anim.index;
      debug.mood = Number(ctx.mood.toFixed(2));
      debug.chatOpen = chatOpen;
    } catch (err) {
      reportError(err);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  setTimeout(() => speech.say(pick(LINES.greet)), 700);
  debug.ready = true;
  if (init.verify) {
    window.__PET_TEST__ = { openChat, sendChat, setChatText: (t) => { chatInput.value = t; } };
  }
  await api.reportReady();
})().catch(reportError);
