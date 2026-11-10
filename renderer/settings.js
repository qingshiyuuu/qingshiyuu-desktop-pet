'use strict';

(async function settingsPage() {
  const api = window.settingsApi;
  const $ = (id) => document.getElementById(id);
  const keyInput = $('api-key');
  let toastTimer = null;

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function render(view) {
    keyInput.value = '';
    keyInput.placeholder = view.hasKey ? `已保存：${view.keyHint}（留空表示不修改）` : 'sk-…';
    const badge = $('brain-badge');
    badge.textContent = view.hasKey ? '已接入' : '未连接';
    badge.classList.toggle('on', view.hasKey);
    $('model').value = view.model;
    $('base-url').value = view.baseUrl;
    $('nickname').value = view.nickname;
    for (const radio of document.querySelectorAll('input[name="proactive"]')) {
      radio.checked = radio.value === view.proactive;
    }
    const list = $('memory');
    list.replaceChildren();
    if (!view.memory.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还是空的。多和她聊聊，她会悄悄记下关于你的事。';
      list.append(li);
    } else {
      for (const fact of view.memory) {
        const li = document.createElement('li');
        li.textContent = fact;
        list.append(li);
      }
    }
    $('clear-history').textContent = `清空聊天记录（${view.historyCount} 条）`;
  }

  function collect() {
    const checked = document.querySelector('input[name="proactive"]:checked');
    return {
      apiKey: keyInput.value,
      model: $('model').value,
      baseUrl: $('base-url').value,
      nickname: $('nickname').value,
      proactive: checked ? checked.value : undefined
    };
  }

  async function save() {
    render(await api.save(collect()));
    toast('已保存');
  }

  $('save').addEventListener('click', save);
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });

  $('toggle-key').addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });

  $('get-key').addEventListener('click', (e) => {
    e.preventDefault();
    api.openKeyPage();
  });

  $('test').addEventListener('click', async () => {
    const button = $('test');
    const box = $('test-result');
    button.disabled = true;
    button.textContent = '她在想……';
    await api.save(collect()).then(render);
    const result = await api.test();
    box.classList.remove('hidden');
    box.classList.toggle('bad', !result.ok);
    box.textContent = result.ok ? `卿诗雨：${result.text}` : `${result.text}${result.detail ? `（${result.detail}）` : ''}`;
    button.disabled = false;
    button.textContent = '测试连接';
  });

  $('clear-key').addEventListener('click', async () => {
    render(await api.save({ clearKey: true }));
    toast('Key 已移除');
  });

  $('clear-memory').addEventListener('click', async () => {
    render(await api.clearMemory());
    toast('小本本清空了');
  });

  $('clear-history').addEventListener('click', async () => {
    render(await api.clearHistory());
    toast('聊天记录清空了');
  });

  render(await api.get());
})();
