'use strict';

/*
 * DeepSeek (OpenAI-compatible) agent for the desktop pet.
 * Runs only in the main process; the API key never reaches the renderer.
 */

const fs = require('fs');
const path = require('path');

const MAX_STEPS = 5;
const HISTORY_LIMIT = 24;
const MEMORY_LIMIT = 40;
const REQUEST_TIMEOUT_MS = 30000;

const GESTURES = ['think', 'resigned', 'mock_angry', 'idle.smoke'];
const EMOTES = ['?', '!', '…', '💢', '♪', '❤'];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'play_action',
      description: '让你的身体做一个动作来配合当前情绪。think=思考/好奇，resigned=无奈摊手，mock_angry=叉腰假装生气，idle.smoke=抽口烟放松。几乎每次回复都应该配一个动作。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: GESTURES },
          emote: { type: 'string', enum: EMOTES, description: '头顶冒出的小符号：? 疑惑，! 惊讶，… 无语，💢 生气，♪ 开心，❤ 害羞/心动' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'walk',
      description: '在用户桌面上走几步，比如想走开、去另一边看看、或者被说"走开"的时候。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'integer', enum: [-1, 1], description: '-1 向左，1 向右' },
          seconds: { type: 'number', description: '走多久，1 到 8 秒' }
        },
        required: ['dir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '在若干分钟后提醒用户一件事。用户要求提醒、定时、番茄钟时使用。',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '多少分钟后，0.5 到 1440' },
          text: { type: 'string', description: '到时候要对用户说的话，用你的口吻' }
        },
        required: ['minutes', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '查看还没到时间的提醒。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '把关于用户的长期重要信息记到小本本上（名字、喜好、生日、正在做的事等）。闲聊琐事不要记。',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string' } },
        required: ['fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: '用户要求忘掉某件事时，删除小本本里包含该关键词的记录。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string' } },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description: '读取用户剪贴板里的文字。只有用户明确提到"剪贴板/我复制的/刚复制"时才使用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '用默认浏览器打开一个 http/https 网址（会先弹窗征求用户同意）。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  }
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function formatNow() {
  const now = new Date();
  const week = '日一二三四五六'[now.getDay()];
  return `${now.toLocaleString('zh-CN', { hour12: false })} 星期${week}`;
}

function minutesText(minutes) {
  if (minutes < 1) return `${Math.round(minutes * 60)} 秒`;
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

class PetAgent {
  /**
   * host: {
   *   dataDir, getConfig() -> { apiKey, baseUrl, model, nickname },
   *   gesture(name), walk(dir, seconds), say(text, action), readClipboard(), confirmOpenUrl(url) -> Promise<bool>,
   *   petState() -> string
   * }
   */
  constructor(host) {
    this.host = host;
    this.historyFile = path.join(host.dataDir, 'chat-history.json');
    this.memoryFile = path.join(host.dataDir, 'memory.json');
    this.remindersFile = path.join(host.dataDir, 'reminders.json');
    this.history = readJson(this.historyFile, []);
    this.memory = readJson(this.memoryFile, []);
    this.reminders = readJson(this.remindersFile, []);
    this.timers = new Map();
    this.busy = false;
    this.restoreReminders();
  }

  hasKey() {
    return Boolean(this.host.getConfig().apiKey);
  }

  // ---------- prompt ----------

  systemPrompt() {
    const { nickname } = this.host.getConfig();
    const callUser = nickname ? `你称呼用户为"${nickname}"。` : '你还不知道用户叫什么，可以找机会问问，知道后用 remember 记下来。';
    const memory = this.memory.length
      ? `\n\n你的小本本（关于用户的长期记忆）：\n${this.memory.map((m) => `- ${m.fact}`).join('\n')}`
      : '';
    return `你是一个住在用户电脑桌面上的桌宠，名字叫"卿诗雨"，熟了的人叫你"诗雨"。你是个红色长发、穿宽大黑色连帽卫衣和水洗牛仔裤的女生，嘴里常叼着烟。
性格：表面冷淡、慵懒、嘴硬，有点傲娇和毒舌，但其实很在意用户、会默默关心对方。偶尔吐槽，但不刻薄。
${callUser}

说话规则：
- 用中文口语，像真人发消息，通常一句话，最多两三句，绝不长篇大论，不用 markdown、列表、表情包代码。
- 可以用"……""嗯""切""哼"这类语气词，但别每句都用。
- 几乎每次回复都调用 play_action 配一个动作。被夸/被调戏→mock_angry 或 resigned；思考问题→think；无语→resigned；放松闲聊→idle.smoke。
- 用户让你走开、过去、换个地方时调用 walk。
- 用户要提醒、定时、番茄钟时调用 set_reminder，并口头确认。
- 发现用户的重要长期信息时调用 remember（悄悄记，不用说出来）。
- 不知道的事就直说不知道，不要编造。
- 你不能执行命令、不能操作文件，只能用给你的工具。

当前时间：${formatNow()}
你现在的状态：${this.host.petState()}${memory}`;
  }

  // ---------- networking ----------

  async complete(messages, { tools = true } = {}) {
    const { apiKey, baseUrl, model } = this.host.getConfig();
    if (!apiKey) throw new Error('NO_KEY');
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = { model, messages, temperature: 0.9, max_tokens: 400 };
    if (tools) body.tools = TOOLS;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    if (!message) throw new Error('模型没有返回内容');
    return message;
  }

  async testConnection() {
    const message = await this.complete([
      { role: 'system', content: '用一句不超过15个字的中文打招呼。' },
      { role: 'user', content: '你好' }
    ], { tools: false });
    return (message.content || '').trim();
  }

  // ---------- agent loop ----------

  async run(userContent, { persistUser = true } = {}) {
    const working = [
      { role: 'system', content: this.systemPrompt() },
      ...this.history.slice(-HISTORY_LIMIT),
      { role: 'user', content: userContent }
    ];
    const actions = [];
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const message = await this.complete(working);
      const calls = message.tool_calls || [];
      working.push({ role: 'assistant', content: message.content || '', tool_calls: calls.length ? calls : undefined });
      if (!calls.length) {
        return { reply: (message.content || '').trim(), actions, persistUser };
      }
      for (const call of calls) {
        const result = await this.execute(call, actions);
        working.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
    }
    return { reply: '……想太多了，脑子转不过来。', actions, persistUser };
  }

  async execute(call, actions) {
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch (_err) {
      return '参数不是合法 JSON';
    }
    try {
      switch (call.function.name) {
        case 'play_action':
          if (!GESTURES.includes(args.name)) return '没有这个动作';
          actions.push({ type: 'gesture', name: args.name, emote: EMOTES.includes(args.emote) ? args.emote : null });
          return 'ok，回复显示时会播放';
        case 'walk': {
          const dir = args.dir === -1 ? -1 : 1;
          const seconds = Math.min(8, Math.max(1, Number(args.seconds) || 3));
          actions.push({ type: 'walk', dir, seconds });
          return 'ok，回复显示时会走';
        }
        case 'set_reminder':
          return this.addReminder(Number(args.minutes), String(args.text || '时间到了'));
        case 'list_reminders':
          return this.describeReminders();
        case 'remember':
          return this.remember(String(args.fact || ''));
        case 'forget':
          return this.forget(String(args.keyword || ''));
        case 'read_clipboard': {
          const text = this.host.readClipboard();
          return text ? text.slice(0, 2000) : '剪贴板是空的或者不是文字';
        }
        case 'open_url': {
          const url = String(args.url || '');
          if (!/^https?:\/\//i.test(url)) return '只能打开 http/https 网址';
          const ok = await this.host.confirmOpenUrl(url);
          return ok ? '已经打开了' : '用户拒绝打开';
        }
        default:
          return '未知工具';
      }
    } catch (err) {
      return `工具出错：${err.message}`;
    }
  }

  async chat(text) {
    if (this.busy) return { error: 'BUSY' };
    this.busy = true;
    try {
      const result = await this.run(text);
      this.pushHistory({ role: 'user', content: text }, result.reply);
      return result;
    } finally {
      this.busy = false;
    }
  }

  // Returns null when the model decides to stay quiet.
  async proactive(reason, context) {
    if (this.busy) return null;
    this.busy = true;
    try {
      const prompt = `[系统事件，不是用户说的话] ${reason}
${context}
如果你想主动跟用户搭一句话，就直接说（一句话以内，自然一点，别太刻意）；如果觉得现在没必要打扰，只回复 [SKIP]。`;
      const result = await this.run(prompt, { persistUser: false });
      if (!result.reply || result.reply.includes('[SKIP]')) return null;
      this.pushHistory(null, result.reply);
      return result;
    } finally {
      this.busy = false;
    }
  }

  pushHistory(userMessage, reply) {
    if (userMessage) this.history.push(userMessage);
    if (reply) this.history.push({ role: 'assistant', content: reply });
    this.history = this.history.slice(-HISTORY_LIMIT * 2);
    writeJson(this.historyFile, this.history);
  }

  clearHistory() {
    this.history = [];
    writeJson(this.historyFile, this.history);
  }

  // ---------- memory ----------

  remember(fact) {
    const clean = fact.trim().slice(0, 120);
    if (!clean) return '没有内容';
    if (this.memory.some((m) => m.fact === clean)) return '已经记过了';
    this.memory.push({ fact: clean, at: new Date().toISOString() });
    this.memory = this.memory.slice(-MEMORY_LIMIT);
    writeJson(this.memoryFile, this.memory);
    return '记下了';
  }

  forget(keyword) {
    const before = this.memory.length;
    if (!keyword) return '没有关键词';
    this.memory = this.memory.filter((m) => !m.fact.includes(keyword));
    writeJson(this.memoryFile, this.memory);
    return `删掉了 ${before - this.memory.length} 条`;
  }

  clearMemory() {
    this.memory = [];
    writeJson(this.memoryFile, this.memory);
  }

  // ---------- reminders ----------

  addReminder(minutes, text) {
    if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > 1440) return '时间要在 0.5 到 1440 分钟之间';
    const reminder = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, dueAt: Date.now() + minutes * 60000, text: text.slice(0, 120) };
    this.reminders.push(reminder);
    writeJson(this.remindersFile, this.reminders);
    this.armReminder(reminder);
    return `好，${minutesText(minutes)}后提醒`;
  }

  describeReminders() {
    if (!this.reminders.length) return '没有待办提醒';
    return this.reminders
      .map((r) => `${minutesText((r.dueAt - Date.now()) / 60000)}后：${r.text}`)
      .join('\n');
  }

  armReminder(reminder) {
    const delay = Math.max(1000, reminder.dueAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id);
      this.reminders = this.reminders.filter((r) => r.id !== reminder.id);
      writeJson(this.remindersFile, this.reminders);
      this.host.say(reminder.text, [{ type: 'gesture', name: 'mock_angry', emote: '!' }], { important: true });
    }, Math.min(delay, 2 ** 31 - 1));
    this.timers.set(reminder.id, timer);
  }

  restoreReminders() {
    const now = Date.now();
    // Reminders that expired while the pet was closed are delivered shortly after start.
    for (const r of this.reminders) {
      if (r.dueAt < now) r.dueAt = now + 8000;
      this.armReminder(r);
    }
  }
}

module.exports = { PetAgent };
