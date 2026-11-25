// 화면 디자인 (2026-11-23 적용, 시안 D): 위쪽 탭·작은 탭을 모두 왼쪽 사이드바로, 위쪽에는 지금 페이지 위치만 표시
// 기존 탭 버튼은 숨겨 두고 그대로 눌러서 화면을 바꿈 (app.js의 화면 전환 로직은 그대로 사용)
(function () {
  // 채운(솔리드) 아이콘
  const ICON = {
    employee: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.2 1.9a1 1 0 1 1-1 1.7l-3.7-2.2A1 1 0 0 1 11 13V7a1 1 0 1 1 2 0z"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1zM4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9zm3 3h4v4H7z"/></svg>',
    hq: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="7.5" r="3.5"/><path d="M2 19.5C2 15.9 5.1 13 9 13s7 2.9 7 6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M17.5 8a1 1 0 0 1 1 1v1.5H20a1 1 0 1 1 0 2h-1.5V14a1 1 0 1 1-2 0v-1.5H15a1 1 0 1 1 0-2h1.5V9a1 1 0 0 1 1-1z"/></svg>',
    notice: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 3.5a1 1 0 0 1 1.6.8v15.4a1 1 0 0 1-1.6.8L13.6 17H11l.9 3.3a1 1 0 0 1-1 1.3H9.3a1 1 0 0 1-1-.8L7.2 17H6a4 4 0 0 1 0-8h7.6z"/><path d="M21 10.5a1.5 1.5 0 0 1 0 3z"/></svg>',
  };
  const SHORT = { employee: '출퇴근', admin: '근태', hq: '관리', notice: '공지' };  const ORDER = ['employee', 'admin', 'hq', 'notice']; // 공지사항은 맨 아래
  const CHEV = '<svg class="dchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  // 접은 그룹 (이 기기에 기억)
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem('dnavCollapsed') || '[]')); } catch (_) {}
  const topTab = (v) => document.querySelector(`.topbar .tab[data-view="${v}"]`);
  const subRow = (v) => document.querySelector(`#admin-view .subtabs[data-for="${v}"]`);
  const cleanText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() || el.textContent.trim();
  const badgeOf = (el) => { const b = el.querySelector('.ot-badge:not([hidden])'); return b && b.textContent.trim() ? b.textContent.trim() : ''; };

  function current() {
    const t = document.querySelector('.topbar .tab.active');
    const v = t?.dataset.view || 'employee';
    const row = subRow(v);
    const s = row?.querySelector('[data-sub].active');
    return { v, title: t ? cleanText(t) : '', sub: s ? s.dataset.sub : null, subTitle: s ? cleanText(s) : '' };
  }

  function build() {
    const nav = document.getElementById('dnav');
    if (!nav) return;
    const cur = current();
    let html = '<div class="dhead"><span class="dlogo"><img src="icons/icon-192.png" alt="Adecco"></span><b>아데코코리아</b><button class="dclose" aria-label="닫기">✕</button></div><div class="dmenu">';
    ORDER.forEach((v) => {
      const t = topTab(v);
      if (!t || t.hidden) return;
      const row = subRow(v);
      const subs = row ? [...row.querySelectorAll('[data-sub]')].filter((b) => !b.hidden && getComputedStyle(b).display !== 'none') : [];
      const groupOn = cur.v === v;
      const folded = subs.length && collapsed.has(v);
      // 접힌 그룹은 세부 메뉴의 배지를 합쳐서 그룹 줄에 표시
      const sum = folded ? subs.map(badgeOf).reduce((a, x) => a + (Number(x) || 0), 0) : 0;
      const tb = badgeOf(t) || (sum ? String(sum) : '');
      html += `<div class="dgroup ${groupOn ? 'on' : ''} ${subs.length ? 'has-subs' : ''} ${folded ? 'folded' : ''}">`;
      html += `<button class="dtop" data-v="${v}" ${subs.length ? 'data-fold="1"' : ''}>${ICON[v] || ''}<span>${cleanText(t)}</span>${tb ? `<i class="dbadge">${tb}</i>` : ''}${subs.length ? CHEV : ''}</button>`;
      if (subs.length && !folded) {
        html += '<div class="dsubs">' + subs.map((b) => {
          const bd = badgeOf(b);
          return `<button class="dsub ${groupOn && cur.sub === b.dataset.sub ? 'on' : ''}" data-v="${v}" data-s="${b.dataset.sub}"><span>${cleanText(b)}</span>${bd ? `<i class="dbadge">${bd}</i>` : ''}</button>`;
        }).join('') + '</div>';
      }
      html += '</div>';
    });
    nav.innerHTML = html + '</div>';
    // 휴대폰 아래 탭바 (큰 메뉴만)
    const bb = document.getElementById('dbottom');
    if (bb) bb.innerHTML = ORDER.map((v) => { const t = topTab(v); if (!t || t.hidden) return ''; const b = badgeOf(t) || [...(subRow(v)?.querySelectorAll('[data-sub]') || [])].map(badgeOf).find(Boolean) || ''; return `<button data-v="${v}" class="${cur.v === v ? 'on' : ''}">${ICON[v]}<span>${SHORT[v]}</span>${b ? `<i class="dbadge">${b}</i>` : ''}</button>`; }).join('');
    // 위쪽: 지금 페이지 위치
    const crumb = document.getElementById('dcrumb');
    if (crumb) crumb.innerHTML = cur.subTitle ? `<span class="dc-group">${cur.title}</span><span class="dc-sep">›</span><b>${cur.subTitle}</b>` : `<b>${cur.title}</b>`;
  }

  function setup() {
    if (document.getElementById('dnav')) return;
    const nav = document.createElement('nav'); nav.id = 'dnav';
    document.body.appendChild(nav);
    const bd = document.createElement('div'); bd.id = 'dbackdrop'; document.body.appendChild(bd);
    document.body.classList.add('dlayout');
    const bar = document.querySelector('.topbar');
    const menuBtn = document.createElement('button'); menuBtn.id = 'dmenu-btn'; menuBtn.innerHTML = '☰'; menuBtn.setAttribute('aria-label', '메뉴');
    const crumb = document.createElement('div'); crumb.id = 'dcrumb';
    bar.insertBefore(menuBtn, bar.firstChild);
    bar.insertBefore(crumb, bar.querySelector('.tabs'));
    const mlogo = document.createElement('img'); mlogo.id = 'dmlogo'; mlogo.src = 'icons/icon-192.png'; mlogo.alt = 'Adecco'; bar.insertBefore(mlogo, crumb);
    const rbtn = document.createElement('button'); rbtn.id = 'drefresh'; rbtn.setAttribute('aria-label', '새로고침'); rbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>'; rbtn.addEventListener('click', () => location.reload()); bar.appendChild(rbtn);
    const bottom = document.createElement('nav'); bottom.id = 'dbottom'; document.body.appendChild(bottom);
    bottom.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; const t = topTab(b.dataset.v); if (!t.classList.contains('active')) t.click(); window.scrollTo(0, 0); });
    const note = document.getElementById('manager-note'); const av = document.getElementById('admin-view'); if (note && av) av.insertBefore(note, av.firstChild);
    const cc = document.querySelector('.clock-card'); if (cc && !cc.querySelector('.dtoday') && !document.getElementById('dgreet')) { const h = document.createElement('h2'); h.className = 'dtoday'; h.textContent = '오늘 근무'; cc.insertBefore(h, cc.firstChild); }
    const close = () => document.body.classList.remove('dnav-open');
    menuBtn.addEventListener('click', () => document.body.classList.add('dnav-open'));
    bd.addEventListener('click', close);
    nav.addEventListener('click', (e) => {
      if (e.target.closest('.dclose')) return close();
      const b = e.target.closest('button[data-v]'); if (!b) return;
      if (b.dataset.fold) { // 세부 메뉴가 있는 그룹 줄 → 접기/펼치기만
        if (collapsed.has(b.dataset.v)) collapsed.delete(b.dataset.v); else collapsed.add(b.dataset.v);
        try { localStorage.setItem('dnavCollapsed', JSON.stringify([...collapsed])); } catch (_) {}
        return build();
      }
      const t = topTab(b.dataset.v);
      if (!t.classList.contains('active')) t.click();
      if (b.dataset.s) subRow(b.dataset.v)?.querySelector(`[data-sub="${b.dataset.s}"]`)?.click();
      close();
      window.scrollTo(0, 0);
    });
    // 탭 상태(활성·숨김·배지)가 바뀌면 사이드바·위치 표시를 다시 그림
    const obs = new MutationObserver(() => { clearTimeout(obs.t); obs.t = setTimeout(build, 30); });
    [document.querySelector('.topbar .tabs'), ...document.querySelectorAll('#admin-view .subtabs')].forEach((el) => el && obs.observe(el, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true, characterData: true }));
    build();
  }

  // 로그인 화면: 왼쪽(휴대폰은 위쪽) 남색 브랜드 영역 + 오른쪽 로그인 카드
  function setupLogin() {
    const lv = document.getElementById('login-view');
    if (!lv || lv.querySelector('.dlogin-brand')) return;
    // 흰 바탕 로그인 (시프티 로그인 화면 느낌): 왼쪽 위 CI·회사명, 오른쪽 위 문의 안내,
    // 가운데 큰 '로그인' 제목 + 막대형 입력칸·버튼, 맨 아래 저작권 표시
    const brand = document.createElement('header');
    brand.className = 'dlogin-brand';
    brand.innerHTML = '<span class="dlogin-logo"><img src="icons/icon-192.png" alt="Adecco"></span><b>아데코코리아</b>'
      + '<span class="dlogin-ask">계정 관련 사항은 <b>담당 매니저</b>에게 문의해 주세요</span>';
    lv.insertBefore(brand, lv.firstChild);
    const form = document.getElementById('login-form');
    if (form && !form.querySelector('.dlogin-title')) {
      const t = document.createElement('div');
      t.className = 'dlogin-title';
      t.innerHTML = '<span class="dlogin-mci"><img src="icons/icon-192.png" alt="Adecco"></span><h2>로그인</h2>';
      form.insertBefore(t, form.firstChild);
    }
  }
  // 샤플형 (2026-11-25): 출퇴근 카드의 날짜·시계·출퇴근 칸·버튼을 파란 카드로 묶음 (요소·id는 옮기기만 함),
  // 점포별 출근 현황의 숫자 카드를 맨 위로, '퇴근 미기록' 숫자 카드를 누르면 아래 목록을 펼침
  function setupShopl() {
    const cc = document.querySelector('.clock-card');
    if (cc && !cc.querySelector('.sclock')) {
      const box = document.createElement('div'); box.className = 'sclock';
      ['now-date', 'now-time', 'status-row', 'status-badge', 'clock-buttons'].forEach((k) => {
        const el = document.getElementById(k) || cc.querySelector('.' + k);
        if (el) box.appendChild(el);
      });
      cc.insertBefore(box, cc.querySelector('#gps-box'));
      // 인사말·오늘 스케줄 카드(index.html)에 특정일·지원 안내 문구를 옮김
      const sc = cc.querySelector('.ssched'); const wh = document.getElementById('work-hours'); if (sc && wh) sc.appendChild(wh);
      cc.classList.add('sflat');
    }
    const kpi = document.getElementById('today-kpi'); const mo = document.getElementById('missout-box');
    if (kpi && mo) mo.parentNode.insertBefore(kpi, mo);
    document.getElementById('kpi-miss-btn')?.addEventListener('click', () => {
      const d = document.getElementById('missout-box'); if (!d || d.hidden) return;
      d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  // PC 위쪽 메뉴 (2026-11-25): 위쪽 띠에 CI + 큰 메뉴, 작은 탭은 원래 탭 버튼을 알약 모양으로 보여 줌(CSS).
  // 휴대폰(≤900px)에서는 CSS가 이 메뉴를 숨기고 ☰ 서랍(#dnav)을 씀
  function buildTopNav() {
    const nav = document.getElementById('ntop');
    if (!nav) return;
    nav.innerHTML = ORDER.map((v) => {
      const t = topTab(v);
      if (!t || t.hidden) return '';
      const bd = badgeOf(t);
      return `<button type="button" data-v="${v}" class="${t.classList.contains('active') ? 'on' : ''}">${cleanText(t)}${bd ? `<i class="nbadge">${bd}</i>` : ''}</button>`;
    }).join('');
  }
  function setupTopNav() {
    const bar = document.querySelector('.topbar');
    if (!bar || document.getElementById('ntop')) return;
    document.body.classList.add('ntop');
    const brand = document.createElement('div'); brand.id = 'nbrand';
    brand.innerHTML = '<span class="nlogo"><img src="icons/icon-192.png" alt="Adecco"></span><b>아데코코리아</b>';
    const nav = document.createElement('nav'); nav.id = 'ntop';
    const crumb = document.getElementById('dcrumb');
    bar.insertBefore(brand, crumb); bar.insertBefore(nav, crumb);
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      const t = topTab(b.dataset.v);
      if (t && !t.classList.contains('active')) t.click();
      window.scrollTo(0, 0);
    });
    const obs = new MutationObserver(() => { clearTimeout(obs.t); obs.t = setTimeout(buildTopNav, 30); });
    const tabs = document.querySelector('.topbar .tabs');
    if (tabs) obs.observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true, characterData: true });
    buildTopNav();
  }
  const init = () => { setup(); setupLogin(); setupShopl(); setupTopNav(); };
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
