/*
 * main.js —— 官网交互
 * 1. 滚动时导航栏吸顶 + 毛玻璃背景
 * 2. 移动端汉堡菜单展开 / 收起
 * 3. 滚动监听的导航高亮（Scroll Spy）
 * 4. IntersectionObserver 实现进入视口的淡入上移动画
 */
(() => {
  'use strict';

  const navbar = document.getElementById('navbar');
  const navToggle = document.getElementById('navToggle');
  const navLinks = Array.from(document.querySelectorAll('.nav__link'));

  // 需要参与导航高亮的区块
  const sections = ['intro', 'features', 'install']
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  /* ---------------- 1. 导航栏吸顶状态 + 3. 导航高亮 ---------------- */

  let ticking = false;

  function setActive(id) {
    navLinks.forEach((link) => {
      const isMatch = link.getAttribute('href') === '#' + id;
      link.classList.toggle('is-active', isMatch);
      if (isMatch) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function updateScrollSpy() {
    // 判定线放在视口 35% 位置：滚过某个区块顶部就高亮对应导航
    const probe = window.scrollY + window.innerHeight * 0.35;
    let current = '';
    sections.forEach((section) => {
      const top = section.getBoundingClientRect().top + window.scrollY;
      if (top <= probe) current = section.id;
    });
    setActive(current);
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      navbar.classList.toggle('is-scrolled', window.scrollY > 12);
      updateScrollSpy();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------- 2. 移动端菜单 ---------------- */

  function setMenu(open) {
    navbar.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  }

  navToggle.addEventListener('click', () => {
    setMenu(navToggle.getAttribute('aria-expanded') !== 'true');
  });

  // 点击菜单项后自动收起
  navLinks.forEach((link) => link.addEventListener('click', () => setMenu(false)));

  // 点击菜单外部收起
  document.addEventListener('click', (event) => {
    if (!navbar.classList.contains('is-open')) return;
    if (!navbar.contains(event.target)) setMenu(false);
  });

  // Esc 收起
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenu(false);
  });

  // 视口变宽后重置菜单状态，避免桌面端残留展开样式
  const mq = window.matchMedia('(min-width: 768px)');
  const resetOnDesktop = (e) => { if (e.matches) setMenu(false); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', resetOnDesktop);

  /* ---------------- 4. 进入视口淡入 ---------------- */

  const revealNodes = Array.from(document.querySelectorAll('.reveal'));

  if (!('IntersectionObserver' in window)) {
    // 兜底：不支持 IO 的浏览器直接显示
    revealNodes.forEach((node) => node.classList.add('is-visible'));
    return;
  }

  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        // 同级元素按顺序错开一点，避免整块一起出现
        const delay = Number(entry.target.dataset.delay || 0);
        window.setTimeout(() => entry.target.classList.add('is-visible'), delay);
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
  );

  revealNodes.forEach((node, index) => {
    // 同一行内的卡片依次延迟 70ms
    if (!node.dataset.delay) node.dataset.delay = String((index % 3) * 70);
    revealObserver.observe(node);
  });
})();
