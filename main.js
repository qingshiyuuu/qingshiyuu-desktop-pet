'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, powerMonitor,
  clipboard, dialog, shell, safeStorage
} = require('electron');
const path = require('path');
const fs = require('fs');
const { PetAgent } = require('./llm');
const { ProactiveScheduler } = require('./proactive');

const APP_ID = 'local.redhair.desktoppet';
const APP_NAME = '卿诗雨';
const ASSET_DIR = path.join(__dirname, 'assets', 'actions');
const LOGS_DIR = app.isPackaged
  ? path.join(app.getPath('temp'), 'CrimsonPet-verify')
  : path.join(__dirname, 'logs');
const VERIFY = process.argv.includes('--verify');

const SIZES = {
  small: { label: '小', height: 320 },
  medium: { label: '中', height: 420 },
  large: { label: '大', height: 520 },
  huge: { label: '特大', height: 640 }
};
const CELL_ASPECT = 512 / 768;
const BUBBLE_SPACE = 150;
const MIN_WINDOW_WIDTH = 300;
const WALK_SPEED_PER_HEIGHT = 0.5;

const PHYSICS = {
  gravity: 2600,
  airDrag: 1.4,
  wallBounce: 0.45,
  floorBounce: 0.22,
  bounceThreshold: 700,
  maxThrow: 2600,
  sampleWindowMs: 90
};

const USER_AWAY_SECONDS = 180;

const DEFAULT_SETTINGS = {
  size: 'medium',
  autonomous: true,
  bubbles: true,
  alwaysOnTop: true,
  x: null,
  displayId: null,
  apiKeyEnc: null,
  apiKeyPlain: null,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  nickname: '',
  proactive: 'occasional'
};

const PROACTIVE_LABELS = { off: '关闭', occasional: '偶尔', chatty: '话痨' };

app.setAppUserModelId(APP_ID);
if (VERIFY) {
  app.setPath('userData', path.join(LOGS_DIR, 'verify-userdata'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let agent = null;
let scheduler = null;
let verifyConfig = null;
let settings = { ...DEFAULT_SETTINGS };
let metrics = metricsFor(settings.size);
let stateLabel = '发呆';
let userAway = false;
const errors = [];

const motion = {
  mode: 'none',
  x: 0,
  y: 0,
  dir: 1,
  vx: 0,
  vy: 0,
  grab: { x: 0, y: 0 },
  samples: [],
  fallTop: 0,
  impact: 0,
  bounces: 0
};
let ticker = null;
let lastTick = 0;

function recordError(source, message) {
  errors.push({ source, message: String(message), at: new Date().toISOString() });
  console.error(`[${source}]`, message);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------- settings ----------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw };
    if (!SIZES[settings.size]) settings.size = DEFAULT_SETTINGS.size;
  } catch (_err) {
    settings = { ...DEFAULT_SETTINGS };
  }
}

let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 400);
}

function saveSettingsNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    recordError('settings', err);
  }
}

function rememberPosition() {
  if (!alive()) return;
  settings.x = Math.round(motion.x);
  settings.displayId = screen.getDisplayMatching(mainWindow.getBounds()).id;
  saveSettingsSoon();
}

function updateSettings(patch) {
  const sizeChanged = patch.size && patch.size !== settings.size;
  settings = { ...settings, ...patch };
  saveSettingsSoon();
  if (sizeChanged) applySize();
  if ('alwaysOnTop' in patch && alive()) applyAlwaysOnTop();
  if ('proactive' in patch && scheduler) scheduler.reschedule();
  send('pet:settings', publicSettings());
  refreshTray();
}

function publicSettings() {
  return {
    autonomous: settings.autonomous,
    bubbles: settings.bubbles,
    size: settings.size,
    llm: Boolean(llmConfig().apiKey)
  };
}

// ---------- LLM config (API key is encrypted with the OS keychain when available) ----------

function readApiKey() {
  if (settings.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, 'base64'));
    } catch (_err) {
      return '';
    }
  }
  return settings.apiKeyPlain || '';
}

function storeApiKey(key) {
  const clean = String(key || '').trim();
  if (!clean) {
    settings.apiKeyEnc = null;
    settings.apiKeyPlain = null;
  } else if (safeStorage.isEncryptionAvailable()) {
    settings.apiKeyEnc = safeStorage.encryptString(clean).toString('base64');
    settings.apiKeyPlain = null;
  } else {
    settings.apiKeyEnc = null;
    settings.apiKeyPlain = clean;
  }
}

