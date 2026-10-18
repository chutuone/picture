/*
 * gallery.js —— 画廊页逻辑
 * 1. 从 chrome.storage.local 读取最近一次提取结果并渲染网格
 * 2. 支持全选 / 反选 / 单选，实时统计
 * 3. 把选中的图片交给 background 转 PNG 并下载，展示进度与结果
 */

const STORAGE_KEY = 'ig_session';

const els = {
  meta: document.getElementById('meta'),
  empty: document.getElementById('empty'),
  content: document.getElementById('content'),
  grid: document.getElementById('grid'),
  counter: document.getElementById('counter'),
  btnSelectAll: document.getElementById('btnSelectAll'),
  btnInvert: document.getElementById('btnInvert'),
  btnDownload: document.getElementById('btnDownload'),
  statusText: document.getElementById('statusText'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressValue: document.getElementById('progressValue'),
};

const state = {
  session: null,
  images: [],
  selected: new Set(),
  downloading: false,
};

/* ---------------- 通用 UI ---------------- */

function setStatus(text, type) {
  els.statusText.textContent = text;
  if (type) els.statusText.dataset.type = type;
  else delete els.statusText.dataset.type;
}

function setProgress(done, total) {
  if (!total) {
    els.progressWrap.hidden = true;
    return;
  }
  els.progressWrap.hidden = false;
  const percent = Math.round((done / total) * 100);
  els.progressFill.style.width = percent + '%';
  els.progressValue.textContent = percent + '%';
}

function updateCounter() {
  els.counter.textContent = `已选 ${state.selected.size} / ${state.images.length}`;
  els.btnDownload.disabled = state.selected.size === 0 || state.downloading;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

/* ---------------- 渲染 ---------------- */

function renderSession(session) {
  state.session = session;
  state.images = Array.isArray(session.images) ? session.images : [];
  state.selected = new Set();

  els.empty.hidden = true;
  els.content.hidden = false;

  const platform = session.platform ? session.platform + ' · ' : '';
  const time = session.createdAt ? new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false }) : '';
  els.meta.textContent = `${platform}${session.title || '未命名商品'} · 共 ${state.images.length} 张 · ${time}`;
  els.meta.title = session.pageUrl || '';

  renderGrid();
  updateCounter();
}

function renderGrid() {
  const frag = document.createDocumentFragment();

  state.images.forEach((image, index) => {
    const card = document.createElement('label');
    card.className = 'card';
    card.dataset.index = String(index);

    // 隐藏的原生 checkbox，保证键盘可操作
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(index);
    input.addEventListener('change', () => toggleCard(card, index, input.checked));
    card.appendChild(input);

    const thumb = document.createElement('div');
    thumb.className = 'card__thumb';

    const img = document.createElement('img');
    img.src = image.url;
    img.alt = `商品图 ${index + 1}`;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer'; // 绕开部分站点的防盗链校验
    img.addEventListener('error', () => thumb.classList.add('card__thumb--broken'));
    thumb.appendChild(img);

    const broken = document.createElement('span');
    broken.className = 'card__broken';
    broken.textContent = '缩略图加载失败，仍可下载';
    thumb.appendChild(broken);

    const check = document.createElement('span');
    check.className = 'card__check';
    check.setAttribute('aria-hidden', 'true');
    thumb.appendChild(check);

    const indexBadge = document.createElement('span');
    indexBadge.className = 'card__index';
    indexBadge.textContent = String(index + 1);
    thumb.appendChild(indexBadge);

    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'card__meta';

    const size = document.createElement('span');
    size.className = 'card__size';
    size.textContent = image.width && image.height ? `${image.width}×${image.height}` : '尺寸未知';

    const host = document.createElement('span');
    host.className = 'card__host';
    host.textContent = hostOf(image.url);
    host.title = image.url;

    meta.appendChild(size);
    meta.appendChild(host);
    card.appendChild(meta);

    frag.appendChild(card);
  });

  els.grid.textContent = '';
  els.grid.appendChild(frag);
}

