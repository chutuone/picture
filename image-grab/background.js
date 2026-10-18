/*
 * background.js —— Service Worker（Manifest V3）
 * 职责：
 *   1. 接收 content script 提取到的图片列表，写入 storage 并打开画廊页
 *   2. 接收画廊页的下载请求：抓取原图 -> 转成 PNG -> chrome.downloads 保存
 *   3. 把下载进度 / 失败原因实时推送给画廊页
 *   4. 点击工具栏图标时直接打开画廊页
 */

const STORAGE_KEY = 'ig_session';     // 最近一次提取结果
const FILE_PREFIX = '商品图_';         // 下载文件名前缀

/* ---------------- 工具函数 ---------------- */

// 安全地向扩展页面（画廊）推送消息：画廊被关闭时不会有接收方，避免抛错
function notify(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // 读取 lastError 只是为了让 Chrome 不再打印 "Unchecked runtime.lastError"
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* 忽略：画廊页可能已经关闭 */
  }
}

// blob -> data URL（Service Worker 里没有 FileReader，手动 base64 编码）
async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000; // 分块拼接，避免超长图片导致调用栈溢出
  let binary = '';
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK));
  }
  return 'data:image/png;base64,' + btoa(binary);
}

// 抓取图片 blob，依次尝试匿名 / 带 cookie 两种方式
async function fetchImageBlob(url) {
  const attempts = [
    () => fetch(url, { cache: 'force-cache' }),
    () => fetch(url, { credentials: 'include', cache: 'force-cache' }),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const resp = await attempt();
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      if (!blob || !blob.size) throw new Error('图片内容为空');
      return blob;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    (lastError && lastError.message ? lastError.message + '，' : '') +
      '抓取失败（可能被防盗链拦截或域名未授权）'
  );
}

/**
 * 把任意格式的图片（jpg / webp / png…）转成 PNG 的 data URL
 * 使用 Service Worker 中的 createImageBitmap + OffscreenCanvas，绕开页面跨域污染
 */
async function imageToPngDataUrl(url) {
  const blob = await fetchImageBlob(url);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error('无法解析图片格式');
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 不可用');
    // 白底，避免透明 PNG / webp 转出来是黑底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(pngBlob);
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

// 序号补零：1 -> 001
function buildFilename(seq) {
  return FILE_PREFIX + String(seq).padStart(3, '0') + '.png';
}

/* ---------------- 提取结果 -> 画廊页 ---------------- */

async function handleGrab(payload) {
  if (!payload || !Array.isArray(payload.images) || !payload.images.length) {
    throw new Error('没有可展示的图片');
  }
  const session = {
    id: Date.now().toString(36),
    title: payload.title || '未命名商品',
    pageUrl: payload.url || '',
    platform: payload.platform || '',
    createdAt: Date.now(),
    images: payload.images,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
  await chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') });
  return session;
}

/* ---------------- 批量下载 ---------------- */

let downloading = false; // 同一时间只跑一个下载任务

async function runDownloadTask(items) {
  if (downloading) {
    notify({ type: 'IG_BUSY' });
    return;
  }
  downloading = true;

  const total = items.length;
  let ok = 0;
  const errors = [];

  notify({ type: 'IG_PROGRESS', done: 0, total, ok: 0, fail: 0, url: '' });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const seq = Number(item.seq) || i + 1;
    try {
      const dataUrl = await imageToPngDataUrl(item.url);
      await chrome.downloads.download({
        url: dataUrl,
        filename: buildFilename(seq),
        conflictAction: 'uniquify',
        saveAs: false,
      });
      ok++;
    } catch (err) {
      const message = (err && err.message) || String(err);
      errors.push({ url: item.url, message, seq });
    }
    notify({
      type: 'IG_PROGRESS',
      done: i + 1,
      total,
      ok,
      fail: errors.length,
      url: item.url,
      seq,
    });
  }

  downloading = false;
  notify({
    type: 'IG_COMPLETE',
    total,
    ok,
    fail: errors.length,
    errors: errors.slice(0, 20), // 只回传前 20 条失败原因，避免消息过大
  });
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'IG_GRAB') {
    handleGrab(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true; // 异步响应，保持消息通道
  }

  if (message.type === 'IG_DOWNLOAD') {
    const items = Array.isArray(message.items) ? message.items : [];
    if (!items.length) {
      sendResponse({ ok: false, error: '没有选中任何图片' });
      return false;
    }
    runDownloadTask(items);
    sendResponse({ ok: true, total: items.length });
    return false;
  }

  if (message.type === 'IG_PING') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/* ---------------- 点击工具栏图标打开画廊 ---------------- */

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') });
});

/* ---------------- 首次安装引导 ---------------- */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') + '?welcome=1' });
  }
});