function llmConfig() {
  if (verifyConfig) return verifyConfig;
  return {
    apiKey: readApiKey(),
    baseUrl: settings.baseUrl || DEFAULT_SETTINGS.baseUrl,
    model: settings.model || DEFAULT_SETTINGS.model,
    nickname: settings.nickname || ''
  };
}

function settingsView() {
  const key = readApiKey();
  return {
    hasKey: Boolean(key),
    keyHint: key ? `${key.slice(0, 5)}••••${key.slice(-4)}` : '',
    baseUrl: settings.baseUrl,
    model: settings.model,
    nickname: settings.nickname,
    proactive: settings.proactive,
    memory: agent ? agent.memory.map((m) => m.fact) : [],
    historyCount: agent ? agent.history.length : 0
  };
}

function sayToPet(text, actions = [], extra = {}) {
  send('pet:say', { text, actions, ...extra });
}

// ---------- geometry ----------

function metricsFor(sizeKey) {
  const cellHeight = SIZES[sizeKey].height;
  const cellWidth = Math.round(cellHeight * CELL_ASPECT);
  return {
    cellWidth,
    cellHeight,
    width: Math.max(MIN_WINDOW_WIDTH, cellWidth),
    height: cellHeight + BUBBLE_SPACE,
    bubbleSpace: BUBBLE_SPACE,
    walkSpeed: Math.round(cellHeight * WALK_SPEED_PER_HEIGHT)
  };
}

function alive() {
  return mainWindow && !mainWindow.isDestroyed();
}

