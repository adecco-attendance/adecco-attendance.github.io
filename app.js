/* =====================================================================
 *  근태 시스템 프론트엔드 (Supabase + 정적 호스팅)
 * ===================================================================== */
(() => {
  'use strict';

  const CFG = window.CONFIG || {};
  const TZ = 'Asia/Seoul';
  const $ = (id) => document.getElementById(id);

  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
    $('config-warning').hidden = false;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL || 'https://invalid.supabase.co', CFG.SUPABASE_ANON_KEY || 'invalid');

  let me = null;          // 로그인한 사용자 profile
  let staff = [];         // (관리자) 직원 목록
  let branches = [];      // 지점 목록
  let adminRows = [];     // (관리자) 현재 조회된 기록
  let editingId = null;   // 수정 중인 기록 id (null 이면 신규)

  // ---------------------------------------------------------------
  //  유틸
  // ---------------------------------------------------------------
  const partsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const weekdayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, weekday: 'short' });

  function kst(d) {
    const o = {};
    partsFmt.formatToParts(new Date(d)).forEach((p) => { o[p.type] = p.value; });
    return o;
  }
  const ymd = (d) => { const o = kst(d); return `${o.year}-${o.month}-${o.day}`; };
  const hm = (d) => { if (!d) return '-'; const o = kst(d); return `${o.hour}:${o.minute}`; };
  const toInput = (d) => { if (!d) return ''; const o = kst(d); return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`; };
  const fromInput = (v) => (v ? new Date(`${v}:00+09:00`).toISOString() : null);
  const dateLabel = (dateStr) => {
    const [, m, d] = dateStr.split('-');
    const wd = weekdayFmt.format(new Date(`${dateStr}T12:00:00+09:00`));
    return `${m}/${d} (${wd})`;
  };

  function durMs(row) {
    if (!row.clock_in) return 0;
    const end = row.clock_out ? new Date(row.clock_out) : null;
    return end ? end - new Date(row.clock_in) : 0;
  }
  function fmtDur(ms) {
    if (!ms || ms < 0) return '-';
    const min = Math.floor(ms / 60000);
    return `${Math.floor(min / 60)}시간 ${String(min % 60).padStart(2, '0')}분`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function errMsg(error) {
    const m = error?.message || String(error);
    if (/Invalid login credentials/i.test(m)) return '아이디 또는 비밀번호가 올바르지 않습니다.';
    if (/attendance_user_day_unique/.test(m)) return '해당 직원은 그 날짜에 이미 기록이 있습니다.';
    if (/attendance_time_order/.test(m)) return '퇴근 시간이 출근 시간보다 빠릅니다.';
    if (/branches_name_key/.test(m)) return '같은 이름의 지점이 이미 있습니다.';
    if (/foreign key/i.test(m) && /branch/i.test(m)) return '소속 직원이나 출퇴근 기록이 있는 지점은 삭제할 수 없습니다. 대신 "사용"을 해제하세요.';
    if (/Failed to fetch|NetworkError/i.test(m)) return '서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.';
    if (/should be different/i.test(m)) return '기존 비밀번호와 다른 비밀번호를 입력하세요.';
    return m;
  }
  // Supabase는 한 번에 최대 1,000건만 돌려주므로, 1,000건씩 나눠서 전부 가져옴
  // build: 매번 새 쿼리를 만들어 반환하는 함수 (정렬 기준에 고유 컬럼 포함 필요)
  const PAGE_SIZE = 1000;
  async function fetchAll(build) {
    let all = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
      if (error) return { data: null, error };
      all = all.concat(data);
      if (data.length < PAGE_SIZE) return { data: all, error: null };
    }
  }

  function downloadCsv(filename, lines) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
  }

  document.querySelectorAll('.company-name, #company-name').forEach((el) => { el.textContent = CFG.COMPANY_NAME || ''; });
  document.querySelectorAll('.email-domain').forEach((el) => { el.textContent = CFG.EMAIL_DOMAIN || 'mycompany.com'; });

  // ---------------------------------------------------------------
  //  화면 전환 / 인증
  // ---------------------------------------------------------------
  function showView(name) {
    $('loading-view').hidden = name !== 'loading';
    $('login-view').hidden = name !== 'login';
    $('app-view').hidden = name !== 'app';
  }

  async function enterApp(user) {
    const { data, error } = await sb.from('profiles').select('*, branch:branches(name)').eq('id', user.id).single();
    if (error || !data) {
      await sb.auth.signOut({ scope: 'local' });
      showView('login');
      showError($('login-error'), '사용자 정보를 불러오지 못했습니다. 관리자에게 문의하세요.');
      return;
    }
    me = data;
    setUserLabel();
    $('admin-tab').hidden = !me.is_admin;
    switchTab('employee');
    showView('app');
    refreshToday();
    loadMyRecords();
  }

  function setUserLabel() {
    $('user-name').textContent = me.branch?.name ? `${me.branch.name} · ${me.name}님` : `${me.name}님`;
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('login-error'), '');
    let id = $('login-id').value.trim().toLowerCase();
    if (!id.includes('@') && CFG.EMAIL_DOMAIN) id = `${id}@${CFG.EMAIL_DOMAIN}`;
    const btn = e.submitter; btn.disabled = true;
    const { data, error } = await sb.auth.signInWithPassword({ email: id, password: $('login-pw').value });
    btn.disabled = false;
    if (error) return showError($('login-error'), errMsg(error));
    $('login-pw').value = '';
    enterApp(data.user);
  });

  $('logout-btn').addEventListener('click', async () => {
    // 'local': 이 기기에서만 로그아웃 (다른 기기의 로그인은 유지)
    await sb.auth.signOut({ scope: 'local' });
    me = null;
    showView('login');
  });

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { me = null; showView('login'); }
  });

  // ---------------------------------------------------------------
  //  탭
  // ---------------------------------------------------------------
  function switchTab(view) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('employee-view').hidden = view !== 'employee';
    $('admin-view').hidden = view !== 'admin';
    if (view === 'admin') initAdmin();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.view)));

  document.querySelectorAll('.subtab').forEach((t) => t.addEventListener('click', () => {
    const sub = t.dataset.sub;
    document.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('#admin-view [data-group]').forEach((el) => { el.hidden = el.dataset.group !== sub; });
    if (sub === 'records') initAdmin();
    if (sub === 'staff') Promise.all([loadBranches(), loadStaff(), loadAuthStatus()]).then(renderStaff);
    if (sub === 'branches') Promise.all([loadBranches(), loadStaff()]).then(renderBranches);
  }));

  // ---------------------------------------------------------------
  //  직원: 시계 / 오늘 상태 / 출퇴근
  // ---------------------------------------------------------------
  let todayRow = null;

  function tick() {
    const now = new Date();
    const o = kst(now);
    $('now-date').textContent = `${o.year}년 ${Number(o.month)}월 ${Number(o.day)}일 (${weekdayFmt.format(now)})`;
    $('now-time').textContent = `${o.hour}:${o.minute}:${o.second}`;
    if (todayRow && todayRow.clock_in && !todayRow.clock_out) {
      $('today-dur').textContent = fmtDur(now - new Date(todayRow.clock_in));
    }
  }
  setInterval(tick, 1000);
  tick();

  async function refreshToday() {
    if (!me) return;
    const { data, error } = await sb.from('attendance')
      .select('*').eq('user_id', me.id)
      .order('clock_in', { ascending: false }).limit(1);
    if (error) return setMsg(errMsg(error), 'err');

    const latest = data[0] || null;
    const today = ymd(new Date());
    const isOpen = latest && !latest.clock_out && (Date.now() - new Date(latest.clock_in)) < 24 * 3600 * 1000;
    const doneToday = latest && latest.work_date === today && latest.clock_out;

    todayRow = (isOpen || (latest && latest.work_date === today)) ? latest : null;
    $('today-in').textContent = todayRow ? hm(todayRow.clock_in) : '-';
    $('today-out').textContent = todayRow ? hm(todayRow.clock_out) : '-';
    $('today-dur').textContent = todayRow ? fmtDur(todayRow.clock_out ? durMs(todayRow) : Date.now() - new Date(todayRow.clock_in)) : '-';

    const badge = $('status-badge');
    if (isOpen) { badge.textContent = '근무 중'; badge.className = 'badge working'; }
    else if (doneToday) { badge.textContent = '오늘 근무 완료'; badge.className = 'badge done'; }
    else { badge.textContent = '출근 전'; badge.className = 'badge'; }

    $('clock-in-btn').disabled = !!(isOpen || (latest && latest.work_date === today));
    $('clock-out-btn').disabled = !isOpen;
  }

  function setMsg(text, kind) {
    const el = $('clock-msg');
    el.textContent = text; el.className = `msg ${kind || ''}`; el.hidden = !text;
  }

  async function doClock(fn, label) {
    if (!confirm(`${label} 하시겠습니까?`)) return;
    $('clock-in-btn').disabled = true; $('clock-out-btn').disabled = true;
    const { data, error } = await sb.rpc(fn);
    if (error) setMsg(errMsg(error), 'err');
    else setMsg(`${label} 완료 (${hm(fn === 'clock_in' ? data.clock_in : data.clock_out)})`, 'ok');
    await refreshToday();
    loadMyRecords();
  }
  $('clock-in-btn').addEventListener('click', () => doClock('clock_in', '출근'));
  $('clock-out-btn').addEventListener('click', () => doClock('clock_out', '퇴근'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && me) refreshToday();
  });

  // ---------------------------------------------------------------
  //  직원: 내 기록
  // ---------------------------------------------------------------
  $('my-month').value = ymd(new Date()).slice(0, 7);
  $('my-month').addEventListener('change', loadMyRecords);

  async function loadMyRecords() {
    if (!me || !$('my-month').value) return;
    const [from, to] = monthRange($('my-month').value);
    const { data, error } = await sb.from('attendance')
      .select('*').eq('user_id', me.id)
      .gte('work_date', from).lte('work_date', to)
      .order('work_date', { ascending: false });
    const tbody = $('my-records');
    if (error) { tbody.innerHTML = `<tr><td colspan="5" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">기록이 없습니다.</td></tr>'; $('my-summary').textContent = ''; return; }
    tbody.innerHTML = data.map((r) => `
      <tr>
        <td>${dateLabel(r.work_date)}</td>
        <td>${hm(r.clock_in)}</td>
        <td>${r.clock_out ? hm(r.clock_out) : '<span class="tag-open">미퇴근</span>'}</td>
        <td>${fmtDur(durMs(r))}</td>
        <td class="note">${esc(r.note)}${r.updated_at ? ' <span class="edited">(관리자 수정)</span>' : ''}</td>
      </tr>`).join('');
    const total = data.reduce((s, r) => s + durMs(r), 0);
    $('my-summary').textContent = `근무일 ${data.length}일 · 총 근무시간 ${fmtDur(total)}`;
  }

  // ---------------------------------------------------------------
  //  비밀번호 변경
  // ---------------------------------------------------------------
  $('pw-btn').addEventListener('click', () => {
    $('pw-form').reset(); showError($('pw-error'), '');
    $('pw-dialog').showModal();
  });
  $('pw-cancel').addEventListener('click', () => $('pw-dialog').close());
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw-new').value;
    if (pw !== $('pw-confirm').value) return showError($('pw-error'), '비밀번호가 일치하지 않습니다.');
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) return showError($('pw-error'), errMsg(error));
    $('pw-dialog').close();
    alert('비밀번호가 변경되었습니다.');
  });

  // ---------------------------------------------------------------
  //  관리자
  // ---------------------------------------------------------------
  let adminReady = false;

  const branchName = (id) => branches.find((b) => b.id === id)?.name || '미지정';

  // 지점 select 옵션. includeAll: '전체'/'미지정' 포함(필터용), onlyActive: 사용 중 지점만(+ 현재값)
  function branchOptions({ includeAll = false, current = null, onlyActive = false } = {}) {
    let html = includeAll ? '<option value="">전체 지점</option><option value="none">지점 미지정</option>' : '<option value="">(미지정)</option>';
    branches.forEach((b) => {
      if (onlyActive && !b.is_active && b.id !== current) return;
      html += `<option value="${b.id}" ${b.id === current ? 'selected' : ''}>${esc(b.name)}${b.is_active ? '' : ' (미사용)'}</option>`;
    });
    return html;
  }

  async function loadBranches() {
    const { data, error } = await sb.from('branches').select('*').order('name');
    if (error) { alert(errMsg(error)); return; }
    branches = data;
    ['f-branch', 's-branch'].forEach((id) => {
      const cur = $(id).value;
      $(id).innerHTML = branchOptions({ includeAll: true });
      $(id).value = cur;
    });
  }

  async function loadStaff() {
    const { data, error } = await fetchAll(() => sb.from('profiles').select('*').order('name').order('id'));
    if (error) { alert(errMsg(error)); return; }
    staff = data;
    fillUserSelects();
  }

  // ---- 직원 계정 관리 (Edge Function 'manage-staff', 관리자 전용) ----
  async function staffApi(body) {
    const { data, error } = await sb.functions.invoke('manage-staff', { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  let authStatus = new Map(); // user_id -> { banned, last_sign_in_at, email }
  async function loadAuthStatus() {
    try {
      const d = await staffApi({ action: 'list' });
      authStatus = new Map(d.users.map((u) => [u.id, u]));
    } catch (e) {
      authStatus = new Map();
      if (e.message === '로그인이 필요합니다.') {
        // 다른 곳에서 세션이 끝난 경우: 다시 로그인하도록 안내
        await sb.auth.signOut({ scope: 'local' });
        me = null;
        showView('login');
        showError($('login-error'), '로그인이 만료되었습니다. 다시 로그인해 주세요.');
        return;
      }
      console.warn('계정 상태를 불러오지 못했습니다:', e.message);
    }
  }
  const isDeleted = (id) => !!staff.find((s) => s.id === id)?.deleted_at;
  // 사용 중인 직원인지 (삭제·비활성화 제외). 상태를 못 불러온 경우엔 비활성 여부는 사용 중으로 간주
  const isActive = (id) => !isDeleted(id) && !authStatus.get(id)?.banned;

  const loginIdOf = (email) => {
    const suffix = `@${CFG.EMAIL_DOMAIN}`;
    return email && CFG.EMAIL_DOMAIN && email.endsWith(suffix) ? email.slice(0, -suffix.length) : (email || '');
  };

  const matchBranch = (branchId, filter) =>
    !filter || (filter === 'none' ? branchId == null : String(branchId) === filter);

  // 지점 필터에 맞춰 직원 select 갱신
  function fillUserSelects() {
    const fb = $('f-branch').value;
    const cur = $('f-user').value;
    const list = staff.filter((s) => matchBranch(s.branch_id, fb));
    $('f-user').innerHTML = '<option value="">전체</option>' +
      list.map((s) => `<option value="${s.id}">${esc(s.name)}${s.deleted_at ? ' (퇴사)' : ''}</option>`).join('');
    $('f-user').value = list.some((s) => s.id === cur) ? cur : '';
    $('edit-user').innerHTML = staff.filter((s) => !s.deleted_at).map((s) =>
      `<option value="${s.id}">${esc(s.name)} (${esc(branchName(s.branch_id))})</option>`).join('');
  }
  $('f-branch').addEventListener('change', () => { fillUserSelects(); loadAdminRecords(); });
  $('f-user').addEventListener('change', loadAdminRecords);

  // 월 선택 → 그 달 1일 ~ 말일로 기간 설정 후 조회
  function setMonth(ym) {
    const [from, to] = monthRange(ym);
    $('f-month').value = ym;
    $('f-from').value = from;
    $('f-to').value = to;
  }
  $('f-month').addEventListener('change', () => {
    if (!$('f-month').value) return;
    setMonth($('f-month').value);
    loadAdminRecords();
  });
  // 날짜를 직접 바꾸면 월 선택은 비움 (한 달 범위가 아닐 수 있으므로)
  ['f-from', 'f-to'].forEach((id) => $(id).addEventListener('change', () => { $('f-month').value = ''; }));

  async function initAdmin() {
    if (!me?.is_admin) return;
    if (!adminReady) {
      setMonth(ymd(new Date()).slice(0, 7));
      adminReady = true;
    }
    await loadBranches();
    await Promise.all([loadStaff(), loadAuthStatus()]);
    loadTodaySummary();
    loadAdminRecords();
  }

  $('filter-form').addEventListener('submit', (e) => { e.preventDefault(); loadAdminRecords(); });

  // 오늘 지점별 현황
  async function loadTodaySummary() {
    const today = ymd(new Date());
    const { data, error } = await fetchAll(() => sb.from('attendance')
      .select('id, user_id, branch_id, clock_out').eq('work_date', today).order('id'));
    const tbody = $('today-summary');
    if (error) { tbody.innerHTML = `<tr><td colspan="7" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    const byUser = new Map(data.map((r) => [r.user_id, r]));
    const groups = [...branches.map((b) => ({ id: b.id, name: b.name, active: b.is_active })), { id: null, name: '지점 미지정', active: true }];
    const total = { staff: 0, in: 0, working: 0, out: 0, absent: 0 };
    const rows = groups.map((g) => {
      const members = staff.filter((s) => (s.branch_id ?? null) === g.id && isActive(s.id));
      // 출근 인원은 "기록된 지점" 기준 (오늘 지점을 옮긴 경우 대비)
      const recs = data.filter((r) => (r.branch_id ?? null) === g.id);
      const absent = members.filter((s) => !byUser.has(s.id));
      const c = {
        staff: members.length, in: recs.length,
        working: recs.filter((r) => !r.clock_out).length,
        out: recs.filter((r) => r.clock_out).length,
        absent: absent.length,
      };
      if (!c.staff && !c.in && (g.id === null || !g.active)) return '';
      Object.keys(total).forEach((k) => { total[k] += c[k]; });
      return `<tr>
        <td>${esc(g.name)}</td><td class="num">${c.staff}</td><td class="num">${c.in}</td>
        <td class="num">${c.working}</td><td class="num">${c.out}</td><td class="num">${c.absent}</td>
        <td class="absent">${absent.map((s) => esc(s.name)).join(', ')}</td></tr>`;
    }).join('');
    tbody.innerHTML = rows
      ? rows + `<tr class="total"><td>합계</td><td class="num">${total.staff}</td><td class="num">${total.in}</td><td class="num">${total.working}</td><td class="num">${total.out}</td><td class="num">${total.absent}</td><td></td></tr>`
      : '<tr><td colspan="7" class="empty">등록된 지점이나 직원이 없습니다.</td></tr>';
  }
  $('today-refresh').addEventListener('click', loadTodaySummary);

  let adminLoadSeq = 0;
  async function loadAdminRecords() {
    const fb = $('f-branch').value;
    const fu = $('f-user').value;
    const from = $('f-from').value;
    const to = $('f-to').value;
    if (!from || !to) return;
    const seq = ++adminLoadSeq;
    const tbody = $('admin-records');
    tbody.innerHTML = '<tr><td colspan="9" class="empty">불러오는 중...</td></tr>';
    $('staff-summary').innerHTML = '<tr><td colspan="7" class="empty">불러오는 중...</td></tr>';

    const { data, error } = await fetchAll(() => {
      let q = sb.from('attendance')
        .select('*, branch:branches(name), profile:profiles!attendance_user_id_fkey(name), editor:profiles!attendance_updated_by_fkey(name)')
        .gte('work_date', from).lte('work_date', to)
        .order('work_date', { ascending: false }).order('clock_in', { ascending: true }).order('id');
      if (fb === 'none') q = q.is('branch_id', null);
      else if (fb) q = q.eq('branch_id', fb);
      if (fu) q = q.eq('user_id', fu);
      return q;
    });
    if (seq !== adminLoadSeq) return; // 그 사이 조건이 바뀌어 새 조회가 시작됨 → 이전 결과는 버림
    if (error) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty">${esc(errMsg(error))}</td></tr>`;
      $('staff-summary').innerHTML = '';
      return;
    }
    adminRows = data;
    renderStaffSummary();
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">기록이 없습니다.</td></tr>'; $('admin-summary').textContent = ''; return; }
    tbody.innerHTML = data.map((r) => `
      <tr>
        <td>${dateLabel(r.work_date)}</td>
        <td>${esc(r.branch?.name || '미지정')}</td>
        <td>${esc(r.profile?.name)}</td>
        <td>${hm(r.clock_in)}</td>
        <td>${r.clock_out ? hm(r.clock_out) : '<span class="tag-open">미퇴근</span>'}</td>
        <td>${fmtDur(durMs(r))}</td>
        <td class="note">${esc(r.note)}</td>
        <td class="edited">${r.updated_at ? `${esc(r.editor?.name || '알 수 없음')} · ${ymd(r.updated_at).slice(5)} ${hm(r.updated_at)}` : ''}</td>
        <td><button class="btn small" data-edit="${r.id}">수정</button></td>
      </tr>`).join('');
    const total = data.reduce((s, r) => s + durMs(r), 0);
    const open = data.filter((r) => !r.clock_out).length;
    $('admin-summary').textContent = `${data.length.toLocaleString()}건 · 총 근무시간 ${fmtDur(total)}${open ? ` · 미퇴근 ${open}건` : ''}`;
  }

  // 직원별 요약 (현재 조회 조건 기준)
  let summaryRows = [];
  function buildStaffSummary() {
    const fb = $('f-branch').value;
    const fu = $('f-user').value;
    const map = new Map();
    // 기록이 없는 직원도 0일로 표시
    staff.filter((s) => matchBranch(s.branch_id, fb) && (!fu || s.id === fu) && isActive(s.id)).forEach((s) => {
      map.set(s.id, { name: s.name, homeBranch: s.branch_id, branches: new Set(), days: 0, total: 0, doneDays: 0, open: 0, edited: 0 });
    });
    adminRows.forEach((r) => {
      let e = map.get(r.user_id);
      if (!e) {
        e = { name: r.profile?.name || '(알 수 없음)', homeBranch: null, branches: new Set(), days: 0, total: 0, doneDays: 0, open: 0, edited: 0 };
        map.set(r.user_id, e);
      }
      e.branches.add(r.branch?.name || '미지정');
      e.days += 1;
      if (r.clock_out) { e.total += durMs(r); e.doneDays += 1; } else { e.open += 1; }
      if (r.updated_at) e.edited += 1;
    });
    return [...map.values()]
      .map((e) => ({
        ...e,
        branchLabel: e.branches.size ? [...e.branches].join(', ') : branchName(e.homeBranch),
        avg: e.doneDays ? e.total / e.doneDays : 0,
      }))
      .sort((a, b) => a.branchLabel.localeCompare(b.branchLabel, 'ko') || a.name.localeCompare(b.name, 'ko'));
  }

  function renderStaffSummary() {
    summaryRows = buildStaffSummary();
    const tbody = $('staff-summary');
    if (!summaryRows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">해당 직원이 없습니다.</td></tr>'; return; }
    const sum = summaryRows.reduce((s, e) => ({ days: s.days + e.days, total: s.total + e.total, open: s.open + e.open, edited: s.edited + e.edited }), { days: 0, total: 0, open: 0, edited: 0 });
    tbody.innerHTML = summaryRows.map((e) => `
      <tr class="${e.days ? '' : 'zero'}">
        <td>${esc(e.branchLabel)}</td>
        <td>${esc(e.name)}</td>
        <td class="num">${e.days}일</td>
        <td class="num">${fmtDur(e.total)}</td>
        <td class="num">${fmtDur(e.avg)}</td>
        <td class="num">${e.open ? `<span class="tag-open">${e.open}건</span>` : '-'}</td>
        <td class="num">${e.edited ? `${e.edited}건` : '-'}</td>
      </tr>`).join('') + `
      <tr class="total">
        <td>합계</td><td>${summaryRows.length}명</td>
        <td class="num">${sum.days}일</td><td class="num">${fmtDur(sum.total)}</td><td></td>
        <td class="num">${sum.open ? `${sum.open}건` : '-'}</td><td class="num">${sum.edited ? `${sum.edited}건` : '-'}</td>
      </tr>`;
  }

  $('summary-csv-btn').addEventListener('click', () => {
    if (!summaryRows.length) return alert('다운로드할 내용이 없습니다. 먼저 조회하세요.');
    const mins = (ms) => Math.floor(ms / 60000);
    const lines = [['기간', '지점', '이름', '근무일', '총 근무시간(분)', '총 근무시간(시간)', '일평균(분)', '미퇴근', '관리자 수정']];
    const period = `${$('f-from').value} ~ ${$('f-to').value}`;
    summaryRows.forEach((e) => lines.push([
      period, e.branchLabel, e.name, e.days, mins(e.total), (mins(e.total) / 60).toFixed(2),
      e.doneDays ? mins(e.avg) : '', e.open, e.edited,
    ]));
    downloadCsv(`근태요약_${$('f-from').value}_${$('f-to').value}.csv`, lines);
  });

  $('admin-records').addEventListener('click', (e) => {
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    if (id) openEdit(adminRows.find((r) => String(r.id) === id));
  });
  $('add-record-btn').addEventListener('click', () => openEdit(null));

  function openEdit(row) {
    editingId = row ? row.id : null;
    $('edit-title').textContent = row ? `기록 수정 - ${row.profile?.name || ''}` : '기록 추가';
    $('edit-user-wrap').hidden = !!row;
    $('edit-delete').hidden = !row;
    $('edit-in').value = row ? toInput(row.clock_in) : `${ymd(new Date())}T09:00`;
    $('edit-out').value = row ? toInput(row.clock_out) : '';
    $('edit-note').value = row?.note || '';
    if (!row && $('f-user').value) $('edit-user').value = $('f-user').value;
    showError($('edit-error'), '');
    $('edit-dialog').showModal();
  }
  $('edit-cancel').addEventListener('click', () => $('edit-dialog').close());

  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      clock_in: fromInput($('edit-in').value),
      clock_out: fromInput($('edit-out').value),
      note: $('edit-note').value.trim() || null,
    };
    if (payload.clock_out && payload.clock_out < payload.clock_in) {
      return showError($('edit-error'), '퇴근 시간이 출근 시간보다 빠릅니다.');
    }
    const { error } = editingId
      ? await sb.from('attendance').update(payload).eq('id', editingId)
      : await sb.from('attendance').insert({ ...payload, user_id: $('edit-user').value });
    if (error) return showError($('edit-error'), errMsg(error));
    $('edit-dialog').close();
    loadAdminRecords();
    loadTodaySummary();
    if (me) { refreshToday(); loadMyRecords(); }
  });

  $('edit-delete').addEventListener('click', async () => {
    if (!editingId || !confirm('이 기록을 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    const { error } = await sb.from('attendance').delete().eq('id', editingId);
    if (error) return showError($('edit-error'), errMsg(error));
    $('edit-dialog').close();
    loadAdminRecords();
    loadTodaySummary();
  });

  // CSV (엑셀에서 한글 깨짐 방지를 위해 BOM 포함)
  $('csv-btn').addEventListener('click', () => {
    if (!adminRows.length) return alert('다운로드할 기록이 없습니다. 먼저 조회하세요.');
    const lines = [['날짜', '지점', '이름', '출근', '퇴근', '근무시간(분)', '비고', '수정자', '수정일시']];
    adminRows.slice().reverse().forEach((r) => {
      const ms = durMs(r);
      lines.push([
        r.work_date, r.branch?.name || '미지정', r.profile?.name, hm(r.clock_in), r.clock_out ? hm(r.clock_out) : '',
        ms ? Math.floor(ms / 60000) : '', r.note, r.editor?.name,
        r.updated_at ? `${ymd(r.updated_at)} ${hm(r.updated_at)}` : '',
      ]);
    });
    downloadCsv(`근태상세_${$('f-from').value}_${$('f-to').value}.csv`, lines);
  });

  // 직원 관리
  function renderStaff() {
    if (!me) return;
    const fb = $('s-branch').value;
    const curNa = $('na-branch').value;
    $('na-branch').innerHTML = branchOptions({ onlyActive: true });
    $('na-branch').value = curNa;
    const statusKnown = authStatus.size > 0;
    const showDeleted = $('s-show-deleted').checked;
    const list = staff.filter((s) => matchBranch(s.branch_id, fb) && (showDeleted || !s.deleted_at))
      .sort((a, b) => (!!a.deleted_at - !!b.deleted_at) || (isActive(b.id) - isActive(a.id)) || a.name.localeCompare(b.name, 'ko'));
    $('staff-list').innerHTML = list.map((s) => {
      if (s.deleted_at) {
        return `
      <tr data-id="${s.id}" class="inactive">
        <td>${esc(s.name)}</td>
        <td>${esc(branchName(s.branch_id))}</td>
        <td>${esc(loginIdOf(s.email))}</td>
        <td><span class="muted">삭제됨</span></td>
        <td class="edited">퇴사 처리 ${ymd(s.deleted_at)}</td>
        <td></td>
        <td class="muted small">기록 보존</td>
      </tr>`;
      }
      const st = authStatus.get(s.id);
      const active = isActive(s.id);
      const self = s.id === me.id;
      const last = st?.last_sign_in_at ? `${ymd(st.last_sign_in_at)} ${hm(st.last_sign_in_at)}` : (statusKnown ? '없음' : '-');
      return `
      <tr data-id="${s.id}" class="${active ? '' : 'inactive'}">
        <td><input type="text" value="${esc(s.name)}" maxlength="30" data-field="name"></td>
        <td><select data-field="branch_id">${branchOptions({ current: s.branch_id, onlyActive: true })}</select></td>
        <td>${esc(loginIdOf(s.email))}</td>
        <td>${statusKnown ? (active ? '<span class="status-on">사용 중</span>' : '<span class="status-off">비활성</span>') : '-'}</td>
        <td class="edited">${last}</td>
        <td><input type="checkbox" data-field="is_admin" ${s.is_admin ? 'checked' : ''} ${self ? 'disabled title="본인의 관리자 권한은 해제할 수 없습니다"' : ''}></td>
        <td class="actions">
          <button class="btn small" data-save>저장</button>
          <button class="btn small" data-reset>비밀번호 초기화</button>
          ${self ? '' : `<button class="btn small" data-toggle="${active ? 'off' : 'on'}">${active ? '비활성화' : '다시 사용'}</button>`}
          ${!self && statusKnown && !active ? '<button class="btn small danger-outline" data-delete>삭제</button>' : ''}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">직원이 없습니다.</td></tr>';
  }

  // 아이디는 항상 소문자로 저장되므로 입력하는 즉시 소문자로 바꿔서 보여줌
  $('na-id').addEventListener('input', (e) => {
    const el = e.target;
    const lower = el.value.toLowerCase();
    if (lower !== el.value) {
      const pos = el.selectionStart;
      el.value = lower;
      el.setSelectionRange(pos, pos);
    }
  });

  // 직원 추가
  $('staff-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('na-msg');
    const btn = e.submitter; btn.disabled = true;
    msg.hidden = true;
    const loginId = $('na-id').value.trim().toLowerCase();
    const name = $('na-name').value.trim();
    try {
      await staffApi({
        action: 'create',
        login_id: loginId,
        domain: CFG.EMAIL_DOMAIN,
        name,
        password: $('na-pw').value,
        branch_id: $('na-branch').value || null,
        is_admin: $('na-admin').checked,
      });
      msg.textContent = `${name}(${loginId}) 직원을 추가했습니다. 아이디와 초기 비밀번호를 직원에게 전달하세요.`;
      msg.className = 'msg ok';
      $('staff-add-form').reset();
      await Promise.all([loadStaff(), loadAuthStatus()]);
      renderStaff();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg err';
    } finally {
      msg.hidden = false;
      btn.disabled = false;
    }
  });

  // 비밀번호 초기화 / 비활성화
  let resetTarget = null;
  $('staff-list').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const s = staff.find((x) => x.id === tr.dataset.id);
    if (!s) return;

    if (e.target.matches('[data-reset]')) {
      resetTarget = s;
      $('reset-title').textContent = `비밀번호 초기화 - ${s.name}`;
      $('reset-form').reset();
      showError($('reset-error'), '');
      $('reset-dialog').showModal();
    } else if (e.target.matches('[data-delete]')) {
      const typed = prompt(
        `${s.name} 계정을 삭제합니다.\n\n` +
        '- 로그인 계정은 완전히 삭제되어 되돌릴 수 없습니다.\n' +
        '- 이름과 근태 기록은 "퇴사" 상태로 보존됩니다.\n' +
        '- 같은 아이디로 새 직원을 다시 만들 수 있습니다.\n\n' +
        `계속하려면 직원 이름 "${s.name}"을(를) 정확히 입력하세요.`,
      );
      if (typed === null) return;
      if (typed.trim() !== s.name) return alert('이름이 일치하지 않아 삭제하지 않았습니다.');
      e.target.disabled = true;
      try {
        await staffApi({ action: 'delete', user_id: s.id });
        await Promise.all([loadStaff(), loadAuthStatus()]);
        renderStaff();
        alert(`${s.name} 계정을 삭제했습니다. 근태 기록은 보존됩니다.`);
      } catch (err) {
        alert(err.message);
        e.target.disabled = false;
      }
    } else if (e.target.matches('[data-toggle]')) {
      const turnOn = e.target.dataset.toggle === 'on';
      const q = turnOn
        ? `${s.name} 계정을 다시 사용하도록 하시겠습니까?`
        : `${s.name} 계정을 비활성화하시겠습니까?\n로그인이 막히고, 근태 기록은 그대로 보존됩니다.`;
      if (!confirm(q)) return;
      e.target.disabled = true;
      try {
        await staffApi({ action: 'set_active', user_id: s.id, active: turnOn });
        await loadAuthStatus();
        renderStaff();
      } catch (err) {
        alert(err.message);
        e.target.disabled = false;
      }
    }
  });
  $('reset-cancel').addEventListener('click', () => $('reset-dialog').close());
  $('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!resetTarget) return;
    const btn = e.submitter; btn.disabled = true;
    try {
      await staffApi({ action: 'reset_password', user_id: resetTarget.id, password: $('reset-pw').value });
      $('reset-dialog').close();
      alert(`${resetTarget.name}님의 비밀번호를 초기화했습니다.`);
    } catch (err) {
      showError($('reset-error'), err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('s-branch').addEventListener('change', renderStaff);
  $('s-show-deleted').addEventListener('change', renderStaff);

  $('staff-list').addEventListener('click', async (e) => {
    if (!e.target.matches('[data-save]')) return;
    const tr = e.target.closest('tr');
    const name = tr.querySelector('[data-field="name"]').value.trim();
    if (!name) return alert('이름을 입력하세요.');
    const bv = tr.querySelector('[data-field="branch_id"]').value;
    const update = { name, branch_id: bv ? Number(bv) : null };
    if (tr.dataset.id !== me.id) update.is_admin = tr.querySelector('[data-field="is_admin"]').checked;
    e.target.disabled = true;
    const { error } = await sb.from('profiles').update(update).eq('id', tr.dataset.id);
    e.target.disabled = false;
    if (error) return alert(errMsg(error));
    e.target.textContent = '저장됨';
    setTimeout(() => { e.target.textContent = '저장'; }, 1500);
    if (tr.dataset.id === me.id) {
      me.name = name;
      me.branch_id = update.branch_id;
      me.branch = update.branch_id ? { name: branchName(update.branch_id) } : null;
      setUserLabel();
    }
    await loadStaff();
  });

  // 지점 관리
  function renderBranches() {
    $('branch-list').innerHTML = branches.map((b) => `
      <tr data-id="${b.id}">
        <td><input type="text" value="${esc(b.name)}" maxlength="30" data-field="name"></td>
        <td class="num">${staff.filter((s) => s.branch_id === b.id).length}명</td>
        <td><input type="checkbox" data-field="is_active" ${b.is_active ? 'checked' : ''}></td>
        <td>
          <button class="btn small" data-bsave>저장</button>
          <button class="btn small" data-bdel>삭제</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">등록된 지점이 없습니다. 위에서 지점을 추가하세요.</td></tr>';
  }

  $('branch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('branch-name').value.trim();
    if (!name) return;
    const { error } = await sb.from('branches').insert({ name });
    if (error) return alert(errMsg(error));
    $('branch-name').value = '';
    await loadBranches();
    renderBranches();
  });

  $('branch-list').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    if (e.target.matches('[data-bsave]')) {
      const name = tr.querySelector('[data-field="name"]').value.trim();
      if (!name) return alert('지점 이름을 입력하세요.');
      const { error } = await sb.from('branches')
        .update({ name, is_active: tr.querySelector('[data-field="is_active"]').checked }).eq('id', id);
      if (error) return alert(errMsg(error));
      e.target.textContent = '저장됨';
      setTimeout(() => { e.target.textContent = '저장'; }, 1500);
      await loadBranches();
      if (me.branch_id === id) { me.branch = { name }; setUserLabel(); }
    } else if (e.target.matches('[data-bdel]')) {
      if (!confirm(`'${branchName(id)}' 지점을 삭제하시겠습니까?`)) return;
      const { error } = await sb.from('branches').delete().eq('id', id);
      if (error) return alert(errMsg(error));
      await loadBranches();
      renderBranches();
    }
  });

  // ---------------------------------------------------------------
  //  시작
  // ---------------------------------------------------------------
  (async () => {
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) enterApp(data.session.user);
    else showView('login');
  })();
})();
