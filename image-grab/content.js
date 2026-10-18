/*
 * content.js —— 注入到淘宝 / 天猫 / 京东 / 拼多多商家版页面
 * 职责：
 *   1. 判断当前是否为「商品详情页」，是则注入右下角「获取图片」悬浮按钮
 *   2. 点击后扫描页面内的商品图片（img / srcset / 懒加载属性 / 背景图）
 *   3. 过滤图标、logo、占位图、小尺寸图，补全绝对地址并去重
 *   4. 通过 chrome.runtime.sendMessage 交给 background 打开画廊页
 */
(() => {
  'use strict';

  // 防止内容脚本被重复注入（SPA 路由切换、多次 reload 等场景）
  if (window.__IG_INJECTED__) return;
  window.__IG_INJECTED__ = true;

  const MIN_SIZE = 100;          // 小于 100x100 的图片视为图标/小图，过滤掉
  const MAX_CANDIDATES = 300;    // 最多扫描的候选图片数，避免超长页面卡顿
  const MAX_RESULT = 200;        // 最终最多回传的图片数量
  const PROBE_TIMEOUT = 5000;    // 预加载探测尺寸的超时时间（毫秒）
  const PROBE_CONCURRENCY = 6;   // 预加载并发数

  // 明显不是商品图的 URL 特征
  const BAD_URL = /(logo|icon|avatar|sprite|placeholder|lazy-load|loading|spacer|blank|1x1|pixel|favicon|qrcode|qr-code|\.svg(\?|#|$)|\.gif(\?|#|$))/i;

  let fab = null;          // 悬浮按钮
  let toastTimer = null;   // 提示气泡定时器
  let busy = false;        // 是否正在扫描

  /* ---------------- 平台 / 详情页识别 ---------------- */

  function detectPlatform() {
    const host = location.hostname;
    const path = location.pathname + location.search;

    if (/(^|\.)(taobao|tmall)\.com$/i.test(host)) {
      // item.taobao.com/item.htm、detail.tmall.com/item.htm、chaoshi.detail.tmall.com/item.htm
      if (/(item\.htm|\/i\d+\.htm|detail|goods)/i.test(path) || /^detail\./i.test(host)) return '淘宝/天猫';
      return null;
    }
    if (/(^|\.)jd\.com$/i.test(host)) {
      // item.jd.com/100012043978.html、item.m.jd.com/product/xxx.html
      if (/\/\d+\.html|\/(product|item|detail)\//i.test(path) || /^item\./i.test(host)) return '京东';
      return null;
    }
    if (/(^|\.)(pinduoduo|yangkeduo)\.com$/i.test(host)) {
      // mobile.yangkeduo.com/goods.html、mms.pinduoduo.com/goods/...（商家版）
      if (/(goods|detail|product|\/g\/)/i.test(path)) return '拼多多商家版';
      return null;
    }
    return null;
  }

  /* ---------------- 悬浮按钮 ---------------- */

  function createFab() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ig-fab';
    btn.setAttribute('aria-label', '获取当前页面所有商品图片');
    btn.innerHTML =
      '<svg class="ig-fab__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L11 12.6V3a1 1 0 0 1 1-1Zm-7 16a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v1.2A1.8 1.8 0 0 1 18.2 22H5.8A1.8 1.8 0 0 1 4 20.2V19a1 1 0 0 1 1-1Z"/>' +
      '</svg><span class="ig-fab__text">获取图片</span>';
    btn.addEventListener('click', onFabClick);
    return btn;
  }

  function ensureFab() {
    const platform = detectPlatform();
    if (!platform) {
      // 非商品详情页：不显示按钮
      if (fab) fab.classList.add('ig-fab--hidden');
      return;
    }
    if (!fab || !fab.isConnected) {
      fab = createFab();
      (document.body || document.documentElement).appendChild(fab);
      fab.dataset.platform = platform;
    }
    fab.classList.remove('ig-fab--hidden');
  }

  function setFabLoading(loading, text) {
    if (!fab) return;
    busy = loading;
    fab.classList.toggle('ig-fab--loading', loading);
    fab.disabled = loading;
    const label = fab.querySelector('.ig-fab__text');
    if (label) label.textContent = text || (loading ? '扫描中…' : '获取图片');
  }

  function showToast(message, type) {
    let el = document.querySelector('.ig-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ig-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.type = type || 'info';
    el.classList.add('ig-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('ig-toast--show'), 2600);
  }

  /* ---------------- 图片收集 ---------------- */

  function normalizeUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let url = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!url) return null;
    if (/^(data|blob|chrome|chrome-extension|about):/i.test(url)) return null;
    if (url.startsWith('//')) url = location.protocol + url;
    try {
      const abs = new URL(url, location.href);
      if (!/^https?:$/.test(abs.protocol)) return null;
      abs.hash = '';
      return abs.href;
    } catch (e) {
      return null;
    }
  }

  // 从 srcset 中解析出所有候选地址
  function parseSrcset(value) {
    if (!value) return [];
    return value
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  // 从 background-image 的 url("...") 中解析地址
  function parseBackgroundUrls(value) {
    if (!value || value === 'none') return [];
    const urls = [];
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(value))) {
      if (m[2]) urls.push(m[2]);
    }
    return urls;
  }

  /**
   * 收集所有候选图片
   * @returns {Map<string, {url:string, w:number, h:number}>}
   */
  function collectCandidates() {
    const result = new Map(); // url -> { url, w, h }
    let count = 0;

    const add = (rawUrl, w, h) => {
      if (count >= MAX_CANDIDATES) return;
      const url = normalizeUrl(rawUrl);
      if (!url) return;
      const knownW = Number(w) || 0;
      const knownH = Number(h) || 0;
      const prev = result.get(url);
      if (prev) {
        // 同一地址被多次命中时，保留已知尺寸
        if (!prev.w && knownW) { prev.w = knownW; prev.h = knownH; }
        return;
      }
      count++;
      result.set(url, { url, w: knownW, h: knownH });
    };

    // 1) <img> 及其懒加载属性
    document.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      [
        img.currentSrc,
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-lazy-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-ks-lazyload'),
        img.getAttribute('data-lazyload'),
        img.getAttribute('data-url'),
        img.getAttribute('data-image'),
      ].forEach((u) => add(u, w, h));
      parseSrcset(img.getAttribute('srcset')).forEach((u) => add(u, w, h));
      parseSrcset(img.getAttribute('data-srcset')).forEach((u) => add(u, w, h));
    });

    // 2) <picture><source srcset>
    document.querySelectorAll('picture source').forEach((source) => {
      parseSrcset(source.getAttribute('srcset')).forEach((u) => add(u, 0, 0));
    });

    // 3) 行内 style 中的 background-image
    document.querySelectorAll('[style*="background"]').forEach((el) => {
      parseBackgroundUrls(el.style.backgroundImage).forEach((u) => add(u, 0, 0));
    });

    // 4) 懒加载容器 / 轮播图的 computed background-image（限量扫描避免性能问题）
    const bgNodes = document.querySelectorAll(
      '[class*="pic"],[class*="Pic"],[class*="img"],[class*="Img"],[class*="thumb"],[class*="Thumb"]'
    );
    const limit = Math.min(bgNodes.length, 1500);
    for (let i = 0; i < limit; i++) {
      const el = bgNodes[i];
      if (!el || el.tagName === 'IMG') continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') parseBackgroundUrls(bg).forEach((u) => add(u, 0, 0));
    }

    return result;
  }

  // 预加载一张图片以获取真实尺寸（跨域图片也能读取 naturalWidth/Height）
  function probeSize(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      let done = false;
      const finish = (size) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(size);
      };
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT);
      img.onload = () => finish({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  // 控制并发的批量探测
  async function probeAll(items) {
    const queue = items.slice();
    const workers = new Array(Math.min(PROBE_CONCURRENCY, queue.length)).fill(0).map(async () => {
      while (queue.length) {
        const item = queue.shift();
        const size = await probeSize(item.url);
        if (size) { item.w = size.w; item.h = size.h; }
      }
    });
    await Promise.all(workers);
  }

  /**
   * 扫描 + 过滤，返回可以交给下载流程的图片列表
   */
  async function scanImages() {
    const candidates = collectCandidates();
    const list = [];

    // 第一轮：URL 明显不是商品图 / 尺寸已知但过小的先剔除
    const needProbe = [];
    for (const item of candidates.values()) {
      if (BAD_URL.test(item.url)) continue;
      if (item.w && item.h && (item.w < MIN_SIZE || item.h < MIN_SIZE)) continue;
      if (!item.w || !item.h) {
        needProbe.push(item);
        list.push(item);
      } else {
        list.push(item);
      }
    }

    // 第二轮：对没有尺寸信息的图片做预加载探测，过滤掉小图 / 加载失败的图
    if (needProbe.length) {
      needProbe.splice(MAX_CANDIDATES); // 保险：限制探测数量
      await probeAll(needProbe);
    }

    return list
      .filter((item) => {
        // 探测后仍无尺寸（加载失败、被防盗链拦截）的图片直接丢弃，避免空卡片
        if (!item.w || !item.h) return false;
        return item.w >= MIN_SIZE && item.h >= MIN_SIZE;
      })
      .slice(0, MAX_RESULT)
      .map((item) => ({ url: item.url, width: item.w, height: item.h }));
  }

  /* ---------------- 交互 ---------------- */

  async function onFabClick() {
    if (busy) return;
    const platform = detectPlatform();
    if (!platform) return;

    setFabLoading(true, '扫描中…');
    try {
      const images = await scanImages();
      if (!images.length) {
        showToast('没有找到可下载的商品图片，试试滚动页面加载更多', 'warn');
        return;
      }

      const payload = {
        images,
        title: document.title || '未命名商品',
        url: location.href,
        platform,
      };

      // 交给 background：写入 storage 并打开画廊页
      const resp = await chrome.runtime.sendMessage({ type: 'IG_GRAB', payload });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '无法打开画廊页');

      showToast(`已提取 ${images.length} 张图片`, 'success');
      setFabLoading(false, '已提取');
      setTimeout(() => setFabLoading(false, '获取图片'), 1800);
      return;
    } catch (err) {
      // 扩展被重载后旧的 content script 会失效，提示用户刷新页面
      const msg = String((err && err.message) || err);
      if (/Extension context invalidated|Receiving end does not exist/i.test(msg)) {
        showToast('扩展已更新，请刷新页面后重试', 'warn');
      } else {
        showToast('提取失败：' + msg, 'error');
      }
    } finally {
      if (busy) setFabLoading(false, '获取图片');
    }
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    ensureFab();
    // 电商站点基本都是 SPA，路由变化不会重新执行内容脚本，这里低频轮询兜底
    setInterval(ensureFab, 2000);
    window.addEventListener('popstate', ensureFab);
    window.addEventListener('hashchange', ensureFab);
  }

  boot();
})();