function send(channel, payload) {
  if (alive() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function currentArea() {
  const rect = { x: Math.round(motion.x), y: Math.round(motion.y), width: metrics.width, height: metrics.height };
  return screen.getDisplayMatching(rect).workArea;
}

function floorY(area) {
  return area.y + area.height - metrics.height;
}

// The window is wider than the visible figure, so it may hang slightly past the screen edge.
function horizontalLimits(area) {
  const slack = Math.round((metrics.width - metrics.cellWidth * 0.5) / 2);
  return { min: area.x - slack, max: area.x + area.width - metrics.width + slack };
}

function applyPosition() {
  if (!alive()) return;
  // setBounds instead of setPosition: avoids size drift at fractional DPI scales on Windows.
  mainWindow.setBounds({
    x: Math.round(motion.x),
    y: Math.round(motion.y),
    width: metrics.width,
    height: metrics.height
  });
}

function snapToFloor() {
  const area = currentArea();
  const lim = horizontalLimits(area);
  motion.x = clamp(motion.x, lim.min, lim.max);
  motion.y = floorY(area);
  applyPosition();
}

function initialPosition() {
  const displays = screen.getAllDisplays();
  const saved = displays.find((d) => d.id === settings.displayId);
  const display = saved || screen.getPrimaryDisplay();
  const area = display.workArea;
  const lim = horizontalLimits(area);
  const fallbackX = area.x + area.width - metrics.width - 24;
  const x = Number.isFinite(settings.x) && saved ? settings.x : fallbackX;
  motion.x = clamp(x, lim.min, lim.max);
  motion.y = floorY(area);
}

function resetPosition() {
  stopMotion();
  const area = screen.getPrimaryDisplay().workArea;
  motion.x = area.x + area.width - metrics.width - 24;
  motion.y = floorY(area);
  applyPosition();
  rememberPosition();
}

function applySize() {
  const centerX = motion.x + metrics.width / 2;
  metrics = metricsFor(settings.size);
  motion.x = centerX - metrics.width / 2;
  snapToFloor();
  send('pet:layout', metrics);
}

function applyAlwaysOnTop() {
  if (settings.alwaysOnTop) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
}

// ---------- motion: walk / drag / fall ----------

function ensureTicker() {
  if (ticker) return;
  lastTick = performance.now();
  ticker = setInterval(stepMotion, 16);
}

function stopMotion() {
  motion.mode = 'none';
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function stepMotion() {
  if (!alive()) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  if (motion.mode === 'walk') stepWalk(dt);
  else if (motion.mode === 'drag') stepDrag(now);
  else if (motion.mode === 'fall') stepFall(dt);
  if (motion.mode === 'none') stopMotion();
}

function startWalk(requestedDir) {
  const area = currentArea();
  const lim = horizontalLimits(area);
  let dir = requestedDir;
  if (dir !== 1 && dir !== -1) {
    const ratio = (motion.x - lim.min) / Math.max(1, lim.max - lim.min);
    dir = Math.random() < ratio ? -1 : 1;
  }
  motion.dir = dir;
  motion.y = floorY(area);
  motion.mode = 'walk';
  ensureTicker();
  return dir;
}

function stepWalk(dt) {
  const area = currentArea();
  const lim = horizontalLimits(area);
  motion.x += motion.dir * metrics.walkSpeed * dt;
  motion.y = floorY(area);
  if (motion.x <= lim.min || motion.x >= lim.max) {
    motion.x = clamp(motion.x, lim.min, lim.max);
    applyPosition();
    motion.mode = 'none';
    rememberPosition();
    send('pet:walk-blocked', { dir: motion.dir });
    return;
  }
  applyPosition();
}

function stopWalk() {
  if (motion.mode === 'walk') {
    motion.mode = 'none';
    rememberPosition();
  }
}

function startDrag() {
  const cursor = screen.getCursorScreenPoint();
  motion.grab = { x: cursor.x - motion.x, y: cursor.y - motion.y };
  motion.samples = [{ t: performance.now(), x: cursor.x, y: cursor.y }];
  motion.mode = 'drag';
  ensureTicker();
}

function stepDrag(now) {
  const cursor = screen.getCursorScreenPoint();
  motion.x = cursor.x - motion.grab.x;
  motion.y = cursor.y - motion.grab.y;
  motion.samples.push({ t: now, x: cursor.x, y: cursor.y });
  while (motion.samples.length > 2 && now - motion.samples[0].t > PHYSICS.sampleWindowMs) {
    motion.samples.shift();
  }
  applyPosition();
}

function endDrag() {
  if (motion.mode !== 'drag') return;
  const s = motion.samples;
  let vx = 0;
  let vy = 0;
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    const span = (last.t - first.t) / 1000;
    if (span > 0.02) {
      vx = clamp((last.x - first.x) / span, -PHYSICS.maxThrow, PHYSICS.maxThrow);
      vy = clamp((last.y - first.y) / span, -PHYSICS.maxThrow, PHYSICS.maxThrow);
    }
  }
  startFall(vx, vy);
}

function startFall(vx, vy) {
  motion.vx = vx;
  motion.vy = vy;
  motion.fallTop = motion.y;
  motion.impact = 0;
  motion.bounces = 0;
  motion.mode = 'fall';
  if (motion.y < floorY(currentArea()) - 2) send('pet:airborne');
  ensureTicker();
}

function stepFall(dt) {
  const area = currentArea();
  const lim = horizontalLimits(area);
  const floor = floorY(area);
  const ceiling = area.y - metrics.bubbleSpace;

  motion.vy += PHYSICS.gravity * dt;
  motion.vx *= Math.exp(-PHYSICS.airDrag * dt);
  motion.x += motion.vx * dt;
  motion.y += motion.vy * dt;
  motion.fallTop = Math.min(motion.fallTop, motion.y);

  if (motion.x < lim.min || motion.x > lim.max) {
    motion.x = clamp(motion.x, lim.min, lim.max);
    motion.vx = -motion.vx * PHYSICS.wallBounce;
  }
  if (motion.y < ceiling) {
    motion.y = ceiling;
    motion.vy = Math.max(0, motion.vy);
  }
  if (motion.y >= floor) {
    motion.y = floor;
    motion.impact = Math.max(motion.impact, motion.vy);
    if (motion.vy > PHYSICS.bounceThreshold && motion.bounces < 2) {
      motion.vy = -motion.vy * PHYSICS.floorBounce;
      motion.vx *= 0.6;
      motion.bounces += 1;
    } else {
      motion.mode = 'none';
      applyPosition();
      rememberPosition();
      send('pet:landed', {
        height: Math.round(floor - motion.fallTop),
        speed: Math.round(motion.impact)
      });
      return;
    }
  }
  applyPosition();
}

// ---------- tray & menu ----------

function createTrayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  if (icon.isEmpty()) return nativeImage.createEmpty();
  return icon.resize({ width: 32, height: 32, quality: 'best' });
}

function command(cmd) {
  send('pet:command', cmd);
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: `${APP_NAME} · ${stateLabel}`, enabled: false },
    { type: 'separator' },
    { label: '和她聊天…', click: () => command({ type: 'chat' }) },
    {
      label: '主动搭话',
      submenu: Object.entries(PROACTIVE_LABELS).map(([key, label]) => ({
        label,
        type: 'radio',
        checked: settings.proactive === key,
        click: () => updateSettings({ proactive: key })
      }))
    },
    { label: '设置…', click: openSettingsWindow },
    { type: 'separator' },
    { label: '思考一下', click: () => command({ type: 'gesture', name: 'think' }) },
    { label: '无奈摊手', click: () => command({ type: 'gesture', name: 'resigned' }) },
    { label: '佯装生气', click: () => command({ type: 'gesture', name: 'mock_angry' }) },
    { label: '抽根烟', click: () => command({ type: 'gesture', name: 'idle.smoke' }) },
    {
      label: '散步',
      submenu: [
        { label: '向左走', click: () => command({ type: 'walk', dir: -1 }) },
        { label: '向右走', click: () => command({ type: 'walk', dir: 1 }) },
        { label: '停下', click: () => command({ type: 'stop' }) }
      ]
    },
    { type: 'separator' },
    {
      label: '自由活动',
      type: 'checkbox',
      checked: settings.autonomous,
      click: (item) => updateSettings({ autonomous: item.checked })
    },
    {
      label: '对话气泡',
      type: 'checkbox',
      checked: settings.bubbles,
      click: (item) => updateSettings({ bubbles: item.checked })
    },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => updateSettings({ alwaysOnTop: item.checked })
    },
    {
      label: '大小',
      submenu: Object.entries(SIZES).map(([key, size]) => ({
        label: size.label,
        type: 'radio',
        checked: settings.size === key,
        click: () => updateSettings({ size: key })
      }))
    },
    { label: '回到右下角', click: resetPosition },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`${APP_NAME} · ${stateLabel}`);
  tray.setContextMenu(buildMenu());
}