function toggleCard(card, index, checked) {
  if (checked) state.selected.add(index);
  else state.selected.delete(index);
  card.classList.toggle('card--selected', checked);
  updateCounter();
}

/* ---------------- 选择操作 ---------------- */

function selectAll() {
  state.selected = new Set(state.images.map((_, i) => i));
  syncCheckboxes();
}

function invertSelection() {
  const next = new Set();
  state.images.forEach((_, i) => {
    if (!state.selected.has(i)) next.add(i);
  });
  state.selected = next;
  syncCheckboxes();
}

function syncCheckboxes() {
  els.grid.querySelectorAll('.card').forEach((card) => {
    const index = Number(card.dataset.index);
    const checked = state.selected.has(index);
    const input = card.querySelector('input');
    if (input) input.checked = checked;
    card.classList.toggle('card--selected', checked);
  });
  updateCounter();
}

/* ---------------- 下载 ---------------- */

function startDownload() {
  if (state.downloading) return;

  const indexes = [...state.selected].sort((a, b) => a - b);
  if (!indexes.length) {
    setStatus('请先勾选要下载的图片', 'warn');
    return;
  }

  // seq 决定文件名序号：按选中顺序从 001 开始递增
  const items = indexes.map((index, i) => ({ url: state.images[index].url, seq: i + 1 }));

  state.downloading = true;
  els.btnDownload.disabled = true;
  setProgress(0, items.length);
  setStatus(`开始下载 ${items.length} 张图片…`);

  chrome.runtime.sendMessage({ type: 'IG_DOWNLOAD', items }, (resp) => {
    const lastError = chrome.runtime.lastError;
    if (lastError || !resp || !resp.ok) {
      state.downloading = false;
      updateCounter();
      const reason = (resp && resp.error) || (lastError && lastError.message) || '未知错误';
      setStatus('下载失败：' + reason, 'error');
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

els.btnSelectAll.addEventListener('click', selectAll);
els.btnInvert.addEventListener('click', invertSelection);
els.btnDownload.addEventListener('click', startDownload);

// 接收 background 推送的下载进度
function handleRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'IG_PROGRESS') {
    setProgress(message.done, message.total);
    setStatus(`正在转换并保存 ${message.done} / ${message.total}（成功 ${message.ok}，失败 ${message.fail}）`);
    return;
  }

  if (message.type === 'IG_COMPLETE') {
    state.downloading = false;
    updateCounter();
    setProgress(message.total, message.total);
    if (message.fail === 0) {
      setStatus(`下载完成：${message.ok} 张图片已保存为 PNG`, 'success');
    } else {
      const first = message.errors && message.errors[0];
      setStatus(
        `下载结束：成功 ${message.ok} 张，失败 ${message.fail} 张` + (first ? `（${first.message}）` : ''),
        'warn'
      );
    }
    // 3 秒后收起进度条
    setTimeout(() => setProgress(0, 0), 3000);
    return;
  }

  if (message.type === 'IG_BUSY') {
    setStatus('已有下载任务在进行中，请稍候…', 'warn');
  }
}

/* ---------------- 初始化 ---------------- */

async function init() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    els.meta.textContent = '请在 Chrome 扩展环境中打开本页面';
    els.empty.hidden = false;
    return;
  }

  // 只有扩展环境才注册消息监听，避免普通页面打开时报错
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === '1') {
    setStatus('感谢安装图提取！打开电商商品详情页，点击右下角「获取图片」即可开始。', 'success');
  }

  try {
    const store = await chrome.storage.local.get(STORAGE_KEY);
    const session = store[STORAGE_KEY];
    if (session && Array.isArray(session.images) && session.images.length) {
      renderSession(session);
    } else {
      els.empty.hidden = false;
      els.content.hidden = true;
      els.meta.textContent = '暂无提取记录 · 支持淘宝 / 天猫 / 京东 / 拼多多商家版';
    }
  } catch (err) {
    els.empty.hidden = false;
    els.meta.textContent = '读取提取记录失败：' + ((err && err.message) || err);
  }
}

init();
