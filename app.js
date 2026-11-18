/* =====================================================================
 *  근태 시스템 프론트엔드 (Supabase + 정적 호스팅)
 * ===================================================================== */
(() => {
  'use strict';

  const CFG = window.CONFIG || {};
  const TZ = 'Asia/Seoul';
  const $ = (id) => document.getElementById(id);

  // ⚠ 직원 분류(근무조/직무) 기능 스위치 — 아직 적용 보류 중 (DB에 job_groups 표·칸이 없음)
  //   적용할 때: schema.sql 16절 마이그레이션 + manage-staff 배포 후 true 로 바꿈
  const FEATURE_JOB_GROUPS = false;
  if (!FEATURE_JOB_GROUPS) document.querySelectorAll('.feat-job').forEach((el) => { el.hidden = true; });

  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
    $('config-warning').hidden = false;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL || 'https://invalid.supabase.co', CFG.SUPABASE_ANON_KEY || 'invalid');

  let me = null;          // 로그인한 사용자 profile
  let staff = [];         // (관리자) 직원 목록
  let branches = [];      // 점포 목록
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

  // ---- 근무시간 집계: 정규(점포 근무시간 안) + 승인된 초과근무(실제 근무와 겹치는 부분) ----
  const kstAt = (dateStr, time) => new Date(`${dateStr}T${String(time).slice(0, 5)}:00+09:00`).getTime();
  const overlapMs = (s1, e1, s2, e2) => Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  const tmLabel = (t) => (t ? String(t).slice(0, 5) : '');

  // 점포별 특정일 근무시간 (branch_special_hours): `${branch_id}|${날짜}` → { work_start, work_end, note }
  let specialHours = new Map();
  async function loadSpecialHours() {
    const since = shiftDate(ymd(new Date()), -400);
    const { data, error } = await fetchAll(() => sb.from('branch_special_hours').select('*').gte('work_date', since).order('work_date').order('id'));
    if (error) return;
    specialHours = new Map(data.map((h) => [`${h.branch_id}|${h.work_date}`, h]));
  }
  // 지원 근무 (support_assignments): 직원이 기간 동안 다른 점포에서 근무. 직원은 본인 것만 받아 옴
  let supports = [];
  async function loadSupports() {
    if (!me) return;
    const since = shiftDate(ymd(new Date()), -60);
    const { data, error } = await fetchAll(() => sb.from('support_assignments')
      .select('*, to_branch:branches!support_assignments_to_branch_id_fkey(id, name, lat, lng, radius_m, work_start, work_end), from_branch:branches!support_assignments_from_branch_id_fkey(name), person:profiles!support_assignments_user_id_fkey(name)')
      .gte('end_date', since).order('start_date').order('id'));
    if (error) return;
    supports = data;
  }
  const supportOn = (uid, date) => supports.find((s) => s.user_id === uid && s.start_date <= date && date <= s.end_date) || null;
  // 그날 내가 근무하는 점포 (지원 근무면 지원 점포). { id, name, lat, lng, radius_m, work_start, work_end, support }
  function myBranchOn(date) {
    const s = me ? supportOn(me.id, date) : null;
    if (s?.to_branch) return { ...s.to_branch, id: s.to_branch_id, support: s };
    return me?.branch ? { ...me.branch, id: me.branch_id, support: null } : null;
  }
  const supportLabel = (s) => `${s.start_date === s.end_date ? dateLabel(s.start_date) : `${dateLabel(s.start_date)}~${dateLabel(s.end_date)}`}`;

  // 그 날짜의 점포 정규 근무시간 (특정일이 있으면 그 시간). b: 점포 정보(평소 시간)
  function hoursFor(branchId, date, b) {
    const sp = branchId != null ? specialHours.get(`${branchId}|${date}`) : null;
    if (sp) return { start: sp.work_start, end: sp.work_end, special: true, note: sp.note || '' };
    return { start: b?.work_start || null, end: b?.work_end || null, special: false, note: '' };
  }

  // 정규 근무시간: 기록 당시 점포의 정규시간(그날 특정일 시간 우선) 안에서 실제로 근무한 시간 (점포 정보 없으면 실제 전체)
  function regularMs(row) {
    if (!row.clock_in || !row.clock_out) return 0;
    const s = +new Date(row.clock_in);
    const e = +new Date(row.clock_out);
    const h = hoursFor(row.branch_id, row.work_date, row.branch);
    if (!h.start || !h.end) return e - s;
    return overlapMs(s, e, kstAt(row.work_date, h.start), kstAt(row.work_date, h.end));
  }
  // 이 출근 기록과 겹치는 승인 초과근무 시간
  function approvedOtMsForRow(row, reqs) {
    if (!row.clock_out) return 0;
    const s = +new Date(row.clock_in);
    const e = +new Date(row.clock_out);
    return reqs.filter((q) => q.status === 'approved' && q.user_id === row.user_id)
      .reduce((t, q) => t + overlapMs(s, e, +new Date(q.start_at), +new Date(q.end_at)), 0);
  }
  // 정규시간 밖 미승인 근무는 10분 이상일 때만 화면에 표시 (조금 일찍 출근한 경우 등은 생략)
  const UNAPPROVED_SHOW_MS = 10 * 60 * 1000;
  // 정규시간 밖에서 근무했지만 승인되지 않은 시간 (관리자 확인용)
  const unapprovedMsForRow = (row, reqs) =>
    Math.max(0, durMs(row) - regularMs(row) - approvedOtMsForRow(row, reqs));
  // 초과근무 신청 1건의 인정 시간 (실제 근무와 겹치는 부분)
  function recognizedOtMs(req, attRows) {
    if (req.status !== 'approved') return 0;
    const rs = +new Date(req.start_at);
    const re = +new Date(req.end_at);
    return attRows.filter((a) => a.user_id === req.user_id && a.clock_out)
      .reduce((t, a) => t + overlapMs(rs, re, +new Date(a.clock_in), +new Date(a.clock_out)), 0);
  }
  const OT_STATUS = {
    pending: ['대기', 'st-pending'], approved: ['승인', 'st-approved'],
    rejected: ['반려', 'st-rejected'], cancelled: ['취소', 'st-cancelled'],
  };
  const otStatusTag = (s) => `<span class="st ${OT_STATUS[s]?.[1] || ''}">${OT_STATUS[s]?.[0] || s}</span>`;
  const otTimeLabel = (q) => {
    const nextDay = ymd(q.end_at) !== ymd(q.start_at) ? '(익일)' : '';
    return `${hm(q.start_at)}~${nextDay}${hm(q.end_at)}`;
  };
  const shiftDate = (dateStr, days) => {
    const d = new Date(`${dateStr}T12:00:00+09:00`);
    d.setUTCDate(d.getUTCDate() + days);
    return ymd(d);
  };
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
    if (/branches_name_key/.test(m)) return '같은 이름의 점포가 이미 있습니다.';
    if (/foreign key/i.test(m) && /branch/i.test(m)) return '소속 직원이나 출퇴근 기록이 있는 점포는 삭제할 수 없습니다. 대신 "사용"을 해제하세요.';
    if (/Failed to fetch|NetworkError/i.test(m)) return '서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.';
    if (error?.status === 429 || /rate limit/i.test(m)) return '접속이 원활하지 않습니다.\n1~2분 뒤 다시 시도해 주세요.';
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

  // 엑셀(.xlsx) 파일 만들기 (SheetJS는 처음 다운로드할 때만 불러옴)
  //  lines: 첫 줄은 제목, 숫자는 숫자 칸·글자는 텍스트 칸으로 저장
  //  textCols: 항상 텍스트로 둘 칸 번호 (0으로 시작하는 사번·비밀번호가 숫자로 바뀌지 않게)
  //  blankRows: 빈 입력 줄 수 (양식용, textCols 칸을 미리 텍스트 서식으로)
  //  sheets: 추가 시트 [{ name, lines }]
  // 엑셀 칸 서식
  const XB = { style: 'thin', color: { rgb: 'A6A6A6' } };
  const XS = {
    border: { top: XB, bottom: XB, left: XB, right: XB },
    get head() { return { font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: 'DDE6F4' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: this.border }; },
  };
  function makeSheet(X, lines, { textCols = [], blankRows = 0, filter = true } = {}) {
    const ws = X.utils.aoa_to_sheet(lines.map((l) => l.map((v) => (v == null ? '' : v))));
    const strW = (v) => [...String(v ?? '')].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
    const nCols = Math.max(...lines.map((l) => l.length));
    ws['!cols'] = Array.from({ length: nCols }, (_, c) => ({ wch: Math.min(50, Math.max(8, ...lines.map((l) => strW(l[c]) + 2))) }));
    const lastRow = lines.length - 1 + blankRows;
    textCols.forEach((c) => {
      for (let r = 1; r <= lastRow; r++) {
        const ref = X.utils.encode_cell({ r, c });
        const cell = ws[ref] || (ws[ref] = { t: 's', v: '' });
        if (cell.t === 'n') { cell.t = 's'; cell.v = String(cell.v); }
        cell.z = '@';
      }
    });
    if (blankRows) ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: nCols - 1 } });
    // 제목 줄: 굵게 + 배경색 + 테두리
    for (let c = 0; c < nCols; c++) {
      const cell = ws[X.utils.encode_cell({ r: 0, c })];
      if (cell) cell.s = XS.head;
    }
    if (filter && lines.length > 1) ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lines.length - 1, c: nCols - 1 } }) };
    return ws;
  }
  async function downloadXlsx(filename, lines, { sheetName = '목록', sheets = [], ...opts } = {}) {
    try { await loadXlsx(); } catch (e) { alert(e.message); return; }
    const X = window.XLSX;
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, makeSheet(X, lines, opts), sheetName);
    sheets.forEach((s) => X.utils.book_append_sheet(wb, makeSheet(X, s.lines, { filter: false }), s.name));
    X.writeFile(wb, filename, { compression: true });
  }

  function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
  }

  // 휴대폰에서 넓은 표를 카드 모양으로 보여 주기 위해, 각 칸에 제목(data-label)을 붙임 (표 내용이 바뀔 때마다 자동)
  function labelTable(table) {
    const heads = [...(table.tHead?.rows[0]?.cells || [])].filter((c) => !c.hidden).map((c) => c.textContent.trim());
    [...table.tBodies[0].rows].forEach((tr) => {
      let i = 0;
      [...tr.cells].forEach((td) => {
        const label = td.colSpan > 1 ? '' : (heads[i] || '');
        if (td.dataset.label !== label) td.dataset.label = label;
        i += td.colSpan;
      });
    });
  }
  document.querySelectorAll('table.stack').forEach((t) => {
    new MutationObserver(() => labelTable(t)).observe(t.tBodies[0], { childList: true });
  });

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
    const { data, error } = await sb.from('profiles').select('*, branch:branches(name, lat, lng, radius_m, work_start, work_end)').eq('id', user.id).single();
    if (error || !data) {
      await sb.auth.signOut({ scope: 'local' });
      showView('login');
      showError($('login-error'), '사용자 정보를 불러오지 못했습니다. 매니저에게 문의하세요.');
      return;
    }
    me = data;
    adminLoaded = false; otLoaded = false; authStatus = new Map(); // 다른 계정으로 다시 로그인한 경우 대비
    setUserLabel();
    // 관리 화면: 본사 관리자 또는 점포 관리자(담당 점포만)
    $('admin-tab').hidden = !(me.is_admin || isManager());
    document.querySelectorAll('.hq-only').forEach((el) => { el.hidden = !me.is_admin; }); // '관리자 메뉴' 탭은 매니저만
    $('manager-note').hidden = me.is_admin || !isManager();
    $('manager-note').textContent = isManager() && !me.is_admin
      ? `${me.branch?.name || ''} 슈퍼바이저 · 담당 점포만 조회·처리할 수 있습니다 (본인 기록·초과근무는 매니저가 처리)` : '';
    await Promise.all([loadSpecialHours(), loadSupports()]); // 특정일 근무시간·지원 근무 (정규 근무 계산·GPS에 필요)
    loadNotices(); // 공지사항 (새 공지 수 표시)
    switchTab('employee');
    showView('app');
    checkSession();
    startGps();
    refreshToday();
    setupOvertimeForm();
    loadMyRecords();
    loadMyOvertime();
  }

  // 점포 관리자(본사 관리자가 아니고, 소속 점포가 있는 경우만 유효)
  const isManager = () => !!(me && !me.is_admin && me.is_branch_manager && me.branch_id);

  function setUserLabel() {
    $('user-name').textContent = me.branch?.name ? `${me.branch.name} · ${me.name}님` : `${me.name}님`;
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('login-error'), '');
    let id = $('login-id').value.trim().toLowerCase();
    if (!id.includes('@') && CFG.EMAIL_DOMAIN) id = `${id}@${CFG.EMAIL_DOMAIN}`;
    const btn = e.submitter; btn.disabled = true;
    const pw = $('login-pw').value;
    const MAX = 6;
    let data = null;
    let error = null;
    showBusy('로그인 중', '접속이 지연되고 있습니다.\n화면을 닫거나 다시 누르지 말고\n기다려 주세요.');
    try {
      for (let attempt = 1; attempt <= MAX; attempt++) {
        let res;
        try { res = await sb.auth.signInWithPassword({ email: id, password: pw }); }
        catch (err) { res = { data: null, error: err }; }
        if (!res.error) { data = res.data; error = null; break; }
        error = res.error;
        const st = error.status || 0;
        const busy = st === 429 || /rate limit/i.test(error.message || '');
        if (attempt === MAX || !(busy || retryable({ error, status: st }))) break;
        $('busy-text').dataset.retry = '1';
        $('busy-text').textContent = busy
          ? `접속자가 많아 순서를 기다리고 있습니다.\n자동으로 다시 시도합니다. (${attempt}/${MAX - 1})`
          : `접속이 원활하지 않아\n자동으로 다시 시도합니다. (${attempt}/${MAX - 1})`;
        // 접속 제한(429)은 조금 길게, 사람마다 다르게 기다렸다가 재시도
        await sleep(busy ? 5000 + Math.random() * 10000 : 1000 * attempt + Math.random() * 2000);
      }
      if (!error) {
        $('busy-text').dataset.retry = '1';
        $('busy-text').textContent = '내 정보를 불러오는 중입니다...';
        $('login-pw').value = '';
        // 이중 로그인 방지: 같은 아이디로 로그인되어 있던 다른 기기를 끊음 (매니저는 서버에서 예외 처리)
        try { await sb.rpc('claim_single_session'); } catch (_) { /* 실패해도 로그인은 계속 */ }
        await enterApp(data.user);
      }
    } finally {
      hideBusy();
      btn.disabled = false;
    }
    if (error) showError($('login-error'), errMsg(error));
  });

  $('logout-btn').addEventListener('click', async () => {
    // 'local': 이 기기에서만 로그아웃 (다른 기기의 로그인은 유지)
    await sb.auth.signOut({ scope: 'local' });
    me = null;
    stopGps();
    showView('login');
  });

  // ---- 강제 로그아웃 확인: 매니저가 이 기기의 로그인을 끊었으면 로그인 화면으로 ----
  //  1분마다(화면이 보일 때만) + 앱을 다시 열 때 확인. 통신 오류일 때는 그냥 넘어감
  const SESSION_CHECK_MS = 60 * 1000;
  let sessionChecking = false;
  async function kickedOut(msg) {
    await sb.auth.signOut({ scope: 'local' });
    me = null;
    stopGps();
    hideBusy();
    showView('login');
    showError($('login-error'), msg || '다른 기기에서 로그인이 확인되어 로그아웃되었습니다.\n다시 로그인해 주세요.');
  }
  async function checkSession() {
    if (!me || sessionChecking || document.hidden) return;
    sessionChecking = true;
    try {
      const { data, error } = await sb.rpc('session_valid');
      if (!error && data === false && me) await kickedOut();
    } catch (_) { /* 통신 오류는 다음 확인 때 다시 */ }
    finally { sessionChecking = false; }
  }
  setInterval(checkSession, SESSION_CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { me = null; showView('login'); }
  });

  // ---------------------------------------------------------------
  //  탭
  // ---------------------------------------------------------------
  function switchTab(view) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('employee-view').hidden = view !== 'employee';
    $('notice-view').hidden = view !== 'notice';
    // 근태 관리 / 관리자 메뉴: 같은 화면, 위 탭에 맞는 작은 탭 줄만 보이고 마지막으로 보던 작은 탭을 다시 엶
    const adm = view === 'admin' || view === 'hq';
    $('admin-view').hidden = !adm;
    if (adm) {
      document.querySelectorAll('#admin-view .subtabs[data-for]').forEach((r) => { r.hidden = r.dataset.for !== view; });
      const row = document.querySelector(`#admin-view .subtabs[data-for="${view}"]`);
      (row.querySelector('[data-sub].active') || row.querySelector('[data-sub]')).click();
    }
    if (view === 'notice') {
      renderNotices();
      // 매니저는 '읽음 N / 전체 M명'을 보려고 직원 수가 필요
      Promise.all([loadNotices(), me?.is_admin && !staff.length ? loadStaff() : null]).then(renderNotices);
    }
  }

  // ---------------------------------------------------------------
  //  공지사항: 매니저만 작성·수정·삭제, 모두 읽기. 펼쳐 보면 '읽음'으로 기록
  // ---------------------------------------------------------------
  let notices = [];
  let noticeRead = new Set();   // 내가 읽은 공지 id
  let noticeReaders = new Map(); // (매니저) 공지 id → 읽은 사람 수
  const noticeOpen = new Set();  // 화면에서 펼친 공지
  async function loadNotices() {
    if (!me) return;
    const [n, r, c] = await Promise.all([
      sb.from('notices').select('*, author:profiles!notices_created_by_fkey(name)').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(200),
      sb.from('notice_reads').select('notice_id').eq('user_id', me.id),
      me.is_admin ? sb.rpc('notice_read_counts') : Promise.resolve({ data: [] }),
    ]);
    if (n.error) return;
    notices = n.data;
    noticeRead = new Set((r.data || []).map((x) => x.notice_id));
    notices.forEach((x) => { if (x.created_by === me.id) noticeRead.add(x.id); }); // 내가 쓴 공지는 읽은 것으로
    noticeReaders = new Map((c.data || []).map((x) => [x.notice_id, x.readers]));
    updateNoticeBadge();
  }
  function updateNoticeBadge() {
    const unread = notices.filter((x) => !noticeRead.has(x.id)).length;
    $('notice-badge').textContent = unread;
    $('notice-badge').hidden = !unread;
  }
  const fmtDateTime = (d) => `${ymd(d)} ${hm(d)}`;
  // 공지 본문: 글은 그대로(줄바꿈 유지), [[홈화면안내:아이폰]] / [[홈화면안내:안드로이드]] 자리에는 단계별 그림 안내를 넣음
  const NOTICE_GUIDES = { '홈화면안내:아이폰': 'ios', '홈화면안내:안드로이드': 'android' };
  function noticeBodyHtml(body) {
    return String(body || '').split(/\[\[([^\]]+)\]\]/).map((part, i) => {
      if (i % 2 === 0) return part.trim() ? `<div class="notice-text">${esc(part.replace(/^\n+|\n+$/g, ''))}</div>` : '';
      const os = NOTICE_GUIDES[part.trim()];
      if (!os || !STEPS[os]) return `<div class="notice-text">${esc(`[[${part}]]`)}</div>`;
      return `<div class="notice-guide">${STEPS[os].map((s, k) => `
        <div class="a2hs-step">
          <p><span class="a2hs-num">${k + 1}</span>${s.text}</p>
          ${s.svg}
          ${s.sub ? `<p class="sub">${s.sub}</p>` : ''}
        </div>`).join('')}</div>`;
    }).join('');
  }
  function renderNotices() {
    $('notice-new').hidden = !me?.is_admin;
    const total = staff.filter((s) => !s.deleted_at).length;
    $('notice-list').innerHTML = notices.map((x) => {
      const open = noticeOpen.has(x.id);
      const isNew = !noticeRead.has(x.id);
      const readers = noticeReaders.get(x.id) || 0;
      return `<article class="notice ${x.pinned ? 'pinned' : ''} ${open ? 'open' : ''}" data-id="${x.id}">
        <button type="button" class="notice-head" data-notice-toggle aria-expanded="${open}">
          <span class="notice-title">${x.pinned ? '<span class="pin">📌 중요</span>' : ''}${isNew ? '<span class="new">NEW</span>' : ''}${esc(x.title)}</span>
          <span class="notice-meta">${fmtDateTime(x.created_at)}${x.author?.name ? ` · ${esc(x.author.name)}` : ''}</span>
        </button>
        ${open ? `<div class="notice-body">${noticeBodyHtml(x.body) || '<span class="muted">(내용 없음)</span>'}</div>
          ${x.updated_at ? `<p class="muted small notice-edited">수정됨 ${fmtDateTime(x.updated_at)}</p>` : ''}
          ${me?.is_admin ? `<div class="notice-admin">
            <span class="muted small">읽음 ${readers}${total ? ` / ${total}명` : '명'}</span>
            <span class="spacer"></span>
            <button type="button" class="btn small" data-notice-edit>수정</button>
            <button type="button" class="btn small danger-outline" data-notice-del>삭제</button>
          </div>` : ''}` : ''}
      </article>`;
    }).join('') || '<p class="muted empty-note">등록된 공지사항이 없습니다.</p>';
  }
  $('notice-list').addEventListener('click', async (e) => {
    const art = e.target.closest('.notice');
    if (!art) return;
    const x = notices.find((n) => n.id === Number(art.dataset.id));
    if (!x) return;
    if (e.target.closest('[data-notice-toggle]')) {
      if (noticeOpen.has(x.id)) noticeOpen.delete(x.id); else noticeOpen.add(x.id);
      if (!noticeRead.has(x.id)) {
        noticeRead.add(x.id);
        noticeReaders.set(x.id, (noticeReaders.get(x.id) || 0) + 1);
        updateNoticeBadge();
        sb.from('notice_reads').upsert({ notice_id: x.id, user_id: me.id }, { onConflict: 'notice_id,user_id', ignoreDuplicates: true }).then(() => {});
      }
      renderNotices();
    } else if (e.target.matches('[data-notice-edit]')) {
      openNoticeDialog(x);
    } else if (e.target.matches('[data-notice-del]')) {
      if (!confirm(`'${x.title}' 공지를 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
      const { error } = await sb.from('notices').delete().eq('id', x.id);
      if (error) return alert(errMsg(error));
      noticeOpen.delete(x.id);
      await loadNotices(); renderNotices();
    }
  });
  let noticeEditing = null;
  function openNoticeDialog(x) {
    noticeEditing = x || null;
    $('notice-dlg-title').textContent = x ? '공지 수정' : '새 공지 작성';
    $('notice-title').value = x?.title || '';
    $('notice-body').value = x?.body || '';
    $('notice-pinned').checked = !!x?.pinned;
    showError($('notice-error'), '');
    $('notice-dialog').showModal();
  }
  $('notice-new').addEventListener('click', () => openNoticeDialog(null));
  $('notice-cancel').addEventListener('click', () => $('notice-dialog').close());
  $('notice-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { title: $('notice-title').value.trim(), body: $('notice-body').value.trim(), pinned: $('notice-pinned').checked };
    if (!row.title) return showError($('notice-error'), '제목을 입력하세요.');
    const btn = e.submitter; btn.disabled = true;
    const { error } = noticeEditing
      ? await sb.from('notices').update(row).eq('id', noticeEditing.id)
      : await sb.from('notices').insert(row);
    btn.disabled = false;
    if (error) return showError($('notice-error'), errMsg(error));
    $('notice-dialog').close();
    await loadNotices(); renderNotices();
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.view)));

  // 작은 탭: 근태 관리(출퇴근 기록·초과근무 승인) / 관리자 메뉴(직원 목록~점포 관리)
  const STAFF_SUBS = ['staff', 'staff-add', 'support', 'job'];
  document.querySelectorAll('#admin-view [data-sub]').forEach((t) => t.addEventListener('click', () => {
    const sub = t.dataset.sub;
    t.parentElement.querySelectorAll('[data-sub]').forEach((x) => x.classList.toggle('active', x === t)); // 각 줄이 따로 기억
    document.querySelectorAll('#admin-view [data-group]').forEach((el) => { el.hidden = el.dataset.group !== sub; });
    if (sub === 'today' || sub === 'personal' || sub === 'daily') initAdmin(); // 처음엔 전부 불러오고, 이후엔 조용히 갱신
    if (sub === 'overtime') {
      // 이미 한 번 불러왔으면 화면은 그대로 두고 조용히 갱신, 처음이면 바로 조회
      if (adminLoaded) { loadOvertimeAdmin(otLoaded); loadOtBadge(); }
      else initAdmin().then(() => loadOvertimeAdmin());
      otLoaded = true;
    }
    // 이미 불러온 데이터로 먼저 바로 그리고, 최신 데이터가 오는 대로 다시 그림
    // 표 안에서 입력 중이면 다시 그리지 않음 (입력 내용이 지워지지 않도록)
    const later = (listId, render) => () => { if (!$(listId).contains(document.activeElement)) render(); };
    if (STAFF_SUBS.includes(sub)) {
      renderStaff();
      Promise.all([loadBranches(), loadStaff()]).then(later('staff-list', renderStaff)); // 빠른 DB 조회
      loadAuthStatus().then(later('staff-list', renderStaff)); // 계정 상태(Edge Function)는 느려서 따로
      loadSessions().then(later('staff-list', renderStaff)); // 로그인 중인 기기 수
      loadSupports().then(later('sp-form', renderStaff)); // 지원 근무
    }
    if (sub === 'branches') {
      renderBranches();
      Promise.all([loadBranches(), loadStaff(), loadSpecialHours()]).then(later('branch-list', renderBranches));
    }
    if (sub === 'retired') {
      renderRetired();
      Promise.all([loadBranches(), loadStaff(), loadRetiredSummary()]).then(renderRetired);
    }
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

    canIn = !(isOpen || (latest && latest.work_date === today));
    canOut = !!isOpen;
    applyClockButtons();
  }

  // 근무 상태로 가능한지(canIn/canOut) + GPS 반경 안인지 둘 다 만족해야 버튼 활성화
  let canIn = false;
  let canOut = false;
  function applyClockButtons() {
    const ok = gpsAllowed();
    $('clock-in-btn').disabled = !(canIn && ok);
    $('clock-out-btn').disabled = !(canOut && ok);
  }

  // ---------------------------------------------------------------
  //  GPS: 소속 점포 반경 안에서만 출퇴근 (서버에서도 다시 검사함)
  // ---------------------------------------------------------------
  let geo = { status: 'idle' }; // idle | locating | ok | denied | error | unsupported
  let geoWatch = null;

  // 오늘 근무하는 점포(지원 근무면 지원 점포)에 위치가 등록되어 있으면 GPS 확인 대상
  const branchLoc = () => {
    const b = myBranchOn(ymd(new Date()));
    return b && b.lat != null && b.lng != null ? b : null;
  };
  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const rad = (d) => (d * Math.PI) / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);
  const currentDist = () => {
    const b = branchLoc();
    return b && geo.status === 'ok' ? distanceM(b.lat, b.lng, geo.lat, geo.lng) : null;
  };
  function gpsAllowed() {
    const b = branchLoc();
    if (!b) return true; // 위치 미설정 점포 → 확인 안 함
    const d = currentDist();
    return d != null && d <= b.radius_m;
  }

  function stopGps() {
    if (geoWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
  }
  function startGps() {
    stopGps();
    if (!branchLoc()) { geo = { status: 'idle' }; renderGps(); return; }
    if (!navigator.geolocation || !window.isSecureContext) { geo = { status: 'unsupported' }; renderGps(); return; }
    if (geo.status !== 'ok') geo = { status: 'locating' };
    renderGps();
    geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        geo = { status: 'ok', lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
        renderGps();
      },
      (err) => {
        geo = { status: err.code === 1 ? 'denied' : 'error' };
        renderGps();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
  }

  function renderGps() {
    const b = branchLoc();
    $('gps-box').hidden = !b;
    if (b) {
      const el = $('gps-status');
      let text = '';
      let kind = '';
      if (geo.status === 'locating' || geo.status === 'idle') text = '📍 현재 위치를 확인하는 중입니다...';
      else if (geo.status === 'denied') { text = '위치 권한이 꺼져 있습니다. 휴대폰 설정에서 이 사이트의 위치 권한을 허용한 뒤 [위치 다시 확인]을 눌러주세요.'; kind = 'err'; }
      else if (geo.status === 'unsupported') { text = '이 브라우저에서는 위치를 확인할 수 없습니다. 휴대폰의 기본 브라우저(크롬·사파리)로 접속해 주세요.'; kind = 'err'; }
      else if (geo.status === 'error') { text = '위치를 확인하지 못했습니다. GPS(위치 서비스)를 켜고 [위치 다시 확인]을 눌러주세요.'; kind = 'err'; }
      else {
        const d = currentDist();
        const accText = geo.acc > 50 ? ` (GPS 오차 약 ±${Math.round(geo.acc)}m)` : '';
        if (d <= b.radius_m) { text = `📍 ${b.name}에서 약 ${fmtDist(d)} · 출퇴근 가능${accText}`; kind = 'ok'; }
        else { text = `📍 ${b.name}에서 약 ${fmtDist(d)} 떨어져 있습니다. 점포 반경 ${b.radius_m}m 안에서만 출퇴근할 수 있습니다.${accText}`; kind = 'err'; }
      }
      el.textContent = text;
      el.className = `gps-status ${kind}`;
    }
    applyClockButtons();
  }
  $('gps-retry').addEventListener('click', () => { geo = { status: 'locating' }; startGps(); });

  function setMsg(text, kind) {
    const el = $('clock-msg');
    el.textContent = text; el.className = `msg ${kind || ''}`; el.hidden = !text;
  }

  // 출퇴근 처리 중 전체 화면 로딩 (접속이 몰려 늦어질 때 안내 + 자동 재시도)
  let busyTimer = null;
  const preventLeave = (e) => { e.preventDefault(); e.returnValue = ''; };
  function showBusy(title, slowText) {
    const start = Date.now();
    $('busy-title').textContent = title;
    $('busy-text').textContent = '잠시만 기다려 주세요.';
    $('busy-sec').textContent = '';
    $('busy-overlay').hidden = false;
    window.addEventListener('beforeunload', preventLeave);
    clearInterval(busyTimer);
    busyTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - start) / 1000);
      if (sec >= 3 && !$('busy-text').dataset.retry) {
        $('busy-text').textContent = slowText;
      }
      $('busy-sec').textContent = sec >= 3 ? `${sec}초 경과` : '';
    }, 500);
  }
  function hideBusy() {
    clearInterval(busyTimer);
    delete $('busy-text').dataset.retry;
    $('busy-overlay').hidden = true;
    window.removeEventListener('beforeunload', preventLeave);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 통신 끊김·시간 초과·서버 혼잡이면 다시 시도할 가치가 있음
  const retryable = (res) => [0, 408, 429, 500, 502, 503, 504, 520, 522, 524].includes(res.status || 0)
    || /Failed to fetch|NetworkError|Load failed|network|timeout|abort/i.test(res.error?.message || '');
  // 앞선 시도가 실제로는 서버에 반영된 경우 (응답만 못 받음)
  const alreadyDone = (fn, error) => (fn === 'clock_in'
    ? /이미 출근 등록/.test(error?.message || '')
    : /퇴근할 출근 기록이 없습니다/.test(error?.message || ''));

  async function doClock(fn, label) {
    if (!gpsAllowed()) return setMsg('점포 반경 안에서만 출퇴근할 수 있습니다.', 'err');
    if (!confirm(`${label} 하시겠습니까?`)) return;
    $('clock-in-btn').disabled = true; $('clock-out-btn').disabled = true;
    setMsg('');
    const args = branchLoc() && geo.status === 'ok' ? { p_lat: geo.lat, p_lng: geo.lng } : {};
    const MAX = 4;
    let data = null;
    let error = null;
    let done = false;
    showBusy(`${label} 처리 중`, '처리가 지연되고 있습니다.\n화면을 닫거나 다시 누르지 말고\n기다려 주세요.');
    try {
      for (let attempt = 1; attempt <= MAX; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        let res;
        try { res = await sb.rpc(fn, args).abortSignal(ctrl.signal); }
        catch (e) { res = { error: e, status: 0 }; }
        finally { clearTimeout(timer); }
        if (!res.error) { data = res.data; done = true; break; }
        if (attempt > 1 && alreadyDone(fn, res.error)) { done = true; break; }
        if (attempt === MAX || !retryable(res)) { error = res.error; break; }
        $('busy-text').dataset.retry = '1';
        $('busy-text').textContent = `접속이 원활하지 않아\n자동으로 다시 시도합니다. (${attempt}/${MAX - 1})\n화면을 닫지 말고 기다려 주세요.`;
        await sleep(1000 * attempt + Math.random() * 2000); // 동시에 몰리지 않도록 조금씩 흩어서 재시도
      }
    } finally {
      hideBusy();
    }
    await refreshToday();
    if (done) {
      const t = data ? (fn === 'clock_in' ? data.clock_in : data.clock_out)
        : (fn === 'clock_in' ? todayRow?.clock_in : todayRow?.clock_out);
      setMsg(`${label} 완료${t ? ` (${hm(t)})` : ''}`, 'ok');
    } else if (/로그아웃된 기기/.test(error?.message || '')) {
      return kickedOut();
    } else {
      setMsg(retryable({ error }) ? `${label}이 처리되지 않았습니다.\n인터넷 연결을 확인한 뒤 다시 눌러 주세요.` : errMsg(error), 'err');
    }
    loadMyRecords();
    loadMyOvertime();
  }
  $('clock-in-btn').addEventListener('click', () => doClock('clock_in', '출근'));
  $('clock-out-btn').addEventListener('click', () => doClock('clock_out', '퇴근'));

  // 화면이 다시 보일 때 상태·위치 갱신, 숨겨지면 GPS 중지(배터리 절약)
  document.addEventListener('visibilitychange', () => {
    if (!me) return;
    if (document.visibilityState === 'visible') { refreshToday(); startGps(); }
    else stopGps();
  });

  // ---------------------------------------------------------------
  //  직원: 내 기록
  // ---------------------------------------------------------------
  $('my-month').value = ymd(new Date()).slice(0, 7);
  $('my-month').addEventListener('change', loadMyRecords);

  async function loadMyRecords() {
    if (!me || !$('my-month').value) return;
    const [from, to] = monthRange($('my-month').value);
    const [att, ot] = await Promise.all([
      sb.from('attendance')
        .select('*, branch:branches!attendance_branch_id_fkey(name, work_start, work_end)').eq('user_id', me.id)
        .gte('work_date', from).lte('work_date', to)
        .order('work_date', { ascending: false }),
      sb.from('overtime_requests').select('*').eq('user_id', me.id).eq('status', 'approved')
        .gte('work_date', shiftDate(from, -1)).lte('work_date', to),
    ]);
    const tbody = $('my-records');
    const error = att.error || ot.error;
    if (error) { tbody.innerHTML = `<tr><td colspan="6" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    const data = att.data;
    const reqs = ot.data;
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">기록이 없습니다.</td></tr>'; $('my-summary').textContent = ''; return; }
    let regSum = 0;
    let otSum = 0;
    tbody.innerHTML = data.map((r) => {
      const reg = regularMs(r);
      const otMs = approvedOtMsForRow(r, reqs);
      const extra = unapprovedMsForRow(r, reqs);
      regSum += reg;
      otSum += otMs;
      return `
      <tr>
        <td>${dateLabel(r.work_date)}</td>
        <td>${hm(r.clock_in)}</td>
        <td>${r.clock_out ? hm(r.clock_out) : '<span class="tag-open">미퇴근</span>'}</td>
        <td>${fmtDur(reg)}</td>
        <td>${fmtDur(otMs)}${extra >= UNAPPROVED_SHOW_MS ? `<span class="tag-warn">미승인 ${fmtDur(extra)}</span>` : ''}</td>
        <td class="note">${esc(r.note)}${r.updated_at ? ' <span class="edited">(수정됨)</span>' : ''}</td>
      </tr>`;
    }).join('');
    $('my-summary').textContent = `근무일 ${data.length}일 · 정규 ${fmtDur(regSum)} · 초과근무 ${fmtDur(otSum)} · 총 근무시간 ${fmtDur(regSum + otSum)}`;
  }

  // ---------------------------------------------------------------
  //  직원: 초과근무 신청
  // ---------------------------------------------------------------
  $('ot-month').value = ymd(new Date()).slice(0, 7);
  $('ot-month').addEventListener('change', loadMyOvertime);

  // 정규 근무시간 안내 + 신청 기본값(정규 퇴근 ~ +2시간)
  function setupOvertimeForm() {
    const today = ymd(new Date());
    const b = myBranchOn(today);
    const hrs = hoursFor(b?.id ?? null, today, b);
    const ws = tmLabel(hrs.start);
    const we = tmLabel(hrs.end);
    // 출퇴근 화면 안내: 평소 정규 근무시간은 표시하지 않고, 지원 근무·특정일 근무시간처럼 '평소와 다른 날'만 알림
    const sup = b?.support ? `오늘은 ${b.name} 지원 근무입니다${b.support.note ? ` (${b.support.note})` : ''}.` : '';
    const spc = hrs.special ? `오늘은 특정일 근무시간 ${ws} ~ ${we}입니다${hrs.note ? ` (${hrs.note})` : ''}.` : '';
    const note = [sup, spc].filter(Boolean).join('\n');
    // 출퇴근 화면 맨 위: 이름 + 오늘 근무 점포 (지원 근무면 '지원' 표시)
    $('me-name').textContent = me?.name ? `${me.name}님` : '';
    $('me-branch').textContent = b?.name ? (b.support ? `${b.name} (지원)` : b.name) : '';
    $('me-branch').hidden = !b?.name;
    $('work-hours').hidden = !note;
    $('work-hours').textContent = note;
    $('work-hours').classList.toggle('support-note', !!note);
    $('ot-date').value = today;
    $('ot-start').value = we || '18:00';
    const [h, m] = ($('ot-start').value).split(':').map(Number);
    $('ot-end').value = `${String((h + 2) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    // 초과근무 신청 안내 문구는 표시하지 않음 (정규시간과 겹치면 신청할 때 안내)
    $('ot-help').textContent = '';
    $('ot-help').hidden = true;
  }

  function showOtMsg(text, kind) {
    const el = $('ot-msg');
    el.textContent = text; el.className = `msg ${kind || ''}`; el.hidden = !text;
  }

  $('ot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('ot-date').value;
    const start = new Date(`${date}T${$('ot-start').value}:00+09:00`);
    let end = new Date(`${date}T${$('ot-end').value}:00+09:00`);
    if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000); // 자정 넘김
    const db = myBranchOn(date); // 그날 근무 점포 (지원 근무 반영)
    const hrs = hoursFor(db?.id ?? null, date, db);
    const we = hrs.end;
    const ws = hrs.start;
    if (we && ws && start < kstAt(date, we) && end > kstAt(date, ws)) {
      return showOtMsg(`${hrs.special ? '이 날은 특정일 근무시간' : '정규 근무시간'}(${tmLabel(ws)} ~ ${tmLabel(we)})과 겹칩니다. 정규 근무시간 밖에서만 신청할 수 있습니다.`, 'err');
    }
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.rpc('request_overtime', {
      p_start: start.toISOString(), p_end: end.toISOString(), p_reason: $('ot-reason').value.trim(),
    });
    btn.disabled = false;
    if (error) return showOtMsg(errMsg(error), 'err');
    showOtMsg(`초과근무를 신청했습니다 (${date} ${hm(start)}~${hm(end)}, ${fmtDur(end - start)}). 매니저·슈퍼바이저의 승인을 기다려 주세요.`, 'ok');
    $('ot-reason').value = '';
    $('ot-month').value = date.slice(0, 7);
    loadMyOvertime();
  });

  let myOtRows = [];
  async function loadMyOvertime() {
    if (!me || !$('ot-month').value) return;
    const [from, to] = monthRange($('ot-month').value);
    const [ot, att] = await Promise.all([
      sb.from('overtime_requests').select('*').eq('user_id', me.id)
        .gte('work_date', from).lte('work_date', to)
        .order('work_date', { ascending: false }).order('start_at', { ascending: false }),
      sb.from('attendance').select('user_id, clock_in, clock_out, work_date').eq('user_id', me.id)
        .gte('work_date', from).lte('work_date', shiftDate(to, 1)),
    ]);
    const tbody = $('my-ot');
    const error = ot.error || att.error;
    if (error) { tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    myOtRows = ot.data;
    if (!myOtRows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">신청 내역이 없습니다.</td></tr>'; return; }
    tbody.innerHTML = myOtRows.map((q) => {
      const rec = recognizedOtMs(q, att.data);
      return `
      <tr>
        <td>${dateLabel(q.work_date)}</td>
        <td>${otTimeLabel(q)} <span class="dist">${fmtDur(new Date(q.end_at) - new Date(q.start_at))}</span></td>
        <td>${q.is_after ? '사후' : '사전'}</td>
        <td class="note">${esc(q.reason)}</td>
        <td>${otStatusTag(q.status)}</td>
        <td>${q.status === 'approved' ? fmtDur(rec) : '-'}</td>
        <td class="note">${esc(q.review_note || '')}</td>
        <td>${q.status === 'pending' ? `<button class="btn small" data-ot-cancel="${q.id}">취소</button>` : ''}</td>
      </tr>`;
    }).join('');
  }

  $('my-ot').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-ot-cancel]')?.dataset.otCancel;
    if (!id || !confirm('이 초과근무 신청을 취소하시겠습니까?')) return;
    const { error } = await sb.rpc('cancel_overtime', { p_id: Number(id) });
    if (error) return alert(errMsg(error));
    loadMyOvertime();
  });

  // ※ 직원 본인의 비밀번호 변경 기능은 없음 (매니저가 직원 관리 → [비밀번호 초기화]로만 변경)

  // ---------------------------------------------------------------
  //  관리자
  // ---------------------------------------------------------------
  let adminReady = false;
  let adminLoaded = false; // 관리자 화면 데이터를 한 번이라도 불러왔는지 (로그인할 때마다 초기화)
  let otLoaded = false;    // 초과근무 승인 목록을 한 번이라도 불러왔는지

  const branchName = (id) => branches.find((b) => b.id === id)?.name || '미지정';

  // 점포 select 옵션. includeAll: '전체'/'미지정' 포함(필터용), onlyActive: 사용 중 점포만(+ 현재값)
  function branchOptions({ includeAll = false, current = null, onlyActive = false } = {}) {
    let html = includeAll ? '<option value="">전체 점포</option><option value="none">점포 미지정</option>' : '<option value="">(미지정)</option>';
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
    await loadJobGroups();
    ['p-branch', 'd-branch', 'o-branch', 's-branch', 'r-branch'].forEach((id) => {
      const cur = $(id).value;
      $(id).innerHTML = branchOptions({ includeAll: true });
      $(id).value = cur;
    });
    // 점포 관리자는 담당 점포로 고정
    if (isManager()) {
      ['p-branch', 'd-branch', 'o-branch'].forEach((id) => {
        $(id).value = String(me.branch_id);
        $(id).disabled = true;
      });
    }
  }

  // ---- 직원 분류(근무조/직무): 모든 점포 공통 목록 ----
  let jobGroups = [];
  async function loadJobGroups() {
    if (!FEATURE_JOB_GROUPS) { jobGroups = []; return; }
    const { data, error } = await sb.from('job_groups').select('*').order('sort').order('name');
    if (error) return;
    jobGroups = data;
    ['p-job', 'd-job', 'o-job', 's-job'].forEach((id) => {
      const el = $(id); if (!el) return;
      const cur = el.value;
      el.innerHTML = `<option value="">전체</option><option value="none">미지정</option>${jobGroups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}`;
      el.value = [...el.options].some((o) => o.value === cur) ? cur : '';
    });
    const na = $('na-job');
    if (na) { const cur = na.value; na.innerHTML = jobOptions(null); na.value = cur; }
  }
  const jobName = (id) => jobGroups.find((g) => g.id === id)?.name || '';
  const jobOptions = (cur) => `<option value="">(미지정)</option>${jobGroups.map((g) => `<option value="${g.id}" ${g.id === cur ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}`;
  // 분류 필터: '' 전체, 'none' 미지정, 그 외 id
  const matchJob = (jobId, f) => (!f ? true : f === 'none' ? jobId == null : String(jobId) === f);
  // 출퇴근 기록의 분류 (그때 저장된 값, 없으면 직원의 현재 분류)
  const recJob = (r) => (r.job_group_id !== undefined && r.job_group_id !== null ? r.job_group_id : staff.find((s) => s.id === r.user_id)?.job_group_id ?? null);

  function renderJobGroups() {
    if (!FEATURE_JOB_GROUPS) return;
    $('job-list').innerHTML = jobGroups.map((g) => {
      const n = staff.filter((s) => s.job_group_id === g.id && !s.deleted_at).length;
      return `<span class="job-chip" data-id="${g.id}">${esc(g.name)} <span class="muted small">${n}명</span>
        <button type="button" class="sh-x" data-job-rename title="이름 바꾸기" aria-label="이름 바꾸기">✎</button>
        <button type="button" class="sh-x" data-job-del title="삭제" aria-label="삭제">✕</button></span>`;
    }).join('') || '<span class="muted small">아직 분류가 없습니다. 오른쪽에 이름을 입력해 추가하세요.</span>';
  }
  $('job-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('job-name').value.trim();
    if (!name) return;
    const { error } = await sb.from('job_groups').insert({ name, sort: jobGroups.length + 1 });
    if (error) return alert(/duplicate|unique/i.test(error.message) ? '같은 이름의 분류가 이미 있습니다.' : errMsg(error));
    $('job-name').value = '';
    await loadJobGroups();
    renderJobGroups(); renderStaff();
  });
  $('job-list').addEventListener('click', async (e) => {
    const chip = e.target.closest('.job-chip');
    if (!chip) return;
    const g = jobGroups.find((x) => x.id === Number(chip.dataset.id));
    if (!g) return;
    if (e.target.matches('[data-job-rename]')) {
      const name = prompt('분류 이름을 바꿉니다.', g.name);
      if (name === null || !name.trim() || name.trim() === g.name) return;
      const { error } = await sb.from('job_groups').update({ name: name.trim() }).eq('id', g.id);
      if (error) return alert(/duplicate|unique/i.test(error.message) ? '같은 이름의 분류가 이미 있습니다.' : errMsg(error));
    } else if (e.target.matches('[data-job-del]')) {
      const n = staff.filter((s) => s.job_group_id === g.id && !s.deleted_at).length;
      if (!confirm(`'${g.name}' 분류를 삭제할까요?${n ? `\n이 분류의 직원 ${n}명은 '미지정'이 됩니다.` : ''}\n과거 출퇴근 기록의 분류 표시도 비워집니다.`)) return;
      const { error } = await sb.from('job_groups').delete().eq('id', g.id);
      if (error) return alert(errMsg(error));
      await loadStaff();
    } else return;
    await loadJobGroups();
    renderJobGroups(); renderStaff();
  });

  // ---- 지원 근무 등록·목록 (매니저, 직원 관리) ----
  // 직원 목록·기록 옆에 붙는 '지원' 표시 (오늘 이후 예정·진행 중만)
  function supportTags(uid) {
    const today = ymd(new Date());
    return supports.filter((s) => s.user_id === uid && s.end_date >= today)
      .map((s) => `<span class="tag-support" title="${esc(s.note || '')}">${supportLabel(s)} ${esc(s.to_branch?.name || '')} 지원</span>`).join('');
  }
  function spMsg(text, kind) { const el = $('sp-msg'); el.textContent = text; el.className = `msg ${kind || ''}`; el.hidden = !text; }
  function renderSupports() {
    const today = ymd(new Date());
    const curU = $('sp-user').value;
    const active = staff.filter((s) => !s.deleted_at && isActive(s.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    $('sp-user').innerHTML = '<option value="">직원 선택</option>' + active.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(branchName(s.branch_id))})</option>`).join('');
    $('sp-user').value = curU;
    const curB = $('sp-branch').value;
    $('sp-branch').innerHTML = '<option value="">점포 선택</option>' + branches.filter((b) => b.is_active).map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    $('sp-branch').value = curB;
    if (!$('sp-start').value) { $('sp-start').value = today; $('sp-end').value = today; }
    const since = shiftDate(today, -7);
    const rows = supports.filter((s) => s.end_date >= since);
    $('sp-list').innerHTML = rows.map((s) => {
      const st = s.end_date < today ? '<span class="st st-cancelled">종료</span>' : s.start_date <= today ? '<span class="st st-approved">진행 중</span>' : '<span class="st st-pending">예정</span>';
      return `<tr data-id="${s.id}" class="${s.end_date < today ? 'zero' : ''}">
        <td>${supportLabel(s)}</td>
        <td>${esc(s.person?.name || '')}</td>
        <td>${esc(s.from_branch?.name || '미지정')} → <b>${esc(s.to_branch?.name || '')}</b></td>
        <td class="note">${esc(s.note || '')}</td>
        <td>${st}</td>
        <td class="actions"><button class="btn small danger-outline" data-sp-del>${s.start_date > today ? '취소' : '삭제'}</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">등록된 지원 근무가 없습니다.</td></tr>';
  }
  $('sp-start').addEventListener('change', () => { if ($('sp-end').value < $('sp-start').value) $('sp-end').value = $('sp-start').value; });
  $('sp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { user_id: $('sp-user').value, to_branch_id: Number($('sp-branch').value), start_date: $('sp-start').value, end_date: $('sp-end').value, note: $('sp-note').value.trim() || null };
    if (!row.user_id || !row.to_branch_id) return spMsg('직원과 지원 점포를 선택하세요.', 'err');
    if (row.end_date < row.start_date) return spMsg('종료일이 시작일보다 빠릅니다.', 'err');
    const p = staff.find((s) => s.id === row.user_id);
    if (p && p.branch_id === row.to_branch_id) return spMsg('원래 소속 점포와 같은 점포입니다. 다른 점포를 고르세요.', 'err');
    if (supports.some((s) => s.user_id === row.user_id && s.start_date <= row.end_date && s.end_date >= row.start_date)) return spMsg('이 직원은 같은 기간에 이미 지원 근무가 등록되어 있습니다.', 'err');
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.from('support_assignments').insert(row);
    btn.disabled = false;
    if (error) return spMsg(errMsg(error), 'err');
    spMsg(`${p?.name || ''}님을 ${branchName(row.to_branch_id)}에 ${row.start_date === row.end_date ? dateLabel(row.start_date) : `${dateLabel(row.start_date)}~${dateLabel(row.end_date)}`} 지원 근무로 등록했습니다.`, 'ok');
    $('sp-note').value = '';
    await loadSupports();
    renderSupports(); renderStaff();
  });
  $('sp-list').addEventListener('click', async (e) => {
    if (!e.target.matches('[data-sp-del]')) return;
    const s = supports.find((x) => x.id === Number(e.target.closest('tr').dataset.id));
    if (!s) return;
    const today = ymd(new Date());
    const msg = s.start_date > today
      ? `${s.person?.name}님의 ${s.to_branch?.name} 지원 근무(${supportLabel(s)})를 취소할까요?`
      : `${s.person?.name}님의 ${s.to_branch?.name} 지원 근무(${supportLabel(s)}) 등록을 삭제할까요?\n이미 남은 출퇴근 기록은 그대로 ${s.to_branch?.name} 기록으로 유지됩니다.`;
    if (!confirm(msg)) return;
    const { error } = await sb.from('support_assignments').delete().eq('id', s.id);
    if (error) return alert(errMsg(error));
    spMsg('');
    await loadSupports();
    renderSupports(); renderStaff();
  });

  async function loadStaff() {
    const { data, error } = await fetchAll(() => sb.from('profiles').select('*').order('name').order('id'));
    if (error) { alert(errMsg(error)); return; }
    staff = data;
    fillUserSelects();
    if (me?.is_admin) updateRetiredBadge();
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
    if (!me?.is_admin) { authStatus = new Map(); return; } // 계정 상태 조회는 본사 관리자만
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

  // ---- 필터 (p: 개인별 근무현황, d: 일자별 근무현황 — 각각 따로 동작) ----
  const loaders = { p: () => loadPersonal(), d: () => loadDaily(), o: () => loadOvertimeAdmin() };

  // 점포 필터에 맞춰 직원 select 갱신
  function fillUserSelect(prefix) {
    const fb = $(`${prefix}-branch`).value;
    const sel = $(`${prefix}-user`);
    const cur = sel.value;
    const list = staff.filter((s) => matchBranch(s.branch_id, fb));
    sel.innerHTML = '<option value="">전체</option>' +
      list.map((s) => `<option value="${s.id}">${esc(s.name)}${s.deleted_at ? ' (퇴사)' : ''}</option>`).join('');
    sel.value = list.some((s) => s.id === cur) ? cur : '';
  }
  function fillUserSelects() {
    fillUserSelect('p');
    fillUserSelect('d');
    fillUserSelect('o');
    $('edit-user').innerHTML = staff.filter((s) => !s.deleted_at && !(isManager() && s.id === me.id)).map((s) =>
      `<option value="${s.id}">${esc(s.name)} (${esc(branchName(s.branch_id))})</option>`).join('');
  }

  // 월 선택 → 그 달 1일 ~ 말일로 기간 설정
  function setMonth(prefix, ym) {
    const [from, to] = monthRange(ym);
    $(`${prefix}-month`).value = ym;
    $(`${prefix}-from`).value = from;
    $(`${prefix}-to`).value = to;
  }

  // 이름 검색 (개인별 p · 일자별 d · 초과근무 o): 이름 일부만 입력해도 됨, 엑셀 다운로드에도 반영
  const nameQ = (prefix) => ($(`${prefix}-search`)?.value || '').trim().toLowerCase();
  const nameHit = (prefix, name) => { const q = nameQ(prefix); return !q || String(name || '').toLowerCase().includes(q); };
  const searchTimers = {};
  // 분류 필터 (개인별은 이미 불러온 기록에서 다시 계산, 일자별·초과근무는 다시 조회)
  ['p', 'd', 'o'].forEach((prefix) => {
    $(`${prefix}-job`).addEventListener('change', () => {
      if (prefix === 'p') renderStaffSummary();
      else if (prefix === 'd') loadDaily(true);
      else loadOvertimeAdmin(true);
    });
  });
  const jobHit = (prefix, jobId) => matchJob(jobId ?? null, $(`${prefix}-job`)?.value || '');

  ['p', 'd', 'o'].forEach((prefix) => {
    $(`${prefix}-search`).addEventListener('input', () => {
      clearTimeout(searchTimers[prefix]);
      searchTimers[prefix] = setTimeout(() => {
        if (prefix === 'p') renderStaffSummary();
        else if (prefix === 'd') loadDaily(true);
        else loadOvertimeAdmin(true);
      }, 300);
    });
  });

  $('o-status').addEventListener('change', () => loadOvertimeAdmin());
  ['p', 'd', 'o'].forEach((prefix) => {
    $(`${prefix}-branch`).addEventListener('change', () => { fillUserSelect(prefix); loaders[prefix](); });
    $(`${prefix}-user`).addEventListener('change', loaders[prefix]);
    $(`${prefix}-month`).addEventListener('change', () => {
      if (!$(`${prefix}-month`).value) return;
      setMonth(prefix, $(`${prefix}-month`).value);
      loaders[prefix]();
    });
    // 날짜를 직접 바꾸면 월 선택은 비움 (한 달 범위가 아닐 수 있으므로)
    [`${prefix}-from`, `${prefix}-to`].forEach((id) => $(id).addEventListener('change', () => { $(`${prefix}-month`).value = ''; }));
    $(`${prefix}-form`).addEventListener('submit', (e) => { e.preventDefault(); loaders[prefix](); });
  });

  // quiet: 표를 "불러오는 중"으로 비우지 않고 결과가 오면 바로 바꿈 (탭 전환용)
  function reloadRecords(quiet = false) {
    loadPersonal(quiet);
    loadDaily(quiet);
    loadTodaySummary();
    loadOtBadge();
  }

  async function initAdmin() {
    if (!me?.is_admin && !isManager()) return;
    if (!adminReady) {
      const ym = ymd(new Date()).slice(0, 7);
      setMonth('p', ym);
      setMonth('d', ym);
      setMonth('o', ym);
      $('o-status').value = 'pending';
      adminReady = true;
    }
    if (!adminLoaded) {
      // 처음 한 번: 점포·직원을 동시에 받아온 뒤 기록 조회 (느린 계정 상태는 기다리지 않음)
      await Promise.all([loadBranches(), loadStaff()]);
      fillUserSelects(); // 점포 이름이 들어간 선택 목록을 다시 채움
      adminLoaded = true;
      reloadRecords();
      loadAuthStatus().then(() => {
        // 비활성 직원이 있으면 오늘 현황·개인별 현황에서 빼도록 다시 그림
        if ([...authStatus.values()].some((u) => u.banned)) { loadTodaySummary(); renderStaffSummary(); }
      });
      return;
    }
    // 이후 탭 전환: 지금 화면은 그대로 두고, 뒤에서 조용히 최신 내용으로 바꿈
    Promise.all([loadBranches(), loadStaff()]).then(() => reloadRecords(true));
  }

  // 오늘 점포별 현황
  async function loadTodaySummary() {
    const today = ymd(new Date());
    // 실제 기록만 보여 줌 (출근·근무 중·퇴근). '누가 와야 하는지'는 근무 일정이 없어서 판단하지 않음
    const { data, error } = await fetchAll(() => sb.from('attendance')
      .select('id, user_id, branch_id, clock_in, clock_out, profile:profiles!attendance_user_id_fkey(name)').eq('work_date', today).order('clock_in'));
    const tbody = $('today-summary');
    loadMissingOut(); // 퇴근 미기록 알림 (따로 조회)
    if (error) { tbody.innerHTML = `<tr><td colspan="4" class="empty">${esc(errMsg(error))}</td></tr>`; $('present-box').hidden = true; return; }
    let groups = [...branches.map((b) => ({ id: b.id, name: b.name, active: b.is_active })), { id: null, name: '점포 미지정', active: false }];
    if (isManager()) groups = groups.filter((g) => g.id === me.branch_id); // 슈퍼바이저는 담당 점포만
    const total = { in: 0, working: 0, out: 0 };
    const present = []; // [{ name, recs }]
    const rows = groups.map((g) => {
      const recs = data.filter((r) => (r.branch_id ?? null) === g.id); // 기록된(근무한) 점포 기준
      const c = { in: recs.length, working: recs.filter((r) => !r.clock_out).length, out: recs.filter((r) => r.clock_out).length };
      if (!c.in && !g.active) return ''; // 안 쓰는 점포·점포 미지정은 기록이 있을 때만
      Object.keys(total).forEach((k) => { total[k] += c[k]; });
      if (recs.length) present.push({ name: g.name, recs });
      return `<tr class="${c.in ? '' : 'zero'}"><td>${esc(g.name)}</td><td class="num">${c.in}</td><td class="num">${c.working}</td><td class="num">${c.out}</td></tr>`;
    }).join('');
    tbody.innerHTML = rows
      ? rows + `<tr class="total"><td>합계</td><td class="num">${total.in}</td><td class="num">${total.working}</td><td class="num">${total.out}</td></tr>`
      : '<tr><td colspan="4" class="empty">등록된 점포가 없습니다.</td></tr>';
    // 출근자 명단 접기란: 펼침 상태는 새로고침해도 유지 (details 요소는 그대로 두고 내용만 바꿈)
    $('present-box').hidden = !total.in; // 출근 기록이 없으면 명단 접기란도 숨김
    $('present-head').innerHTML = `출근자 명단 <b>${total.in}명</b> <span class="muted">· 근무 중 ${total.working} · 퇴근 ${total.out}</span>`;
    $('present-list').innerHTML = present.map((g) => `<div class="fold-group">
        <div class="fold-branch">${esc(g.name)} <span class="muted">${g.recs.length}명</span></div>
        <div class="fold-names">${g.recs.map((r) => {
          const sup = supportOn(r.user_id, today) ? '(지원)' : '';
          return `<span class="name-chip${r.clock_out ? ' done' : ''}" title="${r.clock_out ? `출근 ${hm(r.clock_in)} · 퇴근 ${hm(r.clock_out)}` : `출근 ${hm(r.clock_in)} · 근무 중`}">${esc(r.profile?.name || '')}${sup} <span class="chip-time">${hm(r.clock_in)}${r.clock_out ? `~${hm(r.clock_out)}` : ''}</span></span>`;
        }).join('')}</div>
      </div>`).join('');
  }
  $('today-refresh').addEventListener('click', loadTodaySummary);

  // 퇴근 미기록: 최근 7일(오늘 제외) 출근만 있고 퇴근이 없는 기록 → 근무시간이 0으로 계산되므로 알림
  let missOutRows = [];
  async function loadMissingOut() {
    const today = ymd(new Date());
    const from = ymd(new Date(Date.now() - 7 * 864e5));
    const { data, error } = await sb.from('attendance')
      .select('id, user_id, branch_id, work_date, clock_in, clock_out, note, profile:profiles!attendance_user_id_fkey(name)')
      .is('clock_out', null).gte('work_date', from).lt('work_date', today).order('work_date', { ascending: false }).limit(500);
    missOutRows = error ? [] : (isManager() ? data.filter((r) => r.branch_id === me.branch_id) : data);
    $('missout-box').hidden = !missOutRows.length;
    $('missout-head').innerHTML = `⚠ 퇴근 미기록 <b>${missOutRows.length}건</b> <span class="muted">· 최근 7일, 오늘 제외</span>`;
    $('missout-list').innerHTML = missOutRows.map((r) => `<tr>
        <td>${esc(dateLabel(r.work_date))}</td><td>${esc(branchName(r.branch_id))}</td><td>${esc(r.profile?.name || '')}</td><td>${hm(r.clock_in)}</td>
        <td class="actions">${isManager() && r.user_id === me.id ? '<span class="muted small">매니저 처리</span>' : `<button type="button" class="btn small" data-missout="${r.id}">퇴근 입력</button>`}</td>
      </tr>`).join('');
    labelTable($('missout-list').closest('table'));
  }
  $('missout-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-missout]')?.dataset.missout;
    if (id) openEdit(missOutRows.find((r) => String(r.id) === id)); // 기존 기록 수정 창 재사용 (저장하면 현황이 다시 그려짐)
  });

  // 필터 조건으로 출퇴근 기록 조회 (1,000건 넘어도 전부)
  function fetchRecords(prefix) {
    const fb = $(`${prefix}-branch`).value;
    const fu = $(`${prefix}-user`).value;
    const from = $(`${prefix}-from`).value;
    const to = $(`${prefix}-to`).value;
    return fetchAll(() => {
      let q = sb.from('attendance')
        .select('*, branch:branches!attendance_branch_id_fkey(name, work_start, work_end), profile:profiles!attendance_user_id_fkey(name), editor:profiles!attendance_updated_by_fkey(name)')
        .gte('work_date', from).lte('work_date', to)
        .order('work_date', { ascending: false }).order('clock_in', { ascending: true }).order('id');
      if (fb === 'none') q = q.is('branch_id', null);
      else if (fb) q = q.eq('branch_id', fb);
      if (fu) q = q.eq('user_id', fu);
      return q;
    });
  }

  // 기간 안의 승인된 초과근무 (자정 넘김 대비 하루 앞까지)
  function fetchApprovedOt(prefix) {
    const fu = $(`${prefix}-user`).value;
    const from = $(`${prefix}-from`).value;
    const to = $(`${prefix}-to`).value;
    return fetchAll(() => {
      let q = sb.from('overtime_requests').select('*').eq('status', 'approved')
        .gte('work_date', shiftDate(from, -1)).lte('work_date', to).order('id');
      if (fu) q = q.eq('user_id', fu);
      return q;
    });
  }

  // ---- 개인별 근무현황 조회 ----
  let personalRows = [];
  let personalOt = [];
  let personalSeq = 0;
  // 긴 목록은 처음 20개만 보여 주고 [더 보기]/[전체 보기]로 늘림 (새로 조회하면 다시 20개)
  const PAGE = 20;
  const moreRow = (key, shown, total, cols, unit) => (shown >= total ? '' : `<tr class="more-row"><td colspan="${cols}">
      <span class="muted small">전체 ${total.toLocaleString()}${unit} 중 ${shown.toLocaleString()}${unit} 표시</span>
      <button type="button" class="btn small" data-more="${key}">${Math.min(PAGE, total - shown)}${unit} 더 보기</button>
      <button type="button" class="btn small ghost" data-more-all="${key}">전체 보기</button></td></tr>`);
  // 휴대폰용 요약 카드 칸 (PC에서는 숨김). 누르면 나머지 칸이 펼쳐짐. right: 오른쪽에 둘 상태·버튼
  const mSum = (top, line, right = '') => `<td class="m-sum"><div class="ms-top">${top}<span class="ms-right">${right}<span class="ms-caret">▾</span></span></div><div class="ms-line">${line}</div></td>`;
  // 요약 카드 누르면 펼치기/접기 (버튼을 누른 경우는 제외)
  ['staff-summary', 'admin-records', 'ot-list'].forEach((id) => $(id).addEventListener('click', (e) => {
    const td = e.target.closest('td.m-sum');
    if (!td || e.target.closest('button')) return;
    td.parentElement.classList.toggle('open');
  }));
  let pLimit = PAGE;
  async function loadPersonal(quiet = false) {
    if (!$('p-from').value || !$('p-to').value) return;
    if (quiet !== true) pLimit = PAGE; // (change 이벤트로 불리면 quiet에 이벤트 객체가 들어옴 → 새 조회로 취급)
    const seq = ++personalSeq;
    if (!quiet) $('staff-summary').innerHTML = '<tr><td colspan="9" class="empty">불러오는 중...</td></tr>';
    const [att, ot] = await Promise.all([fetchRecords('p'), fetchApprovedOt('p')]);
    if (seq !== personalSeq) return; // 그 사이 조건이 바뀌어 새 조회가 시작됨 → 이전 결과는 버림
    const error = att.error || ot.error;
    if (error) { $('staff-summary').innerHTML = `<tr><td colspan="9" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    personalRows = att.data;
    personalOt = ot.data;
    renderStaffSummary();
  }

  // ---- 일자별 근무현황 조회 (일자별로 묶어서 표시) ----
  let dailyRows = [];
  let dailyOt = [];
  let dailySeq = 0;
  async function loadDaily(quiet = false) {
    if (!$('d-from').value || !$('d-to').value) return;
    const seq = ++dailySeq;
    const tbody = $('admin-records');
    if (!quiet) tbody.innerHTML = '<tr><td colspan="9" class="empty">불러오는 중...</td></tr>';
    const [att, ot] = await Promise.all([fetchRecords('d'), fetchApprovedOt('d')]);
    if (seq !== dailySeq) return;
    const error = att.error || ot.error;
    if (error) { tbody.innerHTML = `<tr><td colspan="9" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    const data = att.data.filter((r) => nameHit('d', r.profile?.name) && jobHit('d', recJob(r)));
    dailyRows = data;
    dailyOt = ot.data;
    if (quiet !== true) { dayOpen = new Set(data.length ? [data[0].work_date] : []); dayLimit.clear(); } // 새로 조회: 가장 최근 날짜만 펼침
    renderDaily();
  }

  // 날짜별 접기 상태: 펼친 날짜, 날짜별로 보여 줄 인원 수
  let dayOpen = new Set();
  const dayLimit = new Map();
  let dayGroups = [];
  function renderDaily() {
    const tbody = $('admin-records');
    const data = dailyRows;
    $('d-tools').hidden = !data.length;
    if (!data.length) { tbody.innerHTML = `<tr><td colspan="9" class="empty">${nameQ('d') ? `"${esc(nameQ('d'))}" 이름의 기록이 없습니다.` : '기록이 없습니다.'}</td></tr>`; $('admin-summary').textContent = ''; return; }
    const workMs = (r) => regularMs(r) + approvedOtMsForRow(r, dailyOt);

    // 날짜별 그룹 (data는 날짜 내림차순, 같은 날은 출근 빠른 순)
    const groups = [];
    data.forEach((r) => {
      const last = groups[groups.length - 1];
      if (last && last.date === r.work_date) last.rows.push(r);
      else groups.push({ date: r.work_date, rows: [r] });
    });
    dayGroups = groups;
    tbody.innerHTML = groups.map((g) => {
      const open = g.rows.filter((r) => !r.clock_out).length;
      const total = g.rows.reduce((s, r) => s + workMs(r), 0);
      const isOpen = dayOpen.has(g.date);
      const head = `
      <tr class="day-head${isOpen ? ' open' : ''}" data-day="${g.date}"><td colspan="9"><span class="day-caret">▸</span>${dateLabel(g.date)}
        <span class="day-meta">출근 ${g.rows.length}명${open ? ` · 미퇴근 ${open}건` : ''} · 근무시간 합계 ${fmtDur(total)}</span></td></tr>`;
      if (!isOpen) return head;
      const lim = dayLimit.get(g.date) || PAGE;
      return head + g.rows.slice(0, lim).map((r) => {
        const extra = unapprovedMsForRow(r, dailyOt);
        const canEdit = !(isManager() && r.user_id === me.id);
        return `
      <tr class="rec">
        <td>${esc(r.branch?.name || '미지정')}</td>
        <td>${esc(r.profile?.name)}${r.home_branch_id && r.home_branch_id !== r.branch_id ? `<span class="tag-support">지원 · ${esc(branchName(r.home_branch_id))} 소속</span>` : ''}</td>
        <td>${hm(r.clock_in)}${r.in_dist_m != null ? `<span class="dist">${r.in_dist_m}m</span>` : ''}</td>
        <td>${r.clock_out ? hm(r.clock_out) + (r.out_dist_m != null ? `<span class="dist">${r.out_dist_m}m</span>` : '') : '<span class="tag-open">미퇴근</span>'}</td>
        <td>${fmtDur(regularMs(r))}</td>
        <td>${fmtDur(approvedOtMsForRow(r, dailyOt))}${extra >= UNAPPROVED_SHOW_MS ? `<span class="tag-warn">미승인 ${fmtDur(extra)}</span>` : ''}</td>
        <td class="note">${esc(r.note)}</td>
        <td class="edited">${r.updated_at ? `${esc(r.editor?.name || '알 수 없음')} · ${ymd(r.updated_at).slice(5)} ${hm(r.updated_at)}` : ''}</td>
        <td>${isManager() && r.user_id === me.id ? '<span class="muted small">매니저 처리</span>' : `<button class="btn small" data-edit="${r.id}">수정</button>`}</td>
        ${mSum(`<b>${esc(r.profile?.name)}</b><span class="ms-sub">${esc(r.branch?.name || '미지정')}${r.home_branch_id && r.home_branch_id !== r.branch_id ? ' · 지원' : ''}</span>`,
          `${hm(r.clock_in)} ~ ${r.clock_out ? hm(r.clock_out) : '<span class="tag-open">미퇴근</span>'}${r.clock_out ? ` · <b>${fmtDur(workMs(r))}</b>` : ''}${extra >= UNAPPROVED_SHOW_MS ? ` <span class="tag-warn">미승인 ${fmtDur(extra)}</span>` : ''}`,
          canEdit ? `<button class="btn small" data-edit="${r.id}">수정</button>` : '')}
      </tr>`;
      }).join('') + moreRow(`d:${g.date}`, Math.min(lim, g.rows.length), g.rows.length, 9, '명');
    }).join('');
    const total = data.reduce((s, r) => s + workMs(r), 0);
    const open = data.filter((r) => !r.clock_out).length;
    $('admin-summary').textContent = `${groups.length}일 · ${data.length.toLocaleString()}건 · 총 근무시간 ${fmtDur(total)}(정규+승인 초과)${open ? ` · 미퇴근 ${open}건` : ''}`;
  }
  // 날짜 줄 누르면 펼침/접기, 날짜 안 [더 보기]
  $('admin-records').addEventListener('click', (e) => {
    const more = e.target.closest('[data-more], [data-more-all]');
    if (more) {
      const date = (more.dataset.more || more.dataset.moreAll).slice(2);
      dayLimit.set(date, more.dataset.moreAll ? Infinity : (dayLimit.get(date) || PAGE) + PAGE);
      return renderDaily();
    }
    const head = e.target.closest('tr.day-head');
    if (!head) return;
    const d = head.dataset.day;
    if (dayOpen.has(d)) dayOpen.delete(d); else dayOpen.add(d);
    renderDaily();
  });
  $('d-open-all').addEventListener('click', () => { dayOpen = new Set(dayGroups.map((g) => g.date)); renderDaily(); });
  $('d-close-all').addEventListener('click', () => { dayOpen = new Set(); renderDaily(); });

  // 개인별 근무 현황 (현재 조회 조건 기준)
  let summaryRows = [];
  function buildStaffSummary() {
    const fb = $('p-branch').value;
    const fu = $('p-user').value;
    const map = new Map();
    // 기록이 없는 직원도 0일로 표시
    const blank = () => ({ branches: new Set(), days: 0, reg: 0, ot: 0, total: 0, doneDays: 0, open: 0, edited: 0 });
    staff.filter((s) => matchBranch(s.branch_id, fb) && (!fu || s.id === fu) && isActive(s.id) && jobHit('p', s.job_group_id)).forEach((s) => {
      map.set(s.id, { name: s.name, homeBranch: s.branch_id, ...blank() });
    });
    personalRows.forEach((r) => {
      if (!jobHit('p', recJob(r))) return;
      let e = map.get(r.user_id);
      if (!e) {
        e = { name: r.profile?.name || '(알 수 없음)', homeBranch: null, ...blank() };
        map.set(r.user_id, e);
      }
      e.branches.add(r.branch?.name || '미지정');
      e.days += 1;
      if (r.clock_out) {
        const reg = regularMs(r);
        const ot = approvedOtMsForRow(r, personalOt);
        e.reg += reg; e.ot += ot; e.total += reg + ot; e.doneDays += 1;
      } else { e.open += 1; }
      if (r.updated_at) e.edited += 1;
    });
    return [...map.values()]
      .filter((e) => nameHit('p', e.name))
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
    if (!summaryRows.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">해당 직원이 없습니다.</td></tr>'; return; }
    const sum = summaryRows.reduce((s, e) => ({
      days: s.days + e.days, reg: s.reg + e.reg, ot: s.ot + e.ot, total: s.total + e.total, open: s.open + e.open, edited: s.edited + e.edited,
    }), { days: 0, reg: 0, ot: 0, total: 0, open: 0, edited: 0 });
    // 합계는 맨 위에 고정 (일부만 보여도 전체 합계가 바로 보이도록)
    tbody.innerHTML = `
      <tr class="total top rec">
        <td>합계</td><td>${summaryRows.length}명</td>
        <td class="num">${sum.days}일</td><td class="num">${fmtDur(sum.reg)}</td><td class="num">${fmtDur(sum.ot)}</td>
        <td class="num">${fmtDur(sum.total)}</td><td></td>
        <td class="num">${sum.open ? `${sum.open}건` : '-'}</td><td class="num">${sum.edited ? `${sum.edited}건` : '-'}</td>
        ${mSum(`<b>합계</b><span class="ms-sub">${summaryRows.length}명 · ${sum.days}일</span>`,
          `총 <b>${fmtDur(sum.total)}</b> <span class="muted">(정규 ${fmtDur(sum.reg)} + 초과 ${fmtDur(sum.ot)})</span>${sum.open ? ` · <span class="tag-open">미퇴근 ${sum.open}건</span>` : ''}`)}
      </tr>` + summaryRows.slice(0, pLimit).map((e) => `
      <tr class="rec ${e.days ? '' : 'zero'}">
        <td>${esc(e.branchLabel)}</td>
        <td>${esc(e.name)}</td>
        <td class="num">${e.days}일</td>
        <td class="num">${fmtDur(e.reg)}</td>
        <td class="num">${fmtDur(e.ot)}</td>
        <td class="num"><b>${fmtDur(e.total)}</b></td>
        <td class="num">${fmtDur(e.avg)}</td>
        <td class="num">${e.open ? `<span class="tag-open">${e.open}건</span>` : '-'}</td>
        <td class="num">${e.edited ? `${e.edited}건` : '-'}</td>
        ${mSum(`<b>${esc(e.name)}</b><span class="ms-sub">${esc(e.branchLabel)}</span>`,
          `${e.days}일 · 총 <b>${fmtDur(e.total)}</b>${e.open ? ` · <span class="tag-open">미퇴근 ${e.open}건</span>` : ''}`)}
      </tr>`).join('') + moreRow('p', Math.min(pLimit, summaryRows.length), summaryRows.length, 9, '명');
  }
  $('staff-summary').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { pLimit += PAGE; renderStaffSummary(); }
    else if (e.target.closest('[data-more-all]')) { pLimit = Infinity; renderStaffSummary(); }
  });

  // ---- 근태표 엑셀: 시트1 달력형(직원별 출근/퇴근/연장), 시트2 일별 상세 ----
  //  개인별(p)·일자별(d) 근무현황의 [엑셀 다운로드]에서 공용으로 사용
  //  화면에서 고른 기간·점포·직원 조건으로 그때 새로 불러와서 만듦 (선택 기간의 모든 날짜가 한 파일에)
  const hmDur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}시간 ${String(m % 60).padStart(2, '0')}분`; };
  const hours1 = (ms) => Math.round(ms / 360000) / 10; // 시간 단위, 소수 1자리
  const wdOf = (d) => weekdayFmt.format(new Date(`${d}T12:00:00+09:00`));
  // 휴게시간 (근로기준법 제54조 기준): 정규시간 안 근무가 8시간 이상 → 1시간, 4시간 이상 → 30분
  const breakMs = (regMs) => (regMs >= 8 * 3600000 ? 3600000 : regMs >= 4 * 3600000 ? 1800000 : 0);
  const workRegMs = (r) => { const reg = regularMs(r); return reg - breakMs(reg); }; // 소정근로 = 정규 근무 − 휴게

  async function exportAttendance(prefix, btn) {
    const from = $(`${prefix}-from`).value;
    const to = $(`${prefix}-to`).value;
    if (!from || !to || from > to) return alert('시작일과 종료일을 선택하세요.');
    const dates = [];
    for (let d = from; d <= to; d = shiftDate(d, 1)) { dates.push(d); if (dates.length > 62) return alert('엑셀은 한 번에 62일까지 만들 수 있습니다. 기간을 줄여 주세요.'); }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '만드는 중...';
    let att; let otRes;
    try {
      await loadXlsx();
      [att, otRes] = await Promise.all([fetchRecords(prefix), fetchApprovedOt(prefix), loadSpecialHours()]);
    } catch (e) { alert(e.message); return; }
    finally { btn.disabled = false; btn.textContent = label; }
    if (att.error || otRes.error) return alert(errMsg(att.error || otRes.error));
    const rows = att.data.filter((r) => jobHit(prefix, recJob(r)));
    const otReqs = otRes.data;
    const X = window.XLSX;
    const fb = $(`${prefix}-branch`).value;
    const fu = $(`${prefix}-user`).value;

    // 대상 직원: 조건에 맞는 재직자 + 기간 중 기록이 있는 사람 (점포 → 이름 순)
    const people = new Map();
    staff.filter((s) => matchBranch(s.branch_id, fb) && (!fu || s.id === fu) && isActive(s.id) && jobHit(prefix, s.job_group_id)).forEach((s) => people.set(s.id, s));
    rows.forEach((r) => {
      if (!people.has(r.user_id)) people.set(r.user_id, staff.find((s) => s.id === r.user_id) || { id: r.user_id, name: r.profile?.name || '(알 수 없음)', branch_id: r.branch_id });
    });
    const list = [...people.values()].filter((p) => nameHit(prefix, p.name)).sort((a, b) => branchName(a.branch_id).localeCompare(branchName(b.branch_id), 'ko') || a.name.localeCompare(b.name, 'ko'));
    if (!list.length) return alert('해당 직원이 없습니다. 조건을 확인하고 [조회]를 누르세요.');
    const rec = new Map(rows.map((r) => [`${r.user_id}|${r.work_date}`, r]));
    const otOf = (r) => (r && r.clock_out ? approvedOtMsForRow(r, otReqs) : 0);

    // ===== 시트1: 달력형 =====
    const JG = FEATURE_JOB_GROUPS; // 분류 칸 포함 여부
    const FIX = ['순번', '성명', '점포명', '입사일', ...(JG ? ['분류'] : []), '구분'];
    const blankFix = FIX.slice(0, -1).map(() => '');
    const SUM = ['근무일', '소정근로(시간)', '연장(시간)', '총(시간)'];
    const nF = FIX.length;
    const nD = dates.length;
    const nC = nF + nD + SUM.length;
    const branchTitle = fb === '' ? '전체 점포' : fb === 'none' ? '점포 미지정' : branchName(Number(fb));
    const aoa = [];
    aoa.push([`${from} ~ ${to} 근태 현황 (${branchTitle})`]);
    aoa.push([...FIX, ...dates.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`), ...SUM]);
    aoa.push([...FIX.map(() => ''), ...dates.map(wdOf), ...SUM.map(() => '')]);
    list.forEach((p, i) => {
      const rows = dates.map((d) => rec.get(`${p.id}|${d}`));
      const done = rows.filter((r) => r && r.clock_out);
      const reg = done.reduce((t, r) => t + workRegMs(r), 0);
      const ot = done.reduce((t, r) => t + otOf(r), 0);
      const sums = [rows.filter(Boolean).length, hours1(reg), hours1(ot), hours1(reg + ot)];
      aoa.push([i + 1, p.name, branchName(p.branch_id), p.hire_date || '', ...(JG ? [jobName(p.job_group_id)] : []), '출근', ...rows.map((r) => (r ? hm(r.clock_in) : '')), ...sums]);
      aoa.push([...blankFix, '퇴근', ...rows.map((r) => (!r ? '' : r.clock_out ? hm(r.clock_out) : '미퇴근')), '', '', '', '']);
      aoa.push([...blankFix, '연장', ...rows.map((r) => (r && r.clock_out ? hours1(otOf(r)) : '')), '', '', '', '']);
    });
    const ws = X.utils.aoa_to_sheet(aoa);

    // 병합: 제목, 고정 칸·합계 칸 머리(2줄), 직원별 고정 칸·합계(3줄)
    const M = (r1, c1, r2, c2) => ({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
    const merges = [M(0, 0, 0, nC - 1)];
    for (let c = 0; c < nF; c++) merges.push(M(1, c, 2, c));
    for (let c = nF + nD; c < nC; c++) merges.push(M(1, c, 2, c));
    list.forEach((_, i) => {
      const r = 3 + i * 3;
      for (let c = 0; c < nF - 1; c++) merges.push(M(r, c, r + 2, c));
      for (let c = nF + nD; c < nC; c++) merges.push(M(r, c, r + 2, c));
    });
    ws['!merges'] = merges;

    // 서식
    const thin = { style: 'thin', color: { rgb: 'A6A6A6' } };
    const thick = { style: 'medium', color: { rgb: '404040' } };
    const lastRow = aoa.length - 1;
    for (let r = 1; r <= lastRow; r++) {
      for (let c = 0; c < nC; c++) {
        const ref = X.utils.encode_cell({ r, c });
        const cell = ws[ref] || (ws[ref] = { t: 's', v: '' });
        const d = c >= nF && c < nF + nD ? dates[c - nF] : null;
        const wd = d ? wdOf(d) : '';
        const head = r <= 2;
        const personEnd = !head && (r - 3) % 3 === 2;
        const s = {
          font: { sz: 9, bold: head || c === 1 },
          alignment: { horizontal: 'center', vertical: 'center' },
          border: {
            top: (r - 3) % 3 === 0 && !head ? thick : thin,
            bottom: personEnd || r === 2 ? thick : thin,
            left: wd === '월' ? thick : thin,
            right: thin,
          },
        };
        if (head) s.fill = { fgColor: { rgb: 'DDE6F4' } };
        if ((wd === '토' || wd === '일') && r === 2) s.font.color = { rgb: 'D00000' };
        if ((wd === '토' || wd === '일') && !head) s.fill = { fgColor: { rgb: 'F7F7F7' } };
        if (cell.v === '미퇴근') s.font.color = { rgb: 'D00000' };
        if (!head && (r - 3) % 3 === 2 && cell.t === 'n') cell.z = '0.0';
        if (c >= nF + nD && !head && cell.t === 'n' && c > nF + nD) cell.z = '0.0';
        cell.s = s;
      }
    }
    ws.A1.s = { font: { bold: true, sz: 14 }, alignment: { horizontal: 'left', vertical: 'center' } };
    ws['!cols'] = [{ wch: 5 }, { wch: 9 }, { wch: 11 }, { wch: 11 }, ...(JG ? [{ wch: 8 }] : []), { wch: 5 }, ...dates.map(() => ({ wch: 6 })), { wch: 7 }, { wch: 9 }, { wch: 9 }, { wch: 9 }];
    ws['!rows'] = [{ hpt: 26 }];

    // ===== 시트2: 일별 상세 (직원 × 날짜, 기록 없는 날은 빈칸) =====
    const detail = [['이름', '점포', ...(JG ? ['분류'] : []), '날짜', '요일', '정규 시작', '정규 종료', '출근', '퇴근', '휴게시간', '소정근로시간', '연장근로시간(승인)', '총 근무시간', '미승인 초과', '비고']];
    list.forEach((p) => {
      dates.forEach((d) => {
        const r = rec.get(`${p.id}|${d}`);
        if (!r) { detail.push([p.name, branchName(p.branch_id), ...(JG ? [jobName(p.job_group_id)] : []), d, wdOf(d), '', '', '', '', '', '', '', '', '', '']); return; }
        const b = r.branch || branches.find((x) => x.id === r.branch_id);
        const hrs = hoursFor(r.branch_id, d, b);
        const brk = breakMs(regularMs(r));
        const reg = workRegMs(r);
        const ot = otOf(r);
        const extra = r.clock_out ? unapprovedMsForRow(r, otReqs) : 0;
        const memo = [
          r.home_branch_id && r.home_branch_id !== r.branch_id ? `지원 근무(${branchName(r.home_branch_id)} 소속)` : '',
          hrs.special ? `특정일 근무시간${hrs.note ? `(${hrs.note})` : ''}` : '', r.note || '',
        ].filter(Boolean).join(' / ');
        detail.push([p.name, r.branch?.name || branchName(r.branch_id), ...(JG ? [jobName(recJob(r))] : []), d, wdOf(d), tmLabel(hrs.start), tmLabel(hrs.end),
          hm(r.clock_in), r.clock_out ? hm(r.clock_out) : '미퇴근',
          r.clock_out ? hmDur(brk) : '', r.clock_out ? hmDur(reg) : '', r.clock_out ? hmDur(ot) : '', r.clock_out ? hmDur(reg + ot) : '',
          extra >= UNAPPROVED_SHOW_MS ? hmDur(extra) : '', memo]);
      });
    });
    const ws2 = makeSheet(X, detail, {});

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, '근태표');
    X.utils.book_append_sheet(wb, ws2, '일별 상세');
    const who = fu ? `_${list.find((p) => p.id === fu)?.name || ''}` : '';
    X.writeFile(wb, `근태현황_${from}_${to}_${branchTitle}${who}.xlsx`, { compression: true });
  }
  $('summary-csv-btn').addEventListener('click', (e) => exportAttendance('p', e.currentTarget));

  $('admin-records').addEventListener('click', (e) => {
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    if (id) openEdit(dailyRows.find((r) => String(r.id) === id));
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
    if (!row && $('d-user').value) $('edit-user').value = $('d-user').value;
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
    reloadRecords();
    if (me) { refreshToday(); loadMyRecords(); }
  });

  $('edit-delete').addEventListener('click', async () => {
    if (!editingId || !confirm('이 기록을 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    const { error } = await sb.from('attendance').delete().eq('id', editingId);
    if (error) return showError($('edit-error'), errMsg(error));
    $('edit-dialog').close();
    reloadRecords();
  });

  // 일자별 근무현황 엑셀 (개인별과 같은 근태표 형식, 일자별 화면의 기간·점포·직원 조건)
  $('csv-btn').addEventListener('click', (e) => exportAttendance('d', e.currentTarget));

  // ---------------------------------------------------------------
  //  관리자: 초과근무 승인
  // ---------------------------------------------------------------
  // 대기 중 건수 배지
  async function loadOtBadge() {
    const { count, error } = await sb.from('overtime_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    const badge = $('ot-badge');
    badge.hidden = !!error || !count;
    badge.textContent = count ? String(count) : '';
  }

  let otRows = [];
  let otAtt = [];
  let otSeq = 0;
  async function loadOvertimeAdmin(quiet = false) {
    if (!$('o-from').value || !$('o-to').value) return;
    if (quiet !== true) oLimit = PAGE;
    const seq = ++otSeq;
    const tbody = $('ot-list');
    if (!quiet) tbody.innerHTML = '<tr><td colspan="10" class="empty">불러오는 중...</td></tr>';
    const fb = $('o-branch').value;
    const fu = $('o-user').value;
    const st = $('o-status').value;
    const from = $('o-from').value;
    const to = $('o-to').value;
    const [ot, att] = await Promise.all([
      fetchAll(() => {
        let q = sb.from('overtime_requests')
          .select('*, branch:branches(name), profile:profiles!overtime_requests_user_id_fkey(name), reviewer:profiles!overtime_requests_reviewed_by_fkey(name)')
          .gte('work_date', from).lte('work_date', to)
          .order('work_date', { ascending: false }).order('start_at', { ascending: true }).order('id');
        if (fb === 'none') q = q.is('branch_id', null);
        else if (fb) q = q.eq('branch_id', fb);
        if (fu) q = q.eq('user_id', fu);
        if (st) q = q.eq('status', st);
        return q;
      }),
      fetchAll(() => {
        let q = sb.from('attendance').select('id, user_id, work_date, clock_in, clock_out')
          .gte('work_date', from).lte('work_date', shiftDate(to, 1)).order('id');
        if (fu) q = q.eq('user_id', fu);
        return q;
      }),
    ]);
    if (seq !== otSeq) return;
    const error = ot.error || att.error;
    if (error) { tbody.innerHTML = `<tr><td colspan="10" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
    otRows = ot.data.filter((q) => nameHit('o', q.profile?.name) && jobHit('o', staff.find((s) => s.id === q.user_id)?.job_group_id));
    otAtt = att.data;
    loadOtBadge();
    renderOvertimeAdmin();
  }

  let oLimit = PAGE;
  function renderOvertimeAdmin() {
    const tbody = $('ot-list');
    if (!otRows.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty">${nameQ('o') ? `"${esc(nameQ('o'))}" 이름의 신청 내역이 없습니다.` : '신청 내역이 없습니다.'}</td></tr>`; $('ot-summary').textContent = ''; return; }

    // 그 근무일의 실제 출퇴근 (해당 직원)
    const actualOf = (q) => otAtt.find((a) => a.user_id === q.user_id && a.work_date === q.work_date);
    let reqSum = 0;
    let recSum = 0;
    otRows.forEach((q) => { // 합계는 화면에 보이는 것과 상관없이 전체 기준
      if (q.status === 'approved') { reqSum += new Date(q.end_at) - new Date(q.start_at); recSum += recognizedOtMs(q, otAtt); }
    });
    tbody.innerHTML = otRows.slice(0, oLimit).map((q) => {
      const a = actualOf(q);
      const req = new Date(q.end_at) - new Date(q.start_at);
      const rec = recognizedOtMs(q, otAtt);
      const actual = a ? `${hm(a.clock_in)}~${a.clock_out ? hm(a.clock_out) : '<span class="tag-open">미퇴근</span>'}` : '<span class="muted">기록 없음</span>';
      const reviewed = q.reviewed_at ? `<span class="edited">${esc(q.reviewer?.name || '')} · ${ymd(q.reviewed_at).slice(5)} ${hm(q.reviewed_at)}${q.review_note ? `<br>${esc(q.review_note)}` : ''}</span>` : '';
      const mine = isManager() && q.user_id === me.id;
      return `
      <tr class="rec" data-id="${q.id}">
        <td>${dateLabel(q.work_date)}</td>
        <td>${esc(q.branch?.name || '미지정')}</td>
        <td>${esc(q.profile?.name)}</td>
        <td>${otTimeLabel(q)} <span class="dist">${fmtDur(req)}</span></td>
        <td>${q.is_after ? '사후' : '사전'}</td>
        <td class="note">${esc(q.reason)}</td>
        <td>${actual}</td>
        <td>${q.status === 'approved' ? fmtDur(rec) : (q.status === 'pending' && a?.clock_out ? `<span class="muted">승인 시 ${fmtDur(overlapMs(+new Date(q.start_at), +new Date(q.end_at), +new Date(a.clock_in), +new Date(a.clock_out)))}</span>` : '-')}</td>
        <td>${otStatusTag(q.status)}</td>
        <td class="actions">${q.status !== 'pending' ? reviewed
          : (isManager() && q.user_id === me.id) ? '<span class="muted small">매니저 처리</span>'
            : '<button class="btn small primary" data-ot-approve>승인</button><button class="btn small danger-outline" data-ot-reject>반려</button>'}</td>
        ${mSum(`<b>${esc(q.profile?.name)}</b><span class="ms-sub">${esc(q.branch?.name || '미지정')}</span>`,
          `${dateLabel(q.work_date)} ${otTimeLabel(q)} <span class="muted">(${fmtDur(req)} · ${q.is_after ? '사후' : '사전'})</span>`,
          q.status === 'pending' && !mine
            ? '<button class="btn small primary" data-ot-approve>승인</button><button class="btn small danger-outline" data-ot-reject>반려</button>'
            : otStatusTag(q.status))}
      </tr>`;
    }).join('') + moreRow('o', Math.min(oLimit, otRows.length), otRows.length, 10, '건');
    const pend = otRows.filter((q) => q.status === 'pending').length;
    $('ot-summary').textContent = `${otRows.length}건${pend ? ` · 대기 ${pend}건` : ''} · 승인 신청시간 ${fmtDur(reqSum)} · 인정 시간 ${fmtDur(recSum)}`;
  }

  $('ot-list').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const q = otRows.find((x) => String(x.id) === tr.dataset.id);
    if (!q) return;
    let approve;
    let note;
    if (e.target.matches('[data-ot-approve]')) {
      note = prompt(`${q.profile?.name}님의 초과근무(${dateLabel(q.work_date)} ${otTimeLabel(q)})를 승인합니다.\n메모(선택):`, '');
      if (note === null) return;
      approve = true;
    } else if (e.target.matches('[data-ot-reject]')) {
      note = prompt(`${q.profile?.name}님의 초과근무(${dateLabel(q.work_date)} ${otTimeLabel(q)})를 반려합니다.\n반려 사유(필수):`, '');
      if (note === null) return;
      if (!note.trim()) return alert('반려 사유를 입력하세요.');
      approve = false;
    } else return;
    tr.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const { error } = await sb.rpc('review_overtime', { p_id: q.id, p_approve: approve, p_note: note.trim() || null });
    if (error) { alert(errMsg(error)); tr.querySelectorAll('button').forEach((b) => { b.disabled = false; }); return; }
    // 조용히 갱신: 펼쳐 둔 목록(더 보기)·날짜 접기 상태를 유지
    loadOvertimeAdmin(true);
    loadPersonal(true);
    loadDaily(true);
  });
  $('ot-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { oLimit += PAGE; renderOvertimeAdmin(); }
    else if (e.target.closest('[data-more-all]')) { oLimit = Infinity; renderOvertimeAdmin(); }
  });

  $('ot-csv-btn').addEventListener('click', () => {
    if (!otRows.length) return alert('다운로드할 내용이 없습니다. 먼저 조회하세요.');
    const mins = (ms) => Math.floor(ms / 60000);
    const lines = [['근무일', '점포', '이름', '시작', '종료', '신청 시간(분)', '구분', '사유', '실제 출근', '실제 퇴근', '인정 시간(분)', '상태', '처리자', '처리일시', '메모']];
    otRows.slice().reverse().forEach((q) => {
      const a = otAtt.find((x) => x.user_id === q.user_id && x.work_date === q.work_date);
      lines.push([
        q.work_date, q.branch?.name || '미지정', q.profile?.name,
        `${ymd(q.start_at)} ${hm(q.start_at)}`, `${ymd(q.end_at)} ${hm(q.end_at)}`,
        mins(new Date(q.end_at) - new Date(q.start_at)), q.is_after ? '사후' : '사전', q.reason,
        a ? hm(a.clock_in) : '', a?.clock_out ? hm(a.clock_out) : '',
        q.status === 'approved' ? mins(recognizedOtMs(q, otAtt)) : '',
        OT_STATUS[q.status]?.[0] || q.status, q.reviewer?.name || '',
        q.reviewed_at ? `${ymd(q.reviewed_at)} ${hm(q.reviewed_at)}` : '', q.review_note || '',
      ]);
    });
    downloadXlsx(`초과근무_${$('o-from').value}_${$('o-to').value}.xlsx`, lines, { sheetName: '초과근무' });
  });

  // 권한: 일반 사용자(user) / 슈퍼바이저(supervisor, 소속 점포 관리) / 매니저(manager, 전체 관리)
  const ROLES = [['user', '일반 사용자'], ['supervisor', '슈퍼바이저'], ['manager', '매니저']];
  const roleOf = (s) => (s.is_admin ? 'manager' : s.is_branch_manager ? 'supervisor' : 'user');
  const roleOptions = (cur) => ROLES.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  const roleFlags = (role) => ({ is_admin: role === 'manager', is_branch_manager: role === 'supervisor' });

  // 직원 관리
  function renderStaff() {
    if (!me) return;
    const fb = $('s-branch').value;
    const curNa = $('na-branch').value;
    $('na-branch').innerHTML = branchOptions({ onlyActive: true });
    $('na-branch').value = curNa;
    const statusKnown = authStatus.size > 0;
    // 삭제(퇴사) 처리된 직원은 [퇴사자 관리]에서 따로 관리
    const q = $('s-search').value.trim().toLowerCase();
    const hit = (s) => !q || s.name.toLowerCase().includes(q) || loginIdOf(s.email).toLowerCase().includes(q);
    const fj = $('s-job').value;
    const list = staff.filter((s) => matchBranch(s.branch_id, fb) && matchJob(s.job_group_id ?? null, fj) && !s.deleted_at && hit(s))
      .sort((a, b) => (isActive(b.id) - isActive(a.id)) || a.name.localeCompare(b.name, 'ko'));
    $('staff-list').innerHTML = list.map((s) => {
      const st = authStatus.get(s.id);
      const active = isActive(s.id);
      const self = s.id === me.id;
      const last = st?.last_sign_in_at ? `${ymd(st.last_sign_in_at)} ${hm(st.last_sign_in_at)}` : (statusKnown ? '없음' : '-');
      return `
      <tr data-id="${s.id}" class="${active ? '' : 'inactive'}">
        <td>${self ? '' : `<input type="checkbox" class="s-check" ${staffChecked.has(s.id) ? 'checked' : ''}>`}</td>
        <td><input type="text" value="${esc(s.name)}" maxlength="30" data-field="name"></td>
        <td><select data-field="branch_id">${branchOptions({ current: s.branch_id, onlyActive: true })}</select>${supportTags(s.id)}</td>
        ${FEATURE_JOB_GROUPS ? `<td><select data-field="job_group_id">${jobOptions(s.job_group_id ?? null)}</select></td>` : ''}
        <td><input type="date" value="${esc(s.hire_date || '')}" data-field="hire_date" class="hire-input"></td>
        <td>${esc(loginIdOf(s.email))}</td>
        <td>${statusKnown ? (active ? '<span class="status-on">사용 중</span>' : '<span class="status-off">비활성</span>') : '-'}</td>
        <td>${sessionInfo(s.id)}</td>
        <td class="edited">${last}</td>
        <td><select data-field="role" ${self ? 'disabled title="본인의 권한은 바꿀 수 없습니다"' : ''}>${roleOptions(roleOf(s))}</select></td>
        <td class="actions">
          <button class="btn small" data-save>저장</button>
          <button class="btn small" data-reset>비밀번호 초기화</button>
          ${self ? '' : `<button class="btn small" data-toggle="${active ? 'off' : 'on'}">${active ? '비활성화' : '다시 사용'}</button>`}
          ${!self && statusKnown && !active ? '<button class="btn small danger-outline" data-delete>삭제</button>' : ''}
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="${FEATURE_JOB_GROUPS ? 11 : 10}" class="empty">${q ? `"${esc(q)}"에 해당하는 직원이 없습니다.` : '직원이 없습니다.'}</td></tr>`;
    renderJobGroups();
    renderSupports();
    updateLogoutButtons();
  }

  // ---- 로그인 중인 기기 수 / 강제 로그아웃 (매니저) ----
  let sessionMap = new Map(); // user_id -> { sessions, last_active }
  const staffChecked = new Set();
  function sessionInfo(id) {
    if (!sessionMap.loaded) return '-';
    const s = sessionMap.get(id);
    return s ? `<span class="status-on">로그인 ${s.sessions}대</span>` : '<span class="muted">-</span>';
  }
  async function loadSessions() {
    if (!me?.is_admin) return;
    const { data, error } = await sb.rpc('session_counts');
    if (error) return;
    sessionMap = new Map(data.map((r) => [r.user_id, r]));
    sessionMap.loaded = true;
  }
  function visibleStaffIds() {
    return [...$('staff-list').querySelectorAll('.s-check')].map((c) => c.closest('tr').dataset.id);
  }
  function updateLogoutButtons() {
    [...staffChecked].forEach((id) => { if (!staff.some((s) => s.id === id && !s.deleted_at)) staffChecked.delete(id); });
    const btn = $('s-logout-sel');
    btn.disabled = !staffChecked.size;
    btn.textContent = staffChecked.size ? `선택한 직원 로그아웃 (${staffChecked.size}명)` : '선택한 직원 로그아웃';
    const vis = visibleStaffIds();
    const all = $('s-check-all');
    all.checked = vis.length > 0 && vis.every((id) => staffChecked.has(id));
    all.indeterminate = !all.checked && vis.some((id) => staffChecked.has(id));
  }
  $('staff-list').addEventListener('change', (e) => {
    if (!e.target.matches('.s-check')) return;
    const id = e.target.closest('tr').dataset.id;
    if (e.target.checked) staffChecked.add(id); else staffChecked.delete(id);
    updateLogoutButtons();
  });
  $('s-search').addEventListener('input', () => renderStaff());
  $('s-job').addEventListener('change', () => renderStaff());
  $('s-check-all').addEventListener('change', (e) => {
    visibleStaffIds().forEach((id) => { if (e.target.checked) staffChecked.add(id); else staffChecked.delete(id); });
    renderStaff();
  });
  async function forceLogout(ids, label) {
    const { data, error } = await sb.rpc('force_logout', { p_user_ids: ids });
    if (error) return alert(errMsg(error));
    alert(`${label}\n로그인 ${data}건을 끊었습니다. 해당 기기는 1분 안에 로그인 화면으로 바뀌고, 출근·퇴근은 바로 막힙니다.`);
    staffChecked.clear();
    await loadSessions();
    renderStaff();
  }
  $('s-logout-sel').addEventListener('click', () => {
    const names = staff.filter((s) => staffChecked.has(s.id)).map((s) => s.name);
    if (!names.length) return;
    const shown = names.length > 10 ? `${names.slice(0, 10).join(', ')} 외 ${names.length - 10}명` : names.join(', ');
    if (!confirm(`선택한 ${names.length}명을 모든 기기에서 로그아웃시킵니다.\n(${shown})\n\n계속할까요?`)) return;
    forceLogout([...staffChecked], `${names.length}명을 로그아웃시켰습니다.`);
  });
  $('s-logout-all').addEventListener('click', () => {
    if (!confirm('본인을 뺀 모든 직원을 모든 기기에서 로그아웃시킵니다.\n직원들은 다시 로그인해야 합니다.\n\n계속할까요?')) return;
    forceLogout(null, '본인을 뺀 전체 직원을 로그아웃시켰습니다.');
  });

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
    const flags = roleFlags($('na-role').value);
    if (flags.is_branch_manager && !$('na-branch').value) {
      msg.textContent = '슈퍼바이저는 소속 점포가 있어야 합니다. 점포를 선택하세요.';
      msg.className = 'msg err'; msg.hidden = false; btn.disabled = false;
      return;
    }
    try {
      await staffApi({
        action: 'create',
        login_id: loginId,
        domain: CFG.EMAIL_DOMAIN,
        name,
        password: $('na-pw').value,
        branch_id: $('na-branch').value || null,
        hire_date: $('na-hire').value || null,
        ...(FEATURE_JOB_GROUPS ? { job_group_id: $('na-job').value || null } : {}),
        ...flags,
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

  // ---------------------------------------------------------------
  //  직원 일괄 등록 (엑셀/CSV 명단 → 검사 → 50명씩 나눠 등록 → 결과 파일)
  // ---------------------------------------------------------------
  const BULK_HEAD = FEATURE_JOB_GROUPS
    ? ['이름', '아이디', '점포', '입사일', '분류', '권한', '초기 비밀번호']
    : ['이름', '아이디', '점포', '입사일', '권한', '초기 비밀번호'];
  const BULK_TEXT_COLS = FEATURE_JOB_GROUPS ? [1, 3, 6] : [1, 3, 5]; // 아이디·입사일·비밀번호 칸은 텍스트 서식
  // 입사일: 2024-01-02 / 2024.1.2 / 2024/1/2 / 24-1-2 / 1/2/24(엑셀 날짜) → 'YYYY-MM-DD', 비어 있으면 '', 틀리면 null
  function parseHireDate(v) {
    const s = String(v ?? '').trim();
    if (!s) return '';
    let y; let m; let d;
    let k = s.match(/^(\d{2,4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})일?$/);
    if (k) [, y, m, d] = k;
    else if ((k = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) [, m, d, y] = k;
    else if ((k = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [, y, m, d] = k;
    else return null;
    y = Number(y); if (y < 100) y += 2000;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const t = new Date(`${iso}T12:00:00Z`);
    return !Number.isNaN(+t) && t.toISOString().slice(0, 10) === iso && y >= 1950 && y <= 2100 ? iso : null;
  }
  const BULK_MAX = 2000;
  let bulkRows = [];      // { line, name, id, branchName, branchId, roleText, role, pw, pwAuto, errors[], status, msg }
  let bulkDone = false;

  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // xlsx-js-style: SheetJS에 칸 서식(테두리·색·글꼴)을 더한 판 (읽기·쓰기 모두 SheetJS와 같음)
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
      s.onload = () => resolve();
      s.onerror = () => { xlsxLoading = null; reject(new Error('엑셀 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  // 헷갈리는 글자(0/O, 1/l/I)를 뺀 10자리 비밀번호
  function randomPw() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(10);
    crypto.getRandomValues(buf);
    let pw = Array.from(buf, (n) => chars[n % chars.length]).join('');
    if (!/\d/.test(pw)) pw = pw.slice(0, 9) + '7';
    return pw;
  }

  const ROLE_WORDS = { '': 'user', 일반: 'user', '일반 사용자': 'user', 일반사용자: 'user', 사용자: 'user', 직원: 'user', user: 'user',
    슈퍼바이저: 'supervisor', supervisor: 'supervisor', 매니저: 'manager', manager: 'manager' };
  const roleLabel = (r) => (ROLES.find(([v]) => v === r) || [, '?'])[1];

  $('bulk-template').addEventListener('click', async () => {
    await loadBranches();
    const guide = [
      ['칸', '필수', '설명', '예시'],
      ['이름', '필수', '30자 이내', '홍길동'],
      ['아이디', '필수', `영문 소문자·숫자·. _ - 로 2~30자. 로그인할 때 이 아이디만 입력합니다. (@${CFG.EMAIL_DOMAIN || ''})`, 'hong / 00123'],
      ['점포', '선택', '아래 [사용 중인 점포] 이름을 그대로 적습니다. 비우면 점포 미지정', branches.find((b) => b.is_active)?.name || '본사'],
      ['입사일', '선택', '2024-01-02 형식 (2024.1.2, 24-1-2도 가능). 근태표 엑셀에 표시됩니다', '2024-01-02'],
      ...(FEATURE_JOB_GROUPS ? [['분류', '선택', '아래 [분류 목록] 이름을 그대로 적습니다 (직원 관리 → 직원 분류에서 만든 이름). 비우면 미지정', jobGroups[0]?.name || '판매']] : []),
      ['권한', '선택', '일반 사용자 / 슈퍼바이저 / 매니저 중 하나. 비우면 일반 사용자. 슈퍼바이저는 점포 필수', '일반 사용자'],
      ['초기 비밀번호', '선택', '8자 이상. 비우면 10자리 무작위로 자동 생성', ''],
      [],
      ['사용 중인 점포'],
      ...branches.filter((b) => b.is_active).map((b) => [b.name]),
      ...(FEATURE_JOB_GROUPS ? [[], ['분류 목록'], ...jobGroups.map((g) => [g.name])] : []),
    ];
    // 아이디·비밀번호 칸은 텍스트 서식 (00123 같은 사번이 123으로 바뀌지 않게)
    downloadXlsx('직원_일괄등록_양식.xlsx', [BULK_HEAD], {
      sheetName: '직원 명단', textCols: BULK_TEXT_COLS, blankRows: BULK_MAX, filter: false,
      sheets: [{ name: '작성 안내', lines: guide }],
    });
  });

  // 파일 → 2차원 배열 (CSV는 UTF-8이 아니면 엑셀 기본 한글 인코딩(EUC-KR)으로 읽음)
  async function readSheet(file) {
    await loadXlsx();
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch (_) { text = new TextDecoder('euc-kr').decode(buf); }
      wb = window.XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
    } else {
      wb = window.XLSX.read(buf, { type: 'array' });
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  }

  function parseBulk(table) {
    const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
    const hi = table.findIndex((r) => r.map(norm).includes('이름') && r.map(norm).includes('아이디'));
    if (hi < 0) throw new Error('첫 줄에 "이름", "아이디" 칸 제목이 있는 양식을 사용하세요. ([양식 내려받기])');
    const head = table[hi].map(norm);
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const c = { name: col('이름'), id: col('아이디'), branch: col('점포', '소속 점포', '소속점포', '점포명', '지점', '소속 지점', '소속지점', '지점명'), /* 예전 양식(지점)도 읽음 */ hire: col('입사일'), job: FEATURE_JOB_GROUPS ? col('분류', '근무조', '직무') : -1, role: col('권한'), pw: col('초기 비밀번호', '초기비밀번호', '비밀번호') };
    const rows = [];
    table.slice(hi + 1).forEach((r, k) => {
      const get = (i) => (i < 0 ? '' : norm(r[i]));
      if (![c.name, c.id, c.branch, c.hire, c.job, c.role, c.pw].some((i) => get(i))) return; // 빈 줄
      rows.push({ line: hi + k + 2, name: get(c.name), id: get(c.id).toLowerCase(), branchName: get(c.branch), hireText: get(c.hire), jobText: get(c.job), roleText: get(c.role), pw: c.pw < 0 ? '' : String(r[c.pw] ?? '').trim() });
    });
    if (!rows.length) throw new Error('명단이 비어 있습니다.');
    if (rows.length > BULK_MAX) throw new Error(`한 번에 ${BULK_MAX}명까지 등록할 수 있습니다. 파일을 나눠서 올려 주세요. (현재 ${rows.length}명)`);
    return rows;
  }

  function checkBulk(rows) {
    const taken = new Set();
    staff.filter((s) => !s.deleted_at).forEach((s) => taken.add(loginIdOf(s.email)));
    authStatus.forEach((u) => { if (u.email) taken.add(loginIdOf(u.email)); });
    const count = new Map();
    rows.forEach((r) => count.set(r.id, (count.get(r.id) || 0) + 1));
    rows.forEach((r) => {
      const e = [];
      if (!r.name) e.push('이름 없음'); else if (r.name.length > 30) e.push('이름 30자 초과');
      if (!r.id) e.push('아이디 없음');
      else if (!/^[a-z0-9._-]{2,30}$/.test(r.id)) e.push('아이디는 영문 소문자·숫자·._- 2~30자');
      else if (taken.has(r.id)) e.push('이미 사용 중인 아이디');
      else if (count.get(r.id) > 1) e.push('파일 안에서 아이디 중복');
      r.branchId = null;
      if (r.branchName) {
        const b = branches.find((x) => x.name === r.branchName);
        if (!b) e.push(`없는 점포 "${r.branchName}"`);
        else if (!b.is_active) e.push(`사용 중지된 점포 "${r.branchName}"`);
        else r.branchId = b.id;
      }
      r.jobId = null;
      if (r.jobText) {
        const g = jobGroups.find((x) => x.name === r.jobText);
        if (!g) e.push(`없는 분류 "${r.jobText}"`); else r.jobId = g.id;
      }
      r.hire = parseHireDate(r.hireText);
      if (r.hire === null) e.push(`입사일 "${r.hireText}" 형식 오류 (예: 2024-01-02)`);
      r.role = ROLE_WORDS[r.roleText.replace(/\s+/g, ' ')] || ROLE_WORDS[r.roleText.toLowerCase()];
      if (!r.role) e.push(`권한 "${r.roleText}"을(를) 알 수 없음`);
      else if (r.role === 'supervisor' && !r.branchId) e.push('슈퍼바이저는 점포 필수');
      r.pwAuto = !r.pw;
      if (r.pwAuto) r.pw = randomPw();
      else if (r.pw.length < 8) e.push('비밀번호 8자 이상');
      r.errors = e;
      r.status = e.length ? 'invalid' : 'ready';
      r.msg = e.join(', ');
    });
  }

  function renderBulk() {
    const ok = bulkRows.filter((r) => r.status === 'ready').length;
    const bad = bulkRows.filter((r) => r.status === 'invalid').length;
    const done = bulkRows.filter((r) => r.status === 'done').length;
    const fail = bulkRows.filter((r) => r.status === 'fail').length;
    const sum = $('bulk-summary');
    if (bulkDone) {
      sum.textContent = `등록 완료: 성공 ${done}명${fail ? ` · 실패 ${fail}명` : ''}${bad ? ` · 검사 오류로 제외 ${bad}명` : ''}. [결과 파일 내려받기]로 아이디·초기 비밀번호를 받아 직원에게 전달하세요.`;
      sum.className = `msg ${fail ? 'err' : 'ok'}`;
    } else {
      sum.textContent = `총 ${bulkRows.length}명 · 등록 가능 ${ok}명${bad ? ` · 오류 ${bad}명 (오류가 있는 직원은 등록되지 않습니다. 파일을 고쳐 다시 올릴 수 있습니다)` : ''}`;
      sum.className = `msg ${bad ? 'err' : 'ok'}`;
    }
    $('bulk-run').hidden = bulkDone;
    $('bulk-run').disabled = !ok;
    $('bulk-run').textContent = `${ok}명 등록`;
    $('bulk-result').hidden = !bulkDone;
    // 오류·실패를 위로
    const order = { invalid: 0, fail: 0, ready: 1, done: 2 };
    const list = bulkRows.slice().sort((a, b) => order[a.status] - order[b.status] || a.line - b.line);
    $('bulk-list').innerHTML = list.map((r) => {
      const cls = r.status === 'invalid' || r.status === 'fail' ? 'bulk-err' : r.status === 'done' ? 'bulk-done' : '';
      const res = r.status === 'invalid' ? `<span class="bulk-bad">${esc(r.msg)}</span>`
        : r.status === 'fail' ? `<span class="bulk-bad">등록 실패: ${esc(r.msg)}</span>`
          : r.status === 'done' ? '<span class="bulk-good">등록됨</span>' : '<span class="muted">등록 가능</span>';
      return `<tr class="${cls}"><td class="num">${r.line}</td><td>${esc(r.name)}</td><td>${esc(r.id)}</td><td>${esc(r.branchName || '(미지정)')}</td><td>${esc(r.hire || r.hireText || '')}</td>${FEATURE_JOB_GROUPS ? `<td>${esc(r.jobText || '')}</td>` : ''}
        <td>${r.role ? roleLabel(r.role) : esc(r.roleText)}</td><td>${r.pwAuto ? '<span class="muted">자동 생성</span>' : '직접 지정'}</td><td>${res}</td></tr>`;
    }).join('');
  }

  $('bulk-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) handleBulkFile(file);
  });
  // 끌어다 놓기로 올리기 (상자 밖에 잘못 놓아도 브라우저가 파일을 열어 화면이 바뀌지 않게 막음)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  const drop = $('bulk-drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || !drop.contains(e.relatedTarget)) drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return alert('엑셀(.xlsx) 또는 CSV 파일만 올릴 수 있습니다.');
    handleBulkFile(file);
  });
  async function handleBulkFile(file) {
    $('bulk-file-name').textContent = `올린 파일: ${file.name}`;
    bulkDone = false;
    $('bulk-preview').hidden = true;
    try {
      await Promise.all([loadBranches(), loadStaff()]);
      bulkRows = parseBulk(await readSheet(file));
      checkBulk(bulkRows);
      renderBulk();
      $('bulk-preview').hidden = false;
    } catch (err) {
      bulkRows = [];
      alert(err.message);
    }
  }

  $('bulk-clear').addEventListener('click', () => {
    if (bulkRows.length && !bulkDone && !confirm('명단을 닫을까요? (아직 등록하지 않았습니다)')) return;
    bulkRows = []; bulkDone = false;
    $('bulk-preview').hidden = true;
    $('bulk-file-name').textContent = '';
  });

  $('bulk-run').addEventListener('click', async () => {
    const todo = bulkRows.filter((r) => r.status === 'ready');
    if (!todo.length) return;
    const bad = bulkRows.length - todo.length;
    if (!confirm(`${todo.length}명을 등록합니다.${bad ? `\n(오류 ${bad}명은 제외)` : ''}\n계속할까요?`)) return;
    showBusy('직원 등록 중', '');
    $('busy-text').dataset.retry = '1';
    const CHUNK = 50;
    try {
      for (let i = 0; i < todo.length; i += CHUNK) {
        $('busy-text').textContent = `${i} / ${todo.length}명 완료\n화면을 닫지 말고 기다려 주세요.`;
        const part = todo.slice(i, i + CHUNK);
        let results = null;
        for (let attempt = 1; attempt <= 3 && !results; attempt++) {
          try {
            const d = await staffApi({
              action: 'bulk_create',
              domain: CFG.EMAIL_DOMAIN,
              rows: part.map((r) => ({ login_id: r.id, name: r.name, password: r.pw, branch_id: r.branchId, hire_date: r.hire || null, ...(FEATURE_JOB_GROUPS ? { job_group_id: r.jobId } : {}), ...roleFlags(r.role) })),
            });
            results = d.results;
          } catch (err) {
            if (attempt === 3) part.forEach((r) => { r.status = 'fail'; r.msg = err.message; });
            else await sleep(2000 * attempt);
          }
        }
        // 응답을 못 받았어도 서버에서는 만들어졌을 수 있음 → 다시 보내면 '이미 사용 중'이 되므로 그 경우도 실패로 남기고 목록에서 확인
        (results || []).forEach((res, k) => {
          const r = part[k];
          if (res && res.ok) { r.status = 'done'; r.msg = ''; }
          else { r.status = 'fail'; r.msg = res?.error || '알 수 없는 오류'; }
        });
      }
    } finally {
      hideBusy();
    }
    bulkDone = true;
    renderBulk();
    await Promise.all([loadStaff(), loadAuthStatus()]);
    renderStaff();
  });

  $('bulk-result').addEventListener('click', () => {
    const lines = [[...BULK_HEAD, '결과']];
    bulkRows.slice().sort((a, b) => a.line - b.line).forEach((r) => {
      lines.push([r.name, r.id, r.branchName, r.hire || r.hireText || '', ...(FEATURE_JOB_GROUPS ? [r.jobText || ''] : []), r.role ? roleLabel(r.role) : r.roleText,
        r.status === 'done' ? r.pw : '', r.status === 'done' ? '등록됨' : `미등록: ${r.msg}`]);
    });
    const d = new Date();
    downloadXlsx(`직원_등록결과_${ymd(d)}_${hm(d).replace(':', '')}.xlsx`, lines, { sheetName: '등록 결과', textCols: BULK_TEXT_COLS });
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
        alert(`${s.name} 계정을 삭제했습니다. 근태 기록은 보존되며 관리자 메뉴의 [퇴사자 관리]에서 볼 수 있습니다.`);
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

  // ---------------------------------------------------------------
  //  퇴사자 관리 (매니저 전용): 삭제 처리된 직원 목록 + 기록 보기 + 영구 삭제
  // ---------------------------------------------------------------
  const KEEP_YEARS = 3; // 근로기준법상 근로계약 관련 서류 보존 기간
  let retiredInfo = new Map(); // user_id -> { att_count, first_date, last_date, ot_count }
  let retiredSeq = 0;

  function updateRetiredBadge() {
    const n = staff.filter((s) => s.deleted_at).length;
    $('retired-badge').hidden = !n;
    $('retired-badge').textContent = n ? String(n) : '';
  }

  async function loadRetiredSummary() {
    if (!me?.is_admin) return;
    const seq = ++retiredSeq;
    const { data, error } = await sb.rpc('retired_staff_summary');
    if (seq !== retiredSeq) return;
    if (error) { console.warn('퇴사자 요약을 불러오지 못했습니다:', errMsg(error)); return; }
    retiredInfo = new Map(data.map((r) => [r.user_id, r]));
  }

  // 보존 기한 = 마지막 근무일 + 3년 (기록이 없으면 기한 없음)
  function keepUntil(info) {
    if (!info?.last_date) return null;
    const [y, m, d] = info.last_date.split('-');
    return `${Number(y) + KEEP_YEARS}-${m}-${d}`;
  }
  const keepOver = (until) => !until || ymd(new Date()) >= until;

  function renderRetired() {
    if (!me?.is_admin) return;
    const fb = $('r-branch').value;
    const q = $('r-search').value.trim();
    const list = staff.filter((s) => s.deleted_at && matchBranch(s.branch_id, fb) && (!q || s.name.includes(q)))
      .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at) || a.name.localeCompare(b.name, 'ko'));
    const known = retiredInfo.size > 0 || !staff.some((s) => s.deleted_at);
    $('retired-list').innerHTML = list.map((s) => {
      const info = retiredInfo.get(s.id);
      const until = keepUntil(info);
      const keep = !info ? '-'
        : !until ? '<span class="muted">기록 없음</span>'
        : keepOver(until) ? `<span class="keep-over">경과</span> <span class="edited">(${until})</span>`
        : `<span class="keep-due">${until}까지</span>`;
      const period = !info ? '-' : info.first_date ? `${info.first_date} ~ ${info.last_date}` : '-';
      return `
      <tr data-id="${s.id}">
        <td>${esc(s.name)}</td>
        <td>${esc(branchName(s.branch_id))}</td>
        <td>${esc(loginIdOf(s.email))}</td>
        <td class="num">${ymd(s.deleted_at)}</td>
        <td class="num">${period}</td>
        <td class="num">${info ? `${Number(info.att_count).toLocaleString()}건` : '-'}</td>
        <td class="num">${info ? `${Number(info.ot_count).toLocaleString()}건` : '-'}</td>
        <td>${keep}</td>
        <td class="actions">
          <button class="btn small" data-rview ${info && !info.first_date ? 'disabled title="출퇴근 기록이 없습니다"' : ''}>기록 보기</button>
          <button class="btn small danger-outline" data-rpurge ${known ? '' : 'disabled'}>영구 삭제</button>
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="9" class="empty">${staff.some((s) => s.deleted_at) ? '조건에 맞는 퇴사자가 없습니다.' : '퇴사 처리된 직원이 없습니다.'}</td></tr>`;
  }
  $('r-branch').addEventListener('change', renderRetired);
  $('r-search').addEventListener('input', renderRetired);

  // [기록 보기] → 출퇴근 기록 탭의 개인별 근무현황에서 그 직원의 근무 기간을 조회
  function showRetiredRecords(s) {
    const info = retiredInfo.get(s.id);
    document.querySelectorAll('#admin-view .subtabs[data-for="admin"] [data-sub]').forEach((x) => x.classList.toggle('active', x.dataset.sub === 'personal'));
    switchTab('admin'); // 근태 관리 → 개인별 근무현황
    $('p-branch').value = '';
    fillUserSelect('p');
    $('p-user').value = s.id;
    if (info?.first_date) {
      $('p-month').value = '';
      $('p-from').value = info.first_date;
      $('p-to').value = info.last_date;
    }
    loadPersonal();
    $('p-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // [영구 삭제] 확인 창
  let purgeTarget = null;
  function openPurge(s) {
    purgeTarget = s;
    const info = retiredInfo.get(s.id) || { att_count: 0, ot_count: 0 };
    const until = keepUntil(info);
    $('purge-title').textContent = `영구 삭제 - ${s.name}`;
    $('purge-items').innerHTML = `
      <li>직원 정보: ${esc(s.name)} (${esc(loginIdOf(s.email))}, ${esc(branchName(s.branch_id))})</li>
      <li>출퇴근 기록 ${Number(info.att_count).toLocaleString()}건${info.first_date ? ` (${info.first_date} ~ ${info.last_date})` : ''}</li>
      <li>초과근무 신청 ${Number(info.ot_count).toLocaleString()}건</li>`;
    const early = !keepOver(until);
    $('purge-keep').hidden = !early;
    $('purge-keep').innerHTML = early
      ? `아직 <b>보존 기한(${until}) 전</b>입니다. 법정 보존 의무가 있을 수 있으니 인사·노무 담당자와 확인하세요. 필요하면 [기록 보기]에서 엑셀로 먼저 받아 두세요.`
      : '';
    $('purge-ack-wrap').hidden = !early;
    $('purge-ack').checked = false;
    $('purge-name-hint').textContent = `"${s.name}"`;
    $('purge-name').value = '';
    showError($('purge-error'), '');
    updatePurgeOk();
    $('purge-dialog').showModal();
  }
  function updatePurgeOk() {
    if (!purgeTarget) return;
    const nameOk = $('purge-name').value.trim() === purgeTarget.name;
    const ackOk = $('purge-ack-wrap').hidden || $('purge-ack').checked;
    $('purge-ok').disabled = !(nameOk && ackOk);
  }
  $('purge-name').addEventListener('input', updatePurgeOk);
  $('purge-ack').addEventListener('change', updatePurgeOk);
  $('purge-cancel').addEventListener('click', () => $('purge-dialog').close());
  $('purge-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!purgeTarget) return;
    const btn = $('purge-ok'); btn.disabled = true;
    const { data, error } = await sb.rpc('purge_retired_staff', { p_user_id: purgeTarget.id, p_name: $('purge-name').value.trim() });
    if (error) { showError($('purge-error'), errMsg(error)); updatePurgeOk(); return; }
    $('purge-dialog').close();
    await Promise.all([loadStaff(), loadRetiredSummary()]);
    renderRetired();
    alert(`${data.name}님의 정보와 기록(출퇴근 ${data.attendance}건, 초과근무 ${data.overtime}건)을 영구 삭제했습니다.`);
  });

  $('retired-list').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    const s = tr && staff.find((x) => x.id === tr.dataset.id);
    if (!s) return;
    if (e.target.matches('[data-rview]')) showRetiredRecords(s);
    else if (e.target.matches('[data-rpurge]')) openPurge(s);
  });

  $('staff-list').addEventListener('click', async (e) => {
    if (!e.target.matches('[data-save]')) return;
    const tr = e.target.closest('tr');
    const name = tr.querySelector('[data-field="name"]').value.trim();
    if (!name) return alert('이름을 입력하세요.');
    const bv = tr.querySelector('[data-field="branch_id"]').value;
    const update = { name, branch_id: bv ? Number(bv) : null, hire_date: tr.querySelector('[data-field="hire_date"]').value || null };
    if (FEATURE_JOB_GROUPS) { const jv = tr.querySelector('[data-field="job_group_id"]').value; update.job_group_id = jv ? Number(jv) : null; }
    if (tr.dataset.id !== me.id) {
      Object.assign(update, roleFlags(tr.querySelector('[data-field="role"]').value));
      if (update.is_branch_manager && !update.branch_id) return alert('슈퍼바이저는 소속 점포가 있어야 합니다. 소속 점포를 먼저 선택하세요.');
    }
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
    renderJobGroups(); // 분류별 인원 수 갱신
  });

  // 점포 관리
  const hasLoc = (b) => b.lat != null && b.lng != null;
  const coordText = (b) => (hasLoc(b) ? `${b.lat}, ${b.lng}` : '');

  // ---- 주소 → 좌표 (OpenStreetMap Nominatim, 키 불필요) ----
  //  precise: 건물·번지까지 찾았는지. 도로·동네 위치로만 잡히면 false → 지도에서 직접 찍도록 안내
  const PRECISE_CLASSES = ['building', 'amenity', 'office', 'shop', 'tourism', 'leisure', 'craft', 'healthcare', 'man_made'];
  async function geocode(addr) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&countrycodes=kr&limit=1&accept-language=ko&q=${encodeURIComponent(addr)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`검색 실패 (${res.status})`);
    const list = await res.json();
    if (!list.length) return null;
    const r = list[0];
    const precise = !!r.address?.house_number || PRECISE_CLASSES.includes(r.category || r.class) ||
      ((r.category || r.class) === 'place' && ['house', 'building'].includes(r.type));
    return {
      lat: Math.round(Number(r.lat) * 1e6) / 1e6,
      lng: Math.round(Number(r.lon) * 1e6) / 1e6,
      label: String(r.display_name || '').split(',').slice(0, 3).join(',').trim(),
      precise,
    };
  }

  // ---- 지도에서 위치 선택 (Leaflet + OpenStreetMap 지도, 필요할 때만 불러옴) ----
  let leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      s.onload = () => resolve();
      s.onerror = () => { leafletLoading = null; reject(new Error('지도를 불러오지 못했습니다. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(s);
    });
    return leafletLoading;
  }

  const inKorea = (lat, lng) => lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132;
  let pickMap = null;
  let pickMarker = null;
  let pickCircle = null;
  let pickRow = null;
  let pickPos = null;

  function setPick(lat, lng, msg) {
    const L = window.L;
    pickPos = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    const radius = Number(pickRow?.querySelector('[data-field="radius_m"]')?.value) || 100;
    if (!pickMarker) {
      pickMarker = L.marker([lat, lng], { draggable: true }).addTo(pickMap);
      pickMarker.on('dragend', () => { const p = pickMarker.getLatLng(); setPick(p.lat, p.lng); });
      pickCircle = L.circle([lat, lng], { radius, color: '#2f6fed', weight: 1, fillOpacity: 0.12 }).addTo(pickMap);
    } else {
      pickMarker.setLatLng([lat, lng]);
      pickCircle.setLatLng([lat, lng]);
      pickCircle.setRadius(radius);
    }
    const ok = inKorea(pickPos.lat, pickPos.lng);
    $('map-ok').disabled = !ok;
    $('map-info').className = ok ? 'msg ok' : 'msg err';
    $('map-info').textContent = ok
      ? `${msg ? `${msg} · ` : ''}선택한 위치: ${pickPos.lat}, ${pickPos.lng} · 파란 원(반경 ${radius}m) 안에서 출퇴근할 수 있습니다`
      : '한국 범위 밖입니다. 점포 위치를 다시 선택하세요.';
  }

  async function centerOnAddress(addr) {
    $('map-info').className = 'msg';
    $('map-info').textContent = '주소를 찾는 중...';
    try {
      const g = await geocode(addr);
      if (!g) {
        $('map-info').className = 'msg err';
        $('map-info').textContent = '주소를 찾지 못했습니다. 지도를 움직여 점포 건물을 직접 클릭하세요.';
        return;
      }
      pickMap.setView([g.lat, g.lng], g.precise ? 18 : 16);
      setPick(g.lat, g.lng, g.precise ? `찾음: ${g.label}` : `⚠️ 건물이 아닌 "${g.label}" 근처입니다. 실제 건물을 클릭해 핀을 옮겨 주세요`);
    } catch (err) {
      $('map-info').className = 'msg err';
      $('map-info').textContent = `주소 검색을 할 수 없습니다 (${err.message}). 지도를 움직여 직접 클릭하세요.`;
    }
  }

  async function openMapPicker(tr, firstMsg) {
    try { await loadLeaflet(); } catch (err) { return alert(err.message); }
    const L = window.L;
    pickRow = tr;
    pickPos = null;
    $('map-title').textContent = `${tr.querySelector('[data-field="name"]').value || '점포'} 위치 선택`;
    $('map-addr').value = tr.querySelector('[data-field="address"]').value.trim();
    $('map-ok').disabled = true;
    $('map-info').className = 'muted small';
    $('map-info').textContent = '지도에서 점포 건물을 클릭하세요. 핀은 끌어서 옮길 수 있습니다.';
    $('map-dialog').showModal();
    if (!pickMap) {
      pickMap = L.map('map-box');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
      }).addTo(pickMap);
      pickMap.on('click', (ev) => setPick(ev.latlng.lat, ev.latlng.lng));
    }
    if (pickMarker) { pickMap.removeLayer(pickMarker); pickMap.removeLayer(pickCircle); pickMarker = null; pickCircle = null; }
    setTimeout(() => pickMap.invalidateSize(), 50);

    let cur = null;
    try { cur = parseCoords(tr.querySelector('[data-field="coords"]').value); } catch (_) { cur = null; }
    if (cur) {
      pickMap.setView([cur.lat, cur.lng], firstMsg ? 17 : 18);
      setPick(cur.lat, cur.lng, firstMsg || '현재 입력된 위치');
    } else if ($('map-addr').value) {
      pickMap.setView([36.4, 127.8], 7);
      centerOnAddress($('map-addr').value);
    } else {
      pickMap.setView([36.4, 127.8], 7); // 대한민국 전체
    }
  }

  $('map-search').addEventListener('click', () => {
    const addr = $('map-addr').value.trim();
    if (addr) centerOnAddress(addr);
  });
  $('map-addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('map-search').click(); }
  });
  $('map-cancel').addEventListener('click', () => $('map-dialog').close());
  $('map-ok').addEventListener('click', () => {
    if (!pickRow || !pickPos) return;
    pickRow.querySelector('[data-field="coords"]').value = `${pickPos.lat}, ${pickPos.lng}`;
    const addrInput = pickRow.querySelector('[data-field="address"]');
    if (!addrInput.value.trim() && $('map-addr').value.trim()) addrInput.value = $('map-addr').value.trim();
    const note = pickRow.querySelector('[data-field="note"]');
    note.className = 'loc-note on';
    note.textContent = '지도에서 선택함 → [저장]을 눌러야 반영됩니다';
    $('map-dialog').close();
  });

  // 지도에서 복사한 좌표 문자열 → { lat, lng } (빈 값이면 null = 위치 해제)
  //  "37.5665, 126.9780" / "37.5665° N, 126.9780° E" / 위도·경도 순서가 바뀐 경우도 처리
  function parseCoords(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const nums = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length !== 2) throw new Error('좌표는 "37.5665, 126.9780"처럼 숫자 두 개로 입력하세요.');
    let [lat, lng] = nums;
    if (lat >= 124 && lat <= 132 && lng >= 33 && lng <= 39) [lat, lng] = [lng, lat]; // 순서 바뀜 보정
    if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) {
      throw new Error('한국 범위의 좌표가 아닙니다. 구글 지도에서 복사한 값인지 확인하세요.');
    }
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }

  // ---- 특정일 근무시간 (매니저: 점포 표의 '정규 근무시간' 칸에서 등록·삭제) ----
  // 점포 칸 아래 표시: 오늘 이후 등록된 날짜 (많으면 5개까지 + 외 N건)
  function specialChips(branchId) {
    const today = ymd(new Date());
    const list = [...specialHours.values()].filter((h) => h.branch_id === branchId && h.work_date >= today)
      .sort((a, b) => a.work_date.localeCompare(b.work_date));
    const shown = list.slice(0, 5).map((h) => `<span class="sh-chip" title="${esc(h.note || '')}">
        ${dateLabel(h.work_date)} ${tmLabel(h.work_start)}~${tmLabel(h.work_end)}${h.note ? ` · ${esc(h.note)}` : ''}
        <button type="button" class="sh-x" data-sh-del="${h.id}" title="삭제" aria-label="삭제">✕</button></span>`).join('');
    return shown + (list.length > 5 ? `<span class="muted small">외 ${list.length - 5}건</span>` : '');
  }
  let shBranch = null;
  function openSpecialDialog(b) {
    shBranch = b;
    $('sh-title').textContent = `특정일 근무시간 - ${b.name}`;
    $('sh-usual').textContent = `평소 근무시간 ${tmLabel(b.work_start) || '09:00'} ~ ${tmLabel(b.work_end) || '18:00'}`;
    $('sh-date').value = ymd(new Date());
    $('sh-start').value = '14:00';
    $('sh-end').value = tmLabel(b.work_end) || '18:00';
    $('sh-note').value = '';
    showError($('sh-error'), '');
    $('sh-dialog').showModal();
  }
  $('sh-cancel').addEventListener('click', () => $('sh-dialog').close());
  $('sh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!shBranch) return;
    const row = {
      branch_id: shBranch.id,
      work_date: $('sh-date').value,
      work_start: $('sh-start').value,
      work_end: $('sh-end').value,
      note: $('sh-note').value.trim() || null,
    };
    if (!row.work_date) return showError($('sh-error'), '날짜를 선택하세요.');
    if (row.work_end <= row.work_start) return showError($('sh-error'), '종료 시각이 시작 시각보다 늦어야 합니다.');
    const btn = e.submitter; btn.disabled = true;
    const { error } = await sb.from('branch_special_hours').upsert(row, { onConflict: 'branch_id,work_date' });
    btn.disabled = false;
    if (error) return showError($('sh-error'), errMsg(error));
    $('sh-dialog').close();
    await loadSpecialHours();
    renderBranches();
  });
  async function deleteSpecial(id) {
    const h = [...specialHours.values()].find((x) => x.id === id);
    if (!h || !confirm(`${branchName(h.branch_id)} ${dateLabel(h.work_date)}의 특정일 근무시간(${tmLabel(h.work_start)}~${tmLabel(h.work_end)})을 삭제할까요?\n삭제하면 그날은 평소 근무시간으로 계산됩니다.`)) return;
    const { error } = await sb.from('branch_special_hours').delete().eq('id', id);
    if (error) return alert(errMsg(error));
    await loadSpecialHours();
    renderBranches();
  }

  function renderBranches() {
    $('branch-list').innerHTML = branches.map((b) => `
      <tr data-id="${b.id}">
        <td><input type="text" value="${esc(b.name)}" maxlength="30" data-field="name"></td>
        <td class="hours-cell">
          <input type="time" class="time-input" value="${tmLabel(b.work_start) || '09:00'}" data-field="work_start"> ~
          <input type="time" class="time-input" value="${tmLabel(b.work_end) || '18:00'}" data-field="work_end">
          <div class="sh-chips">${specialChips(b.id)}<button type="button" class="btn small sh-add" data-sh-add>+ 특정일</button></div>
        </td>
        <td class="loc-cell">
          <div class="addr-row">
            <input type="text" class="addr-input" value="${esc(b.address || '')}" data-field="address" placeholder="도로명 주소 입력">
            <button type="button" class="btn small" data-bgeo>주소로 찾기</button>
          </div>
          <input type="text" class="coord-input" value="${esc(coordText(b))}" data-field="coords" placeholder="위도, 경도 (자동 입력 또는 붙여넣기)">
          <span class="loc-note ${hasLoc(b) ? 'on' : 'off'}" data-field="note">${hasLoc(b) ? 'GPS 확인 사용 중' : '미설정 · 위치 확인 안 함'}</span>
        </td>
        <td><input type="number" class="radius-input" value="${b.radius_m ?? 100}" min="30" max="2000" step="10" data-field="radius_m"> m</td>
        <td class="num">${staff.filter((s) => s.branch_id === b.id && !s.deleted_at).length}명</td>
        <td><input type="checkbox" data-field="is_active" ${b.is_active ? 'checked' : ''}></td>
        <td class="actions">
          <button class="btn small" data-bsave>저장</button>
          <button class="btn small" data-bpick>지도에서 선택</button>
          <button class="btn small" data-bdel>삭제</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">등록된 점포가 없습니다. 위에서 점포를 추가하세요.</td></tr>';
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
    if (e.target.matches('[data-sh-add]')) {
      const b = branches.find((x) => x.id === id);
      if (b) openSpecialDialog(b);
      return;
    }
    if (e.target.matches('[data-sh-del]')) return deleteSpecial(Number(e.target.dataset.shDel));
    if (e.target.matches('[data-bsave]')) {
      const name = tr.querySelector('[data-field="name"]').value.trim();
      if (!name) return alert('점포 이름을 입력하세요.');
      let loc;
      try { loc = parseCoords(tr.querySelector('[data-field="coords"]').value); } catch (err) { return alert(err.message); }
      const radius = Number(tr.querySelector('[data-field="radius_m"]').value);
      if (!Number.isInteger(radius) || radius < 30 || radius > 2000) return alert('허용 반경은 30~2000m 사이의 정수로 입력하세요.');
      const workStart = tr.querySelector('[data-field="work_start"]').value;
      const workEnd = tr.querySelector('[data-field="work_end"]').value;
      if (!workStart || !workEnd) return alert('정규 출근·퇴근 시간을 입력하세요.');
      if (workEnd <= workStart) return alert('정규 퇴근시간은 출근시간보다 늦어야 합니다.');
      const update = {
        name,
        is_active: tr.querySelector('[data-field="is_active"]').checked,
        lat: loc ? loc.lat : null,
        lng: loc ? loc.lng : null,
        radius_m: radius,
        address: tr.querySelector('[data-field="address"]').value.trim() || null,
        work_start: workStart,
        work_end: workEnd,
      };
      e.target.disabled = true;
      const { error } = await sb.from('branches').update(update).eq('id', id);
      e.target.disabled = false;
      if (error) return alert(errMsg(error));
      await loadBranches();
      renderBranches();
      if (me.branch_id === id) {
        me.branch = { name, lat: update.lat, lng: update.lng, radius_m: radius, work_start: workStart, work_end: workEnd };
        setUserLabel();
        startGps();
        setupOvertimeForm();
      }
    } else if (e.target.matches('[data-bgeo]')) {
      // 주소 → 좌표 (OpenStreetMap 무료 검색, 키 불필요). 저장은 [저장]을 눌러야 반영
      const addr = tr.querySelector('[data-field="address"]').value.trim();
      const note = tr.querySelector('[data-field="note"]');
      if (!addr) return alert('주소를 입력하세요.');
      e.target.disabled = true;
      note.className = 'loc-note'; note.textContent = '주소를 찾는 중...';
      try {
        const g = await geocode(addr);
        if (!g) {
          note.className = 'loc-note off';
          note.textContent = '⚠️ 주소를 찾지 못했습니다. [지도에서 선택]으로 점포 건물을 직접 찍어 주세요.';
          return;
        }
        tr.querySelector('[data-field="coords"]').value = `${g.lat}, ${g.lng}`;
        if (g.precise) {
          note.className = 'loc-note on';
          note.textContent = `찾음: ${g.label} → [지도에서 선택]으로 확인 후 [저장]`;
        } else {
          // 건물이 아니라 도로·지역 위치로만 잡힘 → 지도에서 직접 찍도록 바로 열어 줌
          note.className = 'loc-note off';
          note.textContent = `⚠️ 정확한 건물을 찾지 못해 "${g.label}" 근처로 잡았습니다. 지도에서 건물을 직접 찍어 주세요.`;
          openMapPicker(tr, `⚠️ 건물이 아닌 "${g.label}" 근처입니다. 실제 건물을 클릭해 핀을 옮겨 주세요`);
        }
      } catch (err) {
        note.className = 'loc-note off';
        note.textContent = `주소 검색을 할 수 없습니다 (${err.message}). [지도에서 선택]으로 직접 찍어 주세요.`;
      } finally {
        e.target.disabled = false;
      }
    } else if (e.target.matches('[data-bpick]')) {
      openMapPicker(tr);
    } else if (e.target.matches('[data-bdel]')) {
      if (!confirm(`'${branchName(id)}' 점포를 삭제하시겠습니까?`)) return;
      const { error } = await sb.from('branches').delete().eq('id', id);
      if (error) return alert(errMsg(error));
      await loadBranches();
      renderBranches();
    }
  });

  // ---------------------------------------------------------------
  //  홈 화면 바로가기 추가 안내 (휴대폰 종류별 그림 단계)
  //  ※ 휴대폰 운영체제가 막아 두어 자동 추가는 불가 → 누를 곳을 그림으로 안내
  // ---------------------------------------------------------------
  const UA = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(UA);
  const inAppName = /KAKAOTALK/i.test(UA) ? '카카오톡' : /NAVER/i.test(UA) ? '네이버' : /Instagram/i.test(UA) ? '인스타그램'
    : /FBAN|FBAV/i.test(UA) ? '페이스북' : /Line\//i.test(UA) ? '라인' : /DaumApps/i.test(UA) ? '다음' : '';
  const isStandalone = window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;

  // 그림(SVG) 공통 조각
  const SVG = (h, body) => `<svg viewBox="0 0 320 ${h}" xmlns="http://www.w3.org/2000/svg" font-family="inherit" role="img">${body}</svg>`;
  const ring = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e0443e" stroke-width="3"/>`;
  const arrowDown = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 8}" stroke="#e0443e" stroke-width="3"/><polygon points="${x - 7},${y2 - 10} ${x + 7},${y2 - 10} ${x},${y2}" fill="#e0443e"/>`;
  const arrowUp = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 + 8}" stroke="#e0443e" stroke-width="3"/><polygon points="${x - 7},${y2 + 10} ${x + 7},${y2 + 10} ${x},${y2}" fill="#e0443e"/>`;
  const greyRow = (y, w = 150) => `<rect x="24" y="${y}" width="272" height="30" rx="6" fill="#fff"/><rect x="36" y="${y + 11}" width="${w}" height="8" rx="4" fill="#d1d1d6"/>`;
  const hiRow = (y, label, icon) => `<rect x="24" y="${y}" width="272" height="34" rx="6" fill="#fff1f0" stroke="#e0443e" stroke-width="2"/>
    <text x="36" y="${y + 22}" font-size="14" font-weight="700" fill="#111">${label}</text>
    <text x="284" y="${y + 23}" font-size="16" text-anchor="end" fill="#111">${icon}</text>`;
  const iconPreview = (y) => `<rect x="128" y="${y}" width="64" height="64" rx="14" fill="#fff" stroke="#d1d1d6"/>
    <image href="icons/icon-192.png" x="132" y="${y + 4}" width="56" height="56"/>
    <text x="160" y="${y + 82}" font-size="12" text-anchor="middle" fill="#333">아데코 근태</text>`;

  const STEPS = {
    // 아이폰 사파리 — 최신 iOS(26) 기본 화면 기준: 맨 아래 [<] [☰ 주소 ↻] [⧉]
    ios: [
      {
        text: 'Safari 화면 <b>맨 아래 주소창 왼쪽</b>의 <b>☰</b> 버튼을 누르세요',
        sub: '기기에 따라 이 버튼이 <b>⋯</b> 모양일 수 있어요. 아래 막대가 안 보이면 화면을 살짝 아래로 내렸다 올려 주세요.',
        svg: SVG(100, `<rect width="320" height="100" rx="12" fill="#f2f2f7"/>
          <text x="16" y="22" font-size="11" fill="#8e8e93">휴대폰 화면 맨 아래</text>
          <circle cx="32" cy="64" r="20" fill="#fff" stroke="#d1d1d6"/>
          <text x="32" y="70" font-size="18" text-anchor="middle" fill="#111">‹</text>
          <rect x="60" y="44" width="200" height="40" rx="20" fill="#fff" stroke="#d1d1d6"/>
          <text x="84" y="70" font-size="18" text-anchor="middle" fill="#111">☰</text>
          <text x="168" y="69" font-size="13" text-anchor="middle" fill="#333">…tendance.github.io</text>
          <text x="242" y="70" font-size="16" text-anchor="middle" fill="#111">↻</text>
          <circle cx="290" cy="64" r="20" fill="#fff" stroke="#d1d1d6"/>
          <text x="290" y="70" font-size="16" text-anchor="middle" fill="#111">⧉</text>
          ${ring(84, 64, 17)}${arrowDown(84, 6, 44)}`),
      },
      {
        text: '메뉴에서 <b>공유</b>를 누르세요',
        svg: SVG(120, `<rect width="320" height="120" rx="12" fill="#f2f2f7"/>
          ${greyRow(14, 120)}${hiRow(48, '공유', '□↑')}${greyRow(86, 160)}`),
      },
      {
        text: '목록을 <b>아래로 내려서</b> <b>홈 화면에 추가</b>를 누르세요',
        sub: '처음에는 "복사" 같은 항목만 보여요. 손가락으로 목록을 위로 밀어 아래쪽을 보세요. 끝까지 내려도 없으면 맨 아래 <b>작업 편집</b>을 눌러 "홈 화면에 추가" 옆 <b>+</b>를 눌러 주세요.',
        svg: SVG(170, `<rect width="320" height="170" rx="12" fill="#f2f2f7"/>
          <circle cx="50" cy="26" r="14" fill="#d1d1d6"/><circle cx="100" cy="26" r="14" fill="#d1d1d6"/><circle cx="150" cy="26" r="14" fill="#d1d1d6"/><circle cx="200" cy="26" r="14" fill="#d1d1d6"/>
          ${greyRow(52, 90)}${greyRow(86, 140)}${hiRow(124, '홈 화면에 추가', '⊞')}
          <text x="300" y="104" font-size="11" text-anchor="end" fill="#e0443e">↓ 아래로 내리기</text>`),
      },
      {
        text: '<b>웹 앱으로 열기</b>가 켜진 채로 오른쪽 위 <b>추가</b>를 누르면 끝!',
        sub: '홈 화면에 "아데코 근태" 아이콘이 생기고, 누르면 앱처럼 바로 열립니다.',
        svg: SVG(196, `<rect width="320" height="196" rx="12" fill="#f2f2f7"/>
          <text x="20" y="28" font-size="14" fill="#007aff">취소</text>
          <text x="160" y="28" font-size="14" font-weight="700" text-anchor="middle" fill="#111">홈 화면에 추가</text>
          <text x="296" y="28" font-size="14" font-weight="700" text-anchor="end" fill="#007aff">추가</text>
          ${ring(282, 23, 22)}${iconPreview(46)}
          <rect x="24" y="146" width="272" height="36" rx="8" fill="#fff"/>
          <text x="38" y="169" font-size="13" fill="#111">웹 앱으로 열기</text>
          <rect x="246" y="153" width="40" height="22" rx="11" fill="#34c759"/><circle cx="275" cy="164" r="9" fill="#fff"/>`),
      },
    ],
    // 안드로이드 크롬
    android: [
      {
        text: '크롬 화면 <b>오른쪽 위</b>의 <b>⋮</b> 버튼을 누르세요',
        svg: SVG(90, `<rect width="320" height="90" rx="12" fill="#f2f2f7"/>
          <text x="16" y="20" font-size="11" fill="#8e8e93">휴대폰 화면 맨 위</text>
          <rect x="12" y="30" width="240" height="38" rx="19" fill="#fff" stroke="#d1d1d6"/>
          <text x="132" y="54" font-size="13" text-anchor="middle" fill="#333">adecco-attendance.github.io</text>
          <text x="288" y="58" font-size="22" font-weight="700" text-anchor="middle" fill="#111">⋮</text>
          ${ring(288, 50, 20)}${arrowUp(288, 88, 74)}`),
      },
      {
        text: '메뉴에서 <b>홈 화면에 추가</b>를 누르세요',
        sub: '메뉴 이름이 기종에 따라 "홈 화면에 추가" 또는 "바로가기 추가"로 보일 수 있어요.',
        svg: SVG(130, `<rect width="320" height="130" rx="12" fill="#f2f2f7"/>
          ${greyRow(12, 110)}${greyRow(46, 140)}${hiRow(82, '홈 화면에 추가', '⊞')}`),
      },
      {
        text: '<b>추가</b>를 누르면 끝!',
        sub: '"자동으로 추가" / "홈 화면에 추가"를 한 번 더 물으면 그것도 눌러 주세요.',
        svg: SVG(150, `<rect width="320" height="150" rx="12" fill="#f2f2f7"/>
          ${iconPreview(14)}
          <text x="200" y="134" font-size="14" fill="#1a73e8">취소</text>
          <text x="282" y="134" font-size="14" font-weight="700" text-anchor="middle" fill="#1a73e8">추가</text>
          ${ring(282, 129, 22)}`),
      },
    ],
  };

  function renderA2hs(os) {
    document.querySelectorAll('#a2hs-dialog [data-os]').forEach((b) => b.classList.toggle('active', b.dataset.os === os));
    let html = '';
    if (inAppName) {
      html += `<div class="a2hs-step a2hs-warn">
        <p>⚠️ 지금 <b>${inAppName} 앱 안</b>에서 열려 있어요. 여기서는 홈 화면에 추가할 수 없습니다.</p>
        <p class="sub">${os === 'ios'
          ? '오른쪽 아래(또는 위) <b>⋯</b> 버튼 → <b>Safari로 열기</b>를 누른 뒤, 열린 Safari에서 이 버튼을 다시 눌러 주세요.'
          : '오른쪽 위(또는 아래) <b>⋮</b> 버튼 → <b>다른 브라우저로 열기</b>(크롬)를 누른 뒤, 크롬에서 이 버튼을 다시 눌러 주세요.'}</p>
      </div>`;
    }
    html += STEPS[os].map((s, i) => `
      <div class="a2hs-step">
        <p><span class="a2hs-num">${i + 1}</span>${s.text}</p>
        ${s.svg}
        ${s.sub ? `<p class="sub">${s.sub}</p>` : ''}
      </div>`).join('');
    $('a2hs-steps').innerHTML = html;
  }

  document.querySelectorAll('.a2hs-open').forEach((btn) => {
    if (isStandalone) btn.hidden = true; // 이미 홈 화면 아이콘으로 연 경우
    btn.addEventListener('click', () => {
      renderA2hs(isAndroid ? 'android' : 'ios');
      $('a2hs-dialog').showModal();
      $('a2hs-steps').scrollTop = 0;
    });
  });
  document.querySelectorAll('#a2hs-dialog [data-os]').forEach((b) => b.addEventListener('click', () => renderA2hs(b.dataset.os)));
  $('a2hs-close').addEventListener('click', () => $('a2hs-dialog').close());

  // ---------------------------------------------------------------
  //  시작
  // ---------------------------------------------------------------
  (async () => {
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) enterApp(data.session.user);
    else showView('login');
  })();
})();