// ---------- assets ----------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadManifest() {
  const index = readJson(path.join(ASSET_DIR, 'actions.json'));
  const actions = {};
  for (const [name, action] of Object.entries(index.actions)) {
    actions[name] = {
      label: action.label,
      image: `../assets/actions/${action.sprites.compact}`,
      atlas: readJson(path.join(ASSET_DIR, action.atlases.compact))
    };
  }
  return {
    actions,
    aliases: index.aliases,
    transitions: index.recommendedTransitions
  };
}

// ---------- window ----------

function createWindow() {
  initialPosition();
  const win = new BrowserWindow({
    x: Math.round(motion.x),
    y: Math.round(motion.y),
    width: metrics.width,
    height: metrics.height,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: VERIFY
    }
  });

  win.setMenu(null);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      recordError('console', `${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => recordError('did-fail-load', `${code} ${desc} ${url}`));
  win.webContents.on('preload-error', (_e, file, err) => recordError('preload', `${file}: ${err}`));
  win.webContents.on('render-process-gone', (_e, details) => recordError('render-process-gone', JSON.stringify(details)));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.once('ready-to-show', () => {
    win.showInactive();
    mainWindow = win;
    applyAlwaysOnTop();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  return win;
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 780,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    title: `${APP_NAME} · 设置`,
    icon: createTrayIcon(),
    backgroundColor: '#17110f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow.setMenu(null);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
}

function createAgent() {
  agent = new PetAgent({
    dataDir: app.getPath('userData'),
    getConfig: llmConfig,
    petState: () => stateLabel,
    say: (text, actions, extra) => sayToPet(text, actions, extra),
    readClipboard: () => clipboard.readText(),
    confirmOpenUrl: async (url) => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['打开', '不要'],
        defaultId: 0,
        cancelId: 1,
        title: APP_NAME,
        message: '她想帮你打开这个网页：',
        detail: url
      });
      if (response !== 0) return false;
      await shell.openExternal(url);
      return true;
    }
  });

  scheduler = new ProactiveScheduler({
    level: () => (llmConfig().apiKey ? settings.proactive : 'off'),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    petIsIdle: () => stateLabel === '发呆',
    canTalk: () => alive() && !agent.busy,
    speak: async (reason, context) => {
      const result = await agent.proactive(reason, context);
      if (result) sayToPet(result.reply, result.actions);
    }
  });
}

function describeLlmError(err) {
  if (err.message === 'NO_KEY') return { code: 'NO_KEY', text: '还没给我接上脑子……先去设置里填一下 DeepSeek 的 API Key。' };
  if (err.status === 401) return { code: 'AUTH', text: 'API Key 好像不对……你再检查一下？' };
  if (err.status === 402) return { code: 'BALANCE', text: 'DeepSeek 说余额不足了。该充钱了，老板。' };
  if (err.status === 429) return { code: 'RATE', text: '说太快了，让我歇口气。' };
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return { code: 'TIMEOUT', text: '想了太久没想出来……网络是不是不太好？' };
  return { code: 'NETWORK', text: '脑子断线了……网络好像有点问题。' };
}

function watchUserPresence() {
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime();
    if (!userAway && idle >= USER_AWAY_SECONDS) {
      userAway = true;
      send('pet:user-away');
      if (scheduler) scheduler.userAway();
    } else if (userAway && idle < 4) {
      userAway = false;
      send('pet:user-back');
      if (scheduler) scheduler.userBack();
    }
  }, 4000);
}

function watchDisplays() {
  const resnap = () => {
    if (motion.mode === 'none' || motion.mode === 'walk') snapToFloor();
  };
  screen.on('display-metrics-changed', resnap);
  screen.on('display-removed', resnap);
  screen.on('display-added', resnap);
}

// ---------- IPC ----------

ipcMain.handle('pet:init', () => ({
  manifest: loadManifest(),
  metrics,
  settings: publicSettings(),
  verify: VERIFY
}));

ipcMain.on('pet:menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  buildMenu().popup({ window: win || undefined });
});

ipcMain.on('pet:ignore-mouse', (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || motion.mode === 'drag') return;
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});

ipcMain.handle('pet:walk', (_event, dir) => startWalk(dir));
ipcMain.on('pet:walk-stop', () => stopWalk());

ipcMain.on('pet:drag-start', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setIgnoreMouseEvents(false);
  startDrag();
});
ipcMain.on('pet:drag-end', () => endDrag());

ipcMain.on('pet:state', (_event, label) => {
  if (typeof label === 'string' && label !== stateLabel) {
    stateLabel = label;
    if (tray) tray.setToolTip(`${APP_NAME} · ${stateLabel}`);
  }
});

ipcMain.on('pet:error', (_event, message) => recordError('renderer', message));

ipcMain.on('pet:focus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setIgnoreMouseEvents(false);
  win.focus();
});

ipcMain.on('pet:open-settings', () => openSettingsWindow());

ipcMain.handle('pet:chat', async (_event, text) => {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return { error: 'EMPTY' };
  if (!agent.hasKey()) return { error: 'NO_KEY', text: describeLlmError(new Error('NO_KEY')).text };
  try {
    const result = await agent.chat(clean);
    if (result.error === 'BUSY') return { error: 'BUSY', text: '等等，我上一句还没想完。' };
    return { reply: result.reply || '……', actions: result.actions };
  } catch (err) {
    recordError('llm', err.message);
    const info = describeLlmError(err);
    return { error: info.code, text: info.text };
  }
});

ipcMain.handle('settings:get', () => settingsView());

ipcMain.handle('settings:save', (_event, patch = {}) => {
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) storeApiKey(patch.apiKey);
  if (patch.clearKey) storeApiKey('');
  const next = {};
  if (typeof patch.baseUrl === 'string' && /^https?:\/\//i.test(patch.baseUrl.trim())) next.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
  if (typeof patch.nickname === 'string') next.nickname = patch.nickname.trim().slice(0, 20);
  if (PROACTIVE_LABELS[patch.proactive]) next.proactive = patch.proactive;
  updateSettings(next);
  return settingsView();
});

ipcMain.handle('settings:test', async () => {
  try {
    return { ok: true, text: await agent.testConnection() };
  } catch (err) {
    return { ok: false, text: describeLlmError(err).text, detail: err.message };
  }
});

ipcMain.handle('settings:clear-memory', () => {
  agent.clearMemory();
  return settingsView();
});

ipcMain.handle('settings:clear-history', () => {
  agent.clearHistory();
  return settingsView();
});

ipcMain.on('settings:open-link', (_event, url) => {
  if (url === 'https://platform.deepseek.com/api_keys') shell.openExternal(url);
});

ipcMain.handle('pet:ready', (event) => {
  if (VERIFY) {
    runVerify(BrowserWindow.fromWebContents(event.sender)).catch((err) => {
      recordError('verify', err && err.stack ? err.stack : err);
      writeVerify({ aborted: true });
      app.quit();
    });
  }
  return { ok: true };
});

// ---------- self check (electron . --verify) ----------

function writeVerify(extra) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LOGS_DIR, 'verify.json'),
    JSON.stringify({ at: new Date().toISOString(), electron: process.versions.electron, errors, ...extra }, null, 2),
    'utf8'
  );
}

async function runVerify(win) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shots = [];
  const snap = async (name) => {
    const image = await win.capturePage();
    fs.writeFileSync(path.join(LOGS_DIR, `verify-${name}.png`), image.toPNG());
    shots.push(name);
  };
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOGS_DIR, 'verify-tray.png'), createTrayIcon().resize({ width: 64, height: 64 }).toPNG());

  await wait(1500);
  await snap('idle');
  for (const name of ['think', 'resigned', 'mock_angry']) {
    command({ type: 'gesture', name });
    await wait(1000);
    await snap(name);
  }
  command({ type: 'walk', dir: -1 });
  await wait(900);
  await snap('walk-left');
  command({ type: 'walk', dir: 1 });
  await wait(900);
  await snap('walk-right');
  command({ type: 'stop' });
  await wait(400);

  motion.y -= 320;
  applyPosition();
  startFall(500, -400);
  await wait(250);
  await snap('falling');
  await wait(2200);
  await snap('landed');
  await wait(1500);

  const js = (code) => win.webContents.executeJavaScript(code);
  await js('__PET_TEST__.openChat()');
  await wait(300);
  await js('__PET_TEST__.setChatText("你今天想我了吗")');
  await snap('chat-open');
  const sending = js('__PET_TEST__.sendChat()');
  await wait(120);
  await snap('chat-thinking');
  await sending;
  await wait(1400);
  await snap('chat-reply');
  await wait(6000);

  const proactiveResult = await agent.proactive('用户离开电脑约 12 分钟，刚刚回来', '测试上下文');
  if (proactiveResult) sayToPet(proactiveResult.reply, proactiveResult.actions);
  await wait(1500);
  await snap('proactive');

  openSettingsWindow();
  await wait(1500);
  if (settingsWindow) {
    const image = await settingsWindow.capturePage();
    fs.writeFileSync(path.join(LOGS_DIR, 'verify-settings.png'), image.toPNG());
    shots.push('settings');
  }
  const llm = { history: agent.history, memory: agent.memory, requests: mockRequests.length };

  const debug = await win.webContents.executeJavaScript(
    'window.__PET_DEBUG__ ? JSON.parse(JSON.stringify(window.__PET_DEBUG__)) : null'
  );
  writeVerify({ shots, bounds: win.getBounds(), metrics, debug, llm });
  app.quit();
}

// OpenAI-compatible fake used only by --verify: first turn calls tools, second turn replies.
const mockRequests = [];
function startMockLlm() {
  const http = require('http');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        mockRequests.push(payload);
        const messages = payload.messages || [];
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const toolDone = messages[messages.length - 1] && messages[messages.length - 1].role === 'tool';
        let message;
        if (lastUser && lastUser.content.includes('系统事件')) {
          message = { role: 'assistant', content: '哟，回来了？我还以为你把我忘了。' };
        } else if (!toolDone) {
          message = {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'play_action', arguments: '{"name":"mock_angry","emote":"❤"}' } },
              { id: 'c2', type: 'function', function: { name: 'remember', arguments: '{"fact":"用户喜欢问我有没有想他"}' } }
            ]
          };
        } else {
          message = { role: 'assistant', content: '哼，才、才没有想你呢。只是刚好闲着而已。你别多想啊，我只是随口一说。' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// ---------- lifecycle ----------

if (gotLock) {
  app.on('second-instance', () => {
    if (alive()) {
      mainWindow.showInactive();
      applyAlwaysOnTop();
    }
  });

  app.whenReady().then(async () => {
    if (VERIFY) {
      for (const name of ['settings.json', 'chat-history.json', 'memory.json', 'reminders.json']) {
        fs.rmSync(path.join(app.getPath('userData'), name), { force: true });
      }
      const port = await startMockLlm();
      verifyConfig = { apiKey: 'verify', baseUrl: `http://127.0.0.1:${port}`, model: 'mock', nickname: '' };
    }
    loadSettings();
    metrics = metricsFor(settings.size);
    createAgent();
    mainWindow = createWindow();
    tray = new Tray(createTrayIcon());
    refreshTray();
    tray.on('click', () => {
      if (alive()) {
        mainWindow.showInactive();
        applyAlwaysOnTop();
      }
    });
    watchUserPresence();
    watchDisplays();
  });
}

app.on('before-quit', () => {
  stopMotion();
  if (scheduler) scheduler.dispose();
  if (alive()) rememberPosition();
  saveSettingsNow();
});

app.on('window-all-closed', () => app.quit());
