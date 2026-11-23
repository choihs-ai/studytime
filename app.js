'use strict';

const KEY = 'sungong.v1';
const CUTOFF_H = 0;            // 날짜는 자정에 바뀐다. 세션은 시작한 날에 통째로 들어간다
const AWAY_MIN_MS = 3000;      // 이보다 짧게 나갔다 오면 묻지 않는다
const SUBJECT_PRESET = ['국어', '수학', '영어', '한국사', '통합사회', '통합과학', '물리학', '화학', '생명과학', '지구과학'];
const REASONS = [
  ['kakao', '카톡·메시지'], ['youtube', '유튜브'], ['insta', '인스타'],
  ['game', '게임'], ['study', '공부 관련'], ['etc', '기타'],
];
const REASON_NAME = Object.fromEntries(REASONS);
const GRADES = ['고1', '고2', '고3'];
const LOCK_APP_URL = 'https://apps.apple.com/kr/app/id6504188981';
const WD = ['일', '월', '화', '수', '목', '금', '토'];

/* ---------- 시간·날짜 ---------- */

const pad = n => String(n).padStart(2, '0');
const keyOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const dayKey = (ts = Date.now()) => keyOf(new Date(ts - CUTOFF_H * 3600000));
const dayStart = k => { const d = parseKey(k); d.setHours(CUTOFF_H); return d.getTime(); };
const shiftKey = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };

/* ---------- 저장 ---------- */

function blank() {
  return {
    settings: {
      grade: '고2', subjects: ['국어', '수학', '영어'], goalMin: 360,
      examName: '', examDate: '', nickname: '', showNick: true, onboarded: false, drowsy: false, phoneStop: true,
    },
    sessions: [], closed: {}, active: null, lastSubject: null, mode: 'flip', camIntroSeen: false,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const b = blank();
      return migrate({ ...b, ...d, settings: { ...b.settings, ...(d.settings || {}) } });
    }
  } catch (e) { /* 읽기 실패하면 새로 시작 */ }
  return blank();
}

// 세션 날짜를 시작 시각 기준으로 다시 계산한다. 하루 기준이 바뀌어도 기록이 맞게 붙는다.
// 마감 표시는 세션이 하나도 남지 않은 날에서만 지운다.
function migrate(d) {
  if (!Array.isArray(d.sessions)) d.sessions = [];
  for (const s of d.sessions) if (s && s.start) s.day = dayKey(s.start);
  const days = new Set(d.sessions.map(s => s.day));
  const closed = {};
  for (const k of Object.keys(d.closed || {})) if (d.closed[k] && days.has(k)) closed[k] = true;
  d.closed = closed;
  return d;
}

let db = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('기록을 저장하지 못했어요. 폰 저장 공간을 확인해 주세요.'); }
}


function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 3600) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
}
function hm(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return Math.floor(m / 60) + ':' + pad(m % 60);
}
function dur(ms) {
  if (ms < 60000) return (ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0) + '초';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + '분';
  const h = Math.floor(m / 60), r = m % 60;
  return h + '시간' + (r ? ' ' + r + '분' : '');
}
const clock = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dateLabel = k => { const d = parseKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ddayText(k = dayKey()) {
  const s = db.settings;
  if (!s.examDate) return '';
  const n = Math.round((parseKey(s.examDate) - parseKey(k)) / 86400000);
  const name = s.examName || '시험';
  if (n > 0) return `${name} D-${n}`;
  if (n === 0) return `${name} D-DAY`;
  return '';
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/* ---------- 통계 ---------- */

function dayStats(k) {
  const list = db.sessions.filter(s => s.day === k);
  const st = { study: 0, brk: 0, up: 0, upCount: 0, awayCount: 0, awayMs: 0, bySubject: {}, list,
    absentCount: 0, absentMs: 0, drowsyCount: 0, drowsyMs: 0, camStudy: 0, cam: false };
  for (const s of list) {
    st.study += s.study; st.brk += s.brk; st.up += s.up; st.upCount += s.upCount;
    if (s.mode === 'camera') {
      st.cam = true; st.camStudy += s.study;
      st.absentCount += s.absentCount || 0; st.absentMs += s.absentMs || 0;
      st.drowsyCount += s.drowsyCount || 0; st.drowsyMs += s.drowsyMs || 0;
    }
    for (const a of s.away) { st.awayCount++; st.awayMs += a.ms; }
    st.bySubject[s.subject] = (st.bySubject[s.subject] || 0) + s.study;
  }
  return st;
}

// 마감할 날: 오늘 기록이 없고 마지막 세션이 어제 것이면 어제를 마감한다.
// 밤 11시에 시작해서 0시 반에 끝낸 날도 카드가 비지 않게 하려는 것.
function closeKey() {
  const k = dayKey();
  if (db.sessions.some(s => s.day === k)) return k;
  let last = null;
  for (const s of db.sessions) if (!last || s.start > last.start) last = s;
  const y = shiftKey(k, -1);
  return last && last.day === y ? y : k;
}

function currentSubject() {
  const s = db.settings.subjects;
  return s.includes(db.lastSubject) ? db.lastSubject : s[0];
}

/* ---------- 동작 센서: 폰이 엎어져 있는지 ---------- */

const sensor = { mode: 'unknown', faceDown: false, lastEvent: 0, listening: false };
// mode: unknown(권한 아직) · pending(확인 중) · on · off(센서 없음/거부)

function onOrient(e) {
  if (e.beta == null) return;
  sensor.lastEvent = Date.now();
  if (db.active && db.active.mode === 'camera') { sensor.mode = 'on'; cam.onOrient(e); return; }
  const b = Math.abs(e.beta), g = Math.abs(e.gamma || 0);
  // 엎을 때와 들 때 기준을 다르게 둬서 책상 진동에 깜빡이지 않게 한다
  const down = sensor.faceDown ? (b > 120 && g < 50) : (b > 150 && g < 35);
  const changed = down !== sensor.faceDown || sensor.mode !== 'on';
  sensor.faceDown = down;
  sensor.mode = 'on';
  if (changed) engine.refresh();
}

function requestSensor() {
  sensor.mode = 'pending';
  const D = window.DeviceOrientationEvent;
  if (!D) { sensor.mode = 'off'; return Promise.resolve(); }
  const attach = () => {
    if (!sensor.listening) { window.addEventListener('deviceorientation', onOrient); sensor.listening = true; }
    sensor.lastEvent = 0;
    setTimeout(() => {
      if (!sensor.lastEvent && sensor.mode === 'pending') { sensor.mode = 'off'; engine.refresh(); }
    }, 1500);
  };
  if (typeof D.requestPermission === 'function') {
    return D.requestPermission()
      .then(r => { if (r !== 'denied') attach(); else sensor.mode = 'off'; })   // 크롬은 'prompt'를 돌려주기도 한다
      .catch(() => { sensor.mode = 'off'; });
  }
  attach();
  return Promise.resolve();
}

/* ---------- 화면 꺼짐 방지 ---------- */

const wake = {
  lock: null,
  async on() {
    try {
      if ('wakeLock' in navigator && !document.hidden && db.active && !this.lock) {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => { this.lock = null; });
      }
    } catch (e) { this.lock = null; }
  },
  off() { try { if (this.lock) this.lock.release(); } catch (e) {} this.lock = null; },
};

/* ---------- 타이머 엔진 ---------- */

const engine = {
  timer: null, lastTick: 0,
  begin() { this.lastTick = Date.now(); this.loop(); wake.on(); },
  loop() { clearInterval(this.timer); this.timer = setInterval(() => this.tick(), 500); },
  stop() { clearInterval(this.timer); this.timer = null; wake.off(); },
  tick() {
    const a = db.active;
    if (!a) return;
    const now = Date.now();
    let dt = now - this.lastTick;
    this.lastTick = now;
    if (dt < 0 || dt > 3000) dt = 0;  // 앱이 멈춰 있던 동안은 아무 데도 넣지 않는다
    this.decide();
    if (a.state === 'counting') a.study += dt;
    else if (a.state === 'up') a.up += dt;
    else if (a.state === 'break') a.brk += dt;
    else if (a.state === 'absent') a.absentMs = (a.absentMs || 0) + dt;
    else if (a.state === 'drowsy') a.drowsyMs = (a.drowsyMs || 0) + dt;
    if (now - a.savedAt > 5000) { a.savedAt = now; save(); }
    updateTimer();
  },
  decide() {
    const a = db.active;
    if (!a || a.state === 'break') return;
    if (a.mode === 'camera') return cam.decide(a);
    const counting = sensor.mode === 'on' ? sensor.faceDown : sensor.mode === 'off';
    if (counting && a.state !== 'counting') { a.state = 'counting'; renderTimerState(); }
    else if (!counting && a.state === 'counting') { a.state = 'up'; a.upCount++; renderTimerState(); }
  },
  refresh() {
    if (!db.active || route !== 'timer') return;
    this.decide(); renderTimerState(); updateTimer();
  },
};

document.addEventListener('visibilitychange', () => {
  const a = db.active;
  if (!a) return;
  if (document.hidden) {
    engine.tick();
    a.awayAt = Date.now();
    if (a.mode === 'camera') cam.pause();
    save();
  } else {
    const now = Date.now();
    engine.lastTick = now;
    if (a.awayAt && now - a.awayAt >= AWAY_MIN_MS && a.state !== 'break') ui.awayPending = (ui.awayPending || 0) + (now - a.awayAt);
    a.awayAt = 0;
    save();
    wake.on();
    if (a.mode === 'camera') cam.wake();
    if (route === 'timer') render();
  }
});
window.addEventListener('pagehide', () => { if (db.active) { db.active.awayAt = db.active.awayAt || Date.now(); save(); } });

/* ---------- 화면 ---------- */

const app = document.getElementById('app');
let route = 'home';
const ui = {};
const VIEWS = {};
const AFTER = {};

function go(r) {
  if (r !== route) {
    ui.draft = null;
    ui.resetArm = false;
    if (r === 'records') ui.recKey = null;
    if (r === 'guide') ui.guideFrom = route;
    if (r !== 'share') ui.shareKey = null;
    if (r === 'camIntro') ui.camFrom = route;
    if (route === 'done') ui.lapse = null;
  }
  route = r;
  render();
  window.scrollTo(0, 0);
}

function render() {
  document.body.className = '';
  app.innerHTML = (VIEWS[route] || VIEWS.home)();
  if (AFTER[route]) AFTER[route]();
  cam.syncPreview();
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

function nav(on) {
  const tabs = [['home', '타이머'], ['records', '기록'], ['settings', '설정']];
  return `<nav class="tabs"><div>${tabs.map(([r, l]) => `<button data-act="go" data-arg="${r}" class="${on === r ? 'on' : ''}">${l}</button>`).join('')}</div></nav>`;
}

function draft() {
  if (!ui.draft) ui.draft = JSON.parse(JSON.stringify(db.settings));
  return ui.draft;
}

function settingsForm(d) {
  const all = [...new Set([...SUBJECT_PRESET, ...d.subjects])];
  return `
  <p class="label">학년</p>
  <div class="seg">${GRADES.map(g => `<button data-act="setGrade" data-arg="${g}" class="${d.grade === g ? 'on' : ''}">${g}</button>`).join('')}</div>
  <p class="label">공부할 과목 <span style="color:var(--ink)">${d.subjects.length}개 골랐어요</span></p>
  <div class="chips">${all.map(s => `<button class="chip pick ${d.subjects.includes(s) ? 'on' : ''}" data-act="toggleSubj" data-arg="${esc(s)}">${esc(s)}</button>`).join('')}</div>
  <div style="display:flex;gap:8px;margin-top:10px">
    <input class="field" id="newSubj" maxlength="10" placeholder="다른 과목 직접 입력" enterkeyhint="done">
    <button class="chip" style="flex:none" data-act="addSubj">추가</button>
  </div>
  <p class="label">하루 목표</p>
  <div class="stepper">
    <button aria-label="목표 줄이기" data-act="goal" data-arg="-30">−</button>
    <span>${hm(d.goalMin * 60000)}</span>
    <button aria-label="목표 늘리기" data-act="goal" data-arg="30">+</button>
  </div>
  <p class="label">다음 시험 <span class="muted">· 없으면 비워 두세요</span></p>
  <div style="display:flex;gap:8px">
    <input class="field" id="examName" maxlength="12" placeholder="기말고사" value="${esc(d.examName)}" aria-label="시험 이름">
    <input class="field" id="examDate" type="date" style="width:156px;flex:none" value="${esc(d.examDate)}" aria-label="시험 날짜">
  </div>`;
}

VIEWS.onboard = () => `
  <div class="screen">
    <span class="brand">엎어둬</span>
    <h1>몇 가지만 정하면<br>바로 시작해요</h1>
    ${settingsForm(draft())}
    <div style="margin-top:32px"><button class="btn dark" data-act="onboardNext">다음</button></div>
  </div>`;

VIEWS.guide = () => {
  const sa = standalone(), ios = isIOS();
  return `
  <div class="screen">
    <span class="brand">엎어둬</span>
    <h1>폰 유혹부터<br>막고 시작해요</h1>
    <p class="muted" style="font-size:15px;line-height:1.6;margin:12px 0 0">엎어둬는 시간만 재요. 다른 앱은 잠글시간으로 잠그고 엎어둬만 열어 두는 방식이에요.</p>
    <ol class="steps">
      <li class="${sa ? 'done' : ''}"><b>엎어둬를 홈 화면에 추가</b>
        <span class="how">${sa ? '완료했어요.' : ios ? '사파리 아래쪽 공유 버튼을 누르고 홈 화면에 추가를 고르세요.' : '크롬 오른쪽 위 메뉴에서 홈 화면에 추가를 고르세요.'}</span></li>
      <li><b>잠글시간 설치</b>
        <span class="how">${ios ? `<a href="${LOCK_APP_URL}" target="_blank" rel="noopener">앱스토어에서 받기</a>` : '갤럭시는 설정 → 디지털 웰빙 → 집중 모드를 써도 돼요.'}</span></li>
      <li><b>엎어둬만 빼고 잠그기</b>
        <span class="how">잠글시간에서 잠글 때 허용할 앱에 홈 화면의 '엎어둬'를 넣어 두세요.</span></li>
      <li><b>공부할 때마다</b>
        <span class="how">잠글시간으로 잠그기 → 엎어둬에서 시작 → 폰을 엎어 두기. 폰을 집으면 시간이 멈춰요.</span></li>
    </ol>
    <div style="margin-top:auto;padding-top:16px"><button class="btn dark" data-act="guideDone">알겠어요</button></div>
  </div>`;
};

VIEWS.camIntro = () => `
  <div class="screen">
    <span class="brand">엎어둬</span>
    <h1>세워 두고<br>얼굴로 재요</h1>
    <p class="muted" style="font-size:15px;line-height:1.6;margin:12px 0 0">전면 카메라에 얼굴이 보이는 시간만 순공으로 세요.</p>
    <ol class="steps">
      <li><b>거치대에 세워 두기</b>
        <span class="how">얼굴이 화면에 들어오게 폰을 세워 두세요. 20초 넘게 자리를 비우면 멈춰요.</span></li>
      <li><b>충전기 꽂기</b>
        <span class="how">카메라를 계속 켜 두니까 배터리가 빨리 닳아요. 충전기를 꽂아 두면 좋아요.</span></li>
      <li><b>영상은 폰 밖으로 안 나가요</b>
        <span class="how">얼굴이 있는지만 폰 안에서 확인해요. 어디로도 보내지 않아요.</span></li>
      <li><b>타임랩스</b>
        <span class="how">공부하는 동안 작은 사진을 폰에 모아요. 끝나면 영상으로 만들거나 바로 지울 수 있어요.</span></li>
    </ol>
    <div style="margin-top:auto;padding-top:16px;display:flex;flex-direction:column;gap:8px">
      <button class="btn dark" data-act="camIntroOk">세워 두기로 할게요</button>
      <button class="textbtn" style="align-self:center" data-act="camIntroNo">엎어 두기로 할게요</button>
    </div>
  </div>`;

VIEWS.home = () => {
  const k = dayKey(), st = dayStats(k), s = db.settings;
  const goal = s.goalMin * 60000;
  const pct = Math.min(100, Math.round(st.study / goal * 100));
  const subj = currentSubject();
  const rows = Object.entries(st.bySubject).sort((a, b) => b[1] - a[1]);
  const dd = ddayText();
  const ck = closeKey(), closed = !!db.closed[ck];
  const dayWord = ck === k ? '오늘' : '어제';
  return `
  <div class="screen with-nav">
    <div class="row"><span class="brand">엎어둬</span><span class="date">${dateLabel(k)}${dd ? ` · <span class="mark">${esc(dd)}</span>` : ''}</span></div>
    ${standalone() ? '' : `<button class="banner" data-act="go" data-arg="guide">홈 화면에 추가해야 잠글시간에서 엎어둬만 뺄 수 있어요. 방법 보기</button>`}
    <p class="label" style="margin-top:32px">오늘 순공</p>
    <div class="big">${hms(st.study)}</div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="bar-caption"><span>목표 ${dur(goal)} 중 ${pct}%</span><span>폰 든 횟수 ${st.upCount}</span></div>
    <p class="label">뭐 할래요?</p>
    <div class="chips">${s.subjects.map(x => `<button class="chip ${x === subj ? 'on' : ''}" data-act="pickSubj" data-arg="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <p class="label" style="margin:20px 0 8px">어떻게 잴까요?</p>
    <div class="seg small">
      <button data-act="pickMode" data-arg="flip" class="${db.mode !== 'camera' ? 'on' : ''}">엎어 두기</button>
      <button data-act="pickMode" data-arg="camera" class="${db.mode === 'camera' ? 'on' : ''}">세워 두기</button>
    </div>
    <button class="btn primary" style="margin-top:12px;height:64px;font-size:18px" data-act="start">${esc(subj)} 시작</button>
    ${ui.video ? `
      <p class="label">타임랩스</p>
      <p style="font-size:14px;margin:0;line-height:1.6">${dateLabel(ui.video.day)} ${esc(ui.video.subject || '')} 영상이 남아 있어요.</p>
      ${videoPick}` : ''}
    ${rows.length ? `
      <p class="label">오늘 한 것</p>
      <div class="list">${rows.map(([n, v]) => `<div><span>${esc(n)}</span><span class="mono">${hms(v)}</span></div>`).join('')}</div>` : ''}
    ${rows.length || ck !== k ? `
      <button class="btn ghost" style="margin-top:20px" data-act="${closed ? 'openShare' : 'closeDay'}">${closed ? `${dayWord} 카드 보기` : `${dayWord} 마감하고 카드 만들기`}</button>` : ''}
  </div>${nav('home')}`;
};

AFTER.home = () => {
  if (ui.video === undefined) loadVideo().then(() => { if (route === 'home' && ui.video) render(); });
};

VIEWS.timer = () => {
  if (!db.active) return VIEWS.home();
  document.body.className = 'in-timer';
  return `
  <div class="timer" id="timerWrap"><div class="screen">
    <div class="row"><span class="state" id="tState"></span>
      <span class="date" style="color:var(--night-muted)">오늘 <span class="mono" id="tToday" style="color:var(--paper)"></span></span></div>
    <div class="clock"><div class="big" id="tMain">0:00:00</div><p class="sub" id="tSub"></p></div>
    <div class="msg" id="tMsg"></div>
    <div class="actions" id="tActions"></div>
  </div></div>
  ${ui.awayPending ? `
  <div class="sheet-bg"><div class="sheet" role="dialog" aria-label="어디 갔다 왔는지 고르기">
    <h2>${dur(ui.awayPending)} 동안 어디 갔다 왔어요?</h2>
    <p>기록 탭의 이번 주 화면에서 어디서 시간이 새는지 모아서 보여 드려요.</p>
    <div class="grid">${REASONS.map(([k, l]) => `<button data-act="awayReason" data-arg="${k}">${l}</button>`).join('')}</div>
  </div></div>` : ''}`;
};
AFTER.timer = () => { renderTimerState(); updateTimer(); };

function renderTimerState() {
  const a = db.active, w = document.getElementById('timerWrap');
  if (!a || !w) return;
  if (a.mode === 'camera') return renderCamState(a, w);
  w.className = 'timer' + (a.state === 'counting' ? ' counting' : '') + (sensor.mode === 'off' ? ' nosensor' : '');
  const label = { waiting: '시작 대기', counting: `${a.subject} 공부 중`, up: '멈춤', break: '쉬는 중' }[a.state] || '';
  document.getElementById('tState').innerHTML = `<span class="dot"></span>${esc(label)}`;
  let msg;
  if (sensor.mode === 'unknown') msg = '앱을 다시 열었어요. 이어서 재려면 <b>계속하기</b>를 눌러 주세요.';
  else if (sensor.mode === 'pending') msg = '센서 확인 중이에요.';
  else if (a.state === 'break') msg = '쉬는 시간은 순공에 안 들어가요. 다 쉬면 <b>다시 공부</b>를 눌러요.';
  else if (sensor.mode === 'off') msg = '동작 센서를 못 써서 이 화면이 켜져 있는 동안만 재요. 다른 앱으로 나가면 멈춰요.';
  else if (a.state === 'waiting') msg = '폰을 <b>화면이 바닥을 보게</b> 엎어 두면 시작돼요.';
  else if (a.state === 'up') msg = '폰을 들어서 멈췄어요. 다시 엎으면 이어서 재요.';
  else msg = '재는 중이에요. 폰은 그대로 두세요.';
  if (!('wakeLock' in navigator) && sensor.mode !== 'unknown') msg += '<br><span style="font-size:13px">화면이 꺼지면 멈춰요. 자동 잠금 시간을 길게 바꿔 두세요.</span>';
  document.getElementById('tMsg').innerHTML = msg;
  const end = `<button class="btn ${a.state === 'break' || sensor.mode === 'unknown' ? 'ghost' : 'primary'}" data-act="endSession">끝내기</button>`;
  document.getElementById('tActions').innerHTML =
    sensor.mode === 'unknown' ? end + `<button class="btn primary" data-act="resume">계속하기</button>`
    : a.state === 'break' ? end + `<button class="btn primary" data-act="unbreak">다시 공부</button>`
    : `<button class="btn ghost" data-act="breakOn">잠깐 쉬기</button>` + end;
}

function renderCamState(a, w) {
  w.className = 'timer cam' + (a.state === 'counting' ? ' counting' : '');
  const label = { waiting: '시작 대기', counting: `${a.subject} 공부 중`, up: '멈춤', absent: '자리 비움', drowsy: '졸음', break: '쉬는 중' }[a.state] || '';
  document.getElementById('tState').innerHTML = `<span class="dot"></span>${esc(label)}`;
  const st = cam.status;
  let msg;
  if (st === 'off') msg = '앱을 다시 열었어요. 이어서 재려면 <b>계속하기</b>를 눌러 주세요.';
  else if (st === 'starting') msg = '카메라를 켜는 중이에요.';
  else if (st === 'error') msg = (cam.errKind === 'model' ? '얼굴 인식을 불러오지 못했어요.' : cam.errKind === 'perm' ? '카메라 권한이 없어요.' : '카메라를 켜지 못했어요.')
    + ' <b>엎어 두기</b>로 바꿔서 재 주세요.';
  else if (a.state === 'break') msg = '쉬는 시간은 순공에 안 들어가요. 다 쉬면 <b>다시 공부</b>를 눌러요.';
  else if (a.state === 'up' && cam.phoneUse) msg = '다른 폰을 보고 있어서 멈췄어요. 폰을 치우거나 엎어 두면 이어서 재요.';
  else if (a.state === 'up') msg = '폰이 움직여서 멈췄어요. 다시 세워 두면 이어서 재요.';
  else if (a.state === 'absent') msg = '자리를 비워서 멈췄어요. 돌아오면 이어서 재요.';
  else if (a.state === 'drowsy') msg = '눈을 오래 감고 있어서 멈췄어요. 눈을 뜨면 이어서 재요.';
  else if (a.state === 'waiting') msg = '얼굴이 화면에 들어오게 폰을 <b>세워 두면</b> 시작돼요.';
  else msg = '재는 중이에요. 폰은 그대로 두세요.';
  if (!('wakeLock' in navigator) && st === 'on') msg += '<br><span style="font-size:13px">화면이 꺼지면 멈춰요. 자동 잠금 시간을 길게 바꿔 두세요.</span>';
  document.getElementById('tMsg').innerHTML = msg;
  const end = `<button class="btn ${a.state === 'break' || st === 'off' || st === 'error' ? 'ghost' : 'primary'}" data-act="endSession">끝내기</button>`;
  document.getElementById('tActions').innerHTML =
    st === 'off' ? end + `<button class="btn primary" data-act="resume">계속하기</button>`
    : st === 'error' ? end + `<button class="btn primary" data-act="toFlip">엎어 두기로 바꾸기</button>`
    : a.state === 'break' ? end + `<button class="btn primary" data-act="unbreak">다시 공부</button>`
    : `<button class="btn ghost" data-act="breakOn">잠깐 쉬기</button>` + end;
  cam.syncPreview();
}

function updateTimer() {
  const a = db.active, m = document.getElementById('tMain');
  if (!a || !m) return;
  m.textContent = hms(a.study);
  document.getElementById('tSub').textContent = `이번 세션 · 쉰 시간 ${hm(a.brk)} · 폰 든 횟수 ${a.upCount}`
    + (a.mode === 'camera' ? ` · 자리 비움 ${a.absentCount || 0}` + (a.drowsyCount ? ` · 졸음 ${a.drowsyCount}` : '') : '');
  document.getElementById('tToday').textContent = hms(dayStats(dayKey(a.start)).study + a.study);
}

VIEWS.done = () => {
  const s = db.sessions.find(x => x.id === ui.lastSession);
  if (!s) return VIEWS.home();
  const st = dayStats(s.day), goal = db.settings.goalMin * 60000, left = goal - st.study;
  const awayMs = s.away.reduce((t, a) => t + a.ms, 0);
  return `
  <div class="screen">
    <span class="date">${esc(s.subject)} · ${clock(s.start)} – ${clock(s.end)}</span>
    <div class="big" style="margin-top:10px">${hms(s.study)}</div>
    <p style="margin:10px 0 0;font-size:15px">이번 세션 순공</p>
    <div class="list" style="margin-top:28px;border-top:1.5px solid var(--ink);border-bottom:1.5px solid var(--ink)">
      <div><span>쉰 시간</span><span class="mono">${hms(s.brk)}</span></div>
      <div><span>폰 든 횟수</span><span class="mono">${s.upCount}번 · ${dur(s.up)}</span></div>
      ${s.mode === 'camera' ? `<div><span>자리 비움</span><span class="mono">${s.absentCount || 0}번 · ${dur(s.absentMs || 0)}</span></div>` : ''}
      ${s.drowsyCount ? `<div><span>졸음</span><span class="mono">${s.drowsyCount}번 · ${dur(s.drowsyMs || 0)}</span></div>` : ''}
      <div><span>앱 나간 횟수</span><span class="mono">${s.away.length}번 · ${dur(awayMs)}</span></div>
    </div>
    ${lapseBox(s)}
    ${s.sensor ? '' : '<p class="muted" style="font-size:13px;margin:10px 0 0">이번 세션은 센서 없이 화면이 켜진 시간으로 쟀어요.</p>'}
    <p class="label" style="margin-top:32px">오늘 순공</p>
    <div class="mono" style="font-size:36px;font-weight:500;letter-spacing:-.03em"><span class="mark" style="padding:0 6px">${hms(st.study)}</span></div>
    <p style="margin:10px 0 0;font-size:15px;line-height:1.6">${left > 0 ? `목표까지 <span class="mono">${hms(left)}</span> 남았어요.` : '오늘 목표를 채웠어요.'}</p>
    <div style="margin-top:auto;padding-top:28px;display:flex;flex-direction:column;gap:10px">
      <button class="btn primary" data-act="go" data-arg="home">이어서 공부하기</button>
      <button class="btn ghost" data-act="closeDay">${closeKey() === dayKey() ? '오늘' : '어제'} 마감하고 카드 만들기</button>
    </div>
  </div>`;
};

// 만든 영상은 IndexedDB에 하나만 남겨 둔다. 끝 화면을 나가도 홈에서 다시 저장하거나 지울 수 있다
function loadVideo() {
  if (!ui.videoLoading) ui.videoLoading = lapse.getVideo()
    .then(v => setVideo(v))
    .catch(() => setVideo(null))
    .finally(() => { ui.videoLoading = null; });
  return ui.videoLoading;
}
function setVideo(v) {
  if (ui.video && ui.video.url) URL.revokeObjectURL(ui.video.url);
  if (!v) { ui.video = null; return; }
  const blob = v.blob || new Blob([v.buf], { type: v.type || 'video/mp4' });
  ui.video = { sessionId: v.sessionId, day: v.day, subject: v.subject, ext: v.ext, blob, url: URL.createObjectURL(blob) };
}
const videoPick = `<div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn primary" data-act="lapseShare">저장하거나 공유하기</button>
      <button class="btn ghost" style="width:96px;flex:none;height:60px" data-act="videoDelete">지우기</button></div>`;

function lapseBox(s) {
  if (s.mode !== 'camera') return '';
  const L = ui.lapse || {};
  const V = ui.video && ui.video.sessionId === s.id ? ui.video : null;
  const pick = `<div style="display:flex;gap:8px">
      <button class="btn dark" data-act="lapseMake">타임랩스 만들기</button>
      <button class="btn ghost" style="width:96px;flex:none;height:60px" data-act="lapseDelete">지우기</button></div>`;
  let body;
  if (L.state === 'making') body = `<p style="font-size:15px;margin:0">영상 만드는 중 <span class="mono" id="lapsePct">${Math.round((L.pct || 0) * 100)}%</span></p>
      <p class="muted" style="font-size:13px;margin:6px 0 0">다 될 때까지 이 화면에 있어 주세요.</p>`;
  else if (V) body = `<video class="lapse-v" src="${V.url}" playsinline muted loop autoplay controls></video>${videoPick}
      <p class="muted" style="font-size:13px;margin:8px 0 0;line-height:1.6">지우기 전까지 홈에서도 다시 저장할 수 있어요.</p>`;
  else if (L.state === 'deleted') body = '<p class="muted" style="font-size:14px;margin:0">사진을 지웠어요.</p>';
  else if (L.state === 'videoDeleted') body = '<p class="muted" style="font-size:14px;margin:0">영상을 지웠어요.</p>';
  else if (L.state === 'few') body = '<p class="muted" style="font-size:14px;margin:0">사진이 적어서 타임랩스를 못 만들어요.</p>';
  else if (L.state === 'fail') body = `<p style="font-size:14px;margin:0 0 12px">영상을 만들지 못했어요. 다시 눌러 보세요.</p>${pick}`;
  else if (L.n == null) body = '<p class="muted" style="font-size:14px;margin:0">사진 확인 중</p>';
  else body = `<p style="font-size:14px;margin:0 0 12px;line-height:1.6">사진 ${L.n}장으로 ${Math.round(lapsePlan(L.n).T)}초쯤 되는 영상을 만들어요.</p>${pick}`;
  return `<p class="label">타임랩스</p><div>${body}</div>`;
}
AFTER.done = () => {
  const s = db.sessions.find(x => x.id === ui.lastSession);
  if (!s || s.mode !== 'camera' || ui.lapse) return;
  ui.lapse = {};
  loadVideo().then(() => lapse.count()).then(n => {
    if (ui.video && ui.video.sessionId === s.id) { if (route === 'done') render(); return; }
    if (!ui.lapse || ui.lapse.state) return;
    if (n < 8) { lapse.clear(); ui.lapse = { state: 'few' }; }
    else ui.lapse.n = n;
    if (route === 'done') render();
  }).catch(() => { ui.lapse = { state: 'few' }; if (route === 'done') render(); });
};

VIEWS.records = () => {
  const tab = ui.recTab || 'day';
  return `
  <div class="screen with-nav">
    <div class="row" style="align-items:center"><h2>기록</h2>
      <div class="seg" style="width:168px">
        <button data-act="recTab" data-arg="day" class="${tab === 'day' ? 'on' : ''}" style="height:36px;font-size:14px">하루</button>
        <button data-act="recTab" data-arg="week" class="${tab === 'week' ? 'on' : ''}" style="height:36px;font-size:14px">이번 주</button>
      </div>
    </div>
    ${tab === 'day' ? recDay() : recWeek()}
  </div>${nav('records')}`;
};

function recDay() {
  const today = dayKey(), k = ui.recKey || today, st = dayStats(k), ds = dayStart(k), DAY = 86400000;
  const blocks = st.list.map(s => {
    const l = Math.max(0, (s.start - ds) / DAY * 100);
    const w = Math.min(Math.max(0.5, (s.end - s.start) / DAY * 100), 100 - l);
    return `<i style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></i>`;
  }).join('');
  const subj = Object.entries(st.bySubject).sort((a, b) => b[1] - a[1]);
  const max = subj.length ? subj[0][1] : 1;
  const arrow = 'text-decoration:none;font-size:24px;width:44px;height:44px';
  return `
  <div class="row" style="margin-top:16px;align-items:center">
    <button class="textbtn" style="${arrow};text-align:left" aria-label="전날" data-act="recShift" data-arg="-1">‹</button>
    <span style="font-size:15px">${dateLabel(k)}</span>
    <button class="textbtn" style="${arrow};text-align:right" aria-label="다음 날" data-act="recShift" data-arg="1" ${k === today ? 'disabled' : ''}>›</button>
  </div>
  <div class="row" style="margin-top:4px"><span class="mono" style="font-size:40px;font-weight:500;letter-spacing:-.04em">${hms(st.study)}</span><span class="date">휴식 ${hm(st.brk)}</span></div>
  ${st.list.length ? `
    <p class="label">언제 했나</p>
    <div class="timeline">${blocks}</div>
    <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    <p class="label">과목별</p>
    ${subj.map(([n, v]) => `<div class="subj"><span>${esc(n)}</span><i style="width:${Math.max(4, v / max * 100).toFixed(0)}%"></i><span>${hms(v)}</span></div>`).join('')}
    <p class="label">세션</p>
    <div class="list">${st.list.slice().reverse().map(s => `
      <div><span><span class="mono" style="font-size:12px;color:var(--muted)">${clock(s.start)}–${clock(s.end)}</span>&nbsp; ${esc(s.subject)}<br>
        <span class="sub">폰 든 ${s.upCount}번${s.mode === 'camera' ? ` · 자리 비움 ${s.absentCount || 0}번${s.drowsyCount ? ` · 졸음 ${s.drowsyCount}번` : ''}` : ''} · 나간 ${s.away.length}번${s.sensor ? '' : ' · 화면 기준'}</span></span>
        <span class="mono">${hms(s.study)}</span></div>`).join('')}</div>`
  : `<p class="muted" style="margin-top:48px;text-align:center;font-size:15px">이날은 기록이 없어요.</p>`}`;
}

function recWeek() {
  const today = dayKey();
  const days = Array.from({ length: 7 }, (_, i) => shiftKey(today, i - 6));
  const stats = days.map(dayStats);
  const goal = db.settings.goalMin * 60000;
  const top = Math.max(goal, ...stats.map(s => s.study)) * 1.08;
  const total = stats.reduce((t, s) => t + s.study, 0);
  const studied = stats.filter(s => s.study > 0).length;
  const lure = {};
  let upCount = 0, absentCount = 0, hasCam = false;
  stats.forEach(s => {
    upCount += s.upCount; absentCount += s.absentCount; hasCam = hasCam || s.cam;
    s.list.forEach(x => x.away.forEach(a => {
      const r = lure[a.reason] || (lure[a.reason] = { ms: 0, n: 0 });
      r.ms += a.ms; r.n++;
    }));
  });
  const lr = Object.entries(lure).sort((a, b) => b[1].ms - a[1].ms);
  const lmax = lr.length ? lr[0][1].ms : 1;
  return `
  <div class="row" style="margin-top:24px"><span class="mono" style="font-size:40px;font-weight:500;letter-spacing:-.04em">${hm(total)}</span>
    <span class="date">${studied}일 공부 · 평균 ${hm(studied ? total / studied : 0)}</span></div>
  <p class="label">최근 7일</p>
  <div class="week"><div class="goal" style="bottom:${(goal / top * 100).toFixed(1)}%"></div>
    ${stats.map((s, i) => `<div class="col ${days[i] === today ? 'today' : ''}"><i style="height:${(s.study / top * 100).toFixed(1)}%"></i></div>`).join('')}</div>
  <div class="week-labels">${days.map(k => `<span>${WD[parseKey(k).getDay()]}</span>`).join('')}</div>
  <p class="muted" style="font-size:12px;margin:6px 0 0">빨간 점선이 하루 목표예요.</p>
  <p class="label">어디서 새나</p>
  ${lr.length
    ? `<div class="lure">${lr.map(([k, v]) => `<div><span>${esc(REASON_NAME[k] || '기타')}</span><i style="width:${Math.max(4, v.ms / lmax * 100).toFixed(0)}%"></i><span class="mono">${dur(v.ms)} · ${v.n}번</span></div>`).join('')}</div>`
    : `<p class="muted" style="font-size:14px;margin:0">이번 주는 공부하다 앱을 나간 적이 없어요.</p>`}
  <p style="font-size:14px;margin:16px 0 0">공부하다 폰을 든 횟수 <span class="mono">${upCount}번</span>${hasCam ? ` · 자리 비움 <span class="mono">${absentCount}번</span>` : ''}</p>`;
}

VIEWS.settings = () => {
  const d = draft();
  return `
  <div class="screen with-nav">
    <h2>설정</h2>
    ${settingsForm(d)}
    <p class="label">닉네임 <span class="muted">· 카드에만 보여요</span></p>
    <input class="field" id="nickname" maxlength="10" placeholder="예: 밤샘곰" value="${esc(d.nickname)}">
    <button class="btn dark" style="margin-top:24px" data-act="saveSettings">저장</button>
    <p class="label" style="margin-top:36px">유혹 막기</p>
    <button class="btn ghost" data-act="go" data-arg="guide">잠글시간 설정 방법 다시 보기</button>
    <p class="label">세워 두기</p>
    <div class="row" style="align-items:center;min-height:44px">
      <span style="font-size:15px">졸면 멈추기 <span class="muted" style="font-size:13px">· 실험 기능</span></span>
      <button class="switch ${db.settings.drowsy ? 'on' : ''}" aria-label="졸면 멈추기" aria-pressed="${!!db.settings.drowsy}" data-act="toggleDrowsy"><span></span></button>
    </div>
    <p class="muted" style="font-size:13px;margin:4px 0 12px;line-height:1.6">눈을 10초 넘게 감고 있으면 멈추고 졸음으로 따로 적어요. 고개를 숙이고 있을 때는 판정하지 않아요.</p>
    <div class="row" style="align-items:center;min-height:44px">
      <span style="font-size:15px">다른 폰 보면 멈추기</span>
      <button class="switch ${db.settings.phoneStop !== false ? 'on' : ''}" aria-label="다른 폰 보면 멈추기" aria-pressed="${db.settings.phoneStop !== false}" data-act="togglePhoneStop"><span></span></button>
    </div>
    <p class="muted" style="font-size:13px;margin:4px 0 12px;line-height:1.6">다른 폰을 집어 들면 멈추고 폰 든 횟수에 넣어요. 화면 밖으로 치우거나 엎어 두면 다시 재요. 시작할 때부터 책상에 놓여 있던 폰은 건드리기 전까지 세지 않아요. 태블릿으로 인강을 듣다가 자꾸 멈추면 꺼 두세요.</p>
    <button class="btn ghost" data-act="go" data-arg="camIntro">세워 두기 안내 다시 보기</button>
    <p class="label">기록</p>
    <button class="btn ghost danger" data-act="resetAll">${ui.resetArm ? '한 번 더 누르면 전부 지워져요' : '기록 전부 지우기'}</button>
    <p class="muted" style="font-size:12px;line-height:1.6;margin:16px 0 0">가입 없이 써요. 기록은 이 폰 안에만 저장되고 어디로도 보내지 않아요. 밤 12시를 넘겨도 끊지 않고 이어서 한 공부는 시작한 날로 쳐요.</p>
  </div>${nav('settings')}`;
};

const shareKey = () => ui.shareKey || closeKey();

VIEWS.share = () => {
  const k = shareKey();
  if (!db.closed[k]) return VIEWS.home();
  const s = db.settings;
  return `
  <div class="screen">
    <div class="row" style="align-items:center"><h2>${k === dayKey() ? '오늘' : '어제'} 카드</h2><button class="textbtn" data-act="reopen">마감 풀고 더 하기</button></div>
    <div class="preview" id="preview"><span class="muted" style="font-size:13px">만드는 중</span></div>
    <div class="row" style="align-items:center;margin-top:16px;min-height:44px">
      <span style="font-size:15px">닉네임 보이기</span>
      <button class="switch ${s.showNick ? 'on' : ''}" aria-label="닉네임 보이기" aria-pressed="${s.showNick}" data-act="toggleNick"><span></span></button>
    </div>
    ${s.showNick && !s.nickname ? '<p class="muted" style="font-size:13px;margin:0">닉네임은 설정에서 정할 수 있어요.</p>' : ''}
    <div style="margin-top:auto;padding-top:20px;display:flex;flex-direction:column;gap:8px">
      <button class="btn primary" data-act="shareCard">인스타 스토리에 올리기</button>
      <button class="btn ghost" data-act="copySticker">스티커로 복사</button>
      <p class="muted" style="font-size:12px;text-align:center;margin:4px 0 0;line-height:1.5">스티커는 배경이 투명해요. 스토리 사진 위에 붙여 넣으면 돼요.</p>
      <button class="textbtn" style="align-self:center" data-act="go" data-arg="home">홈으로</button>
    </div>
  </div>`;
};
AFTER.share = () => {
  ui.cardBlob = null;
  cardBlob(false).then(b => {
    ui.cardBlob = b;
    const box = document.getElementById('preview');
    if (!box) return;
    if (ui.cardUrl) URL.revokeObjectURL(ui.cardUrl);
    ui.cardUrl = URL.createObjectURL(b);
    box.innerHTML = `<img src="${ui.cardUrl}" alt="오늘 순공 영수증 카드">`;
  }).catch(() => toast('카드를 만들지 못했어요'));
};

/* ---------- 영수증 카드 ---------- */

function receiptLines(k) {
  const st = dayStats(k), s = db.settings;
  const goal = s.goalMin * 60000;
  const dayNo = new Set(db.sessions.filter(x => x.day <= k).map(x => x.day)).size;
  const d = parseKey(k);
  const who = s.showNick && s.nickname ? `${s.nickname} · ${s.grade}` : s.grade;
  const cut = t => t.length > 9 ? t.slice(0, 8) + '…' : t;
  const lines = [
    { t: 'title', l: '순공 영수증' },
    { l: `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${WD[d.getDay()]}`, r: 'No.' + String(dayNo).padStart(4, '0'), muted: true },
    { l: who, r: ddayText(k), muted: true },
    { t: 'dash' },
    ...Object.entries(st.bySubject).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([n, v]) => ({ l: cut(n), r: hms(v) })),
    { t: 'dash' },
    { l: '순공 합계', r: hms(st.study), bold: true, hl: true },
    ...(st.camStudy > 0 ? [{ l: '카메라로 잰 시간', r: hms(st.camStudy), muted: true }] : []),
    { l: '휴식', r: hms(st.brk), muted: true },
    { l: '폰 든 횟수', r: st.upCount + '번', muted: true },
    { l: '앱 나간 횟수', r: st.awayCount + '번', muted: true },
    { t: 'dash' },
    { l: `목표 ${hm(goal)}`, r: `${Math.round(st.study / goal * 100)}% 달성` },
    { t: 'barcode', seed: k },
  ];
  return lines;
}

const FONT_BODY = '400 40px "IBM Plex Mono", "IBM Plex Sans KR", monospace';
const FONT_BOLD = '600 40px "IBM Plex Mono", "IBM Plex Sans KR", monospace';
const FONT_TITLE = '700 62px "IBM Plex Sans KR", sans-serif';
const FONT_FOOT = '400 30px "IBM Plex Sans KR", sans-serif';
const FONT_LABEL = '400 40px "IBM Plex Sans KR", sans-serif';
const FONT_LABEL_BOLD = '600 40px "IBM Plex Sans KR", sans-serif';

async function fontsReady(text) {
  if (!document.fonts || !document.fonts.load) return;
  try {
    await Promise.race([
      Promise.all([FONT_BODY, FONT_BOLD, FONT_TITLE, FONT_FOOT, '400 40px "IBM Plex Sans KR"', '600 40px "IBM Plex Sans KR"']
        .map(f => document.fonts.load(f, text))),
      new Promise(r => setTimeout(r, 2500)),
    ]);
  } catch (e) { /* 글꼴이 없으면 기본 글꼴로 그린다 */ }
}

function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

async function drawCard(transparent) {
  const lines = receiptLines(shareKey());
  const foot = '엎어둬 · 폰을 엎어 둔 시간만 셉니다';
  await fontsReady(lines.map(x => (x.l || '') + (x.r || '')).join('') + foot + '0123456789:.%·…');
  const W = 1080, H = 1920, RW = 760, X = (W - RW) / 2, P = 60;
  const hOf = x => x.t === 'title' ? 100 : x.t === 'dash' ? 44 : x.t === 'barcode' ? 140 : 62;
  const bodyH = lines.reduce((t, x) => t + hOf(x), 0);
  const RH = bodyH + P * 2;
  const Y = Math.round((H - RH) / 2) - 30;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (!transparent) {
    g.fillStyle = '#F6F3EC'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#6B675F'; g.font = FONT_FOOT; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(foot, W / 2, H - 150);
  }
  // 종이: 아래쪽은 영수증처럼 톱니
  const tooth = 20;
  g.save();
  if (!transparent) { g.shadowColor = 'rgba(28,27,25,0.10)'; g.shadowBlur = 40; g.shadowOffsetY = 12; }
  g.beginPath();
  g.moveTo(X, Y); g.lineTo(X + RW, Y); g.lineTo(X + RW, Y + RH);
  for (let x = X + RW; x > X; x -= tooth) { g.lineTo(x - tooth / 2, Y + RH + 16); g.lineTo(Math.max(X, x - tooth), Y + RH); }
  g.closePath();
  g.fillStyle = '#FFFEFA'; g.fill();
  g.restore();

  let y = Y + P;
  const L = X + P, R = X + RW - P;
  for (const x of lines) {
    const h = hOf(x);
    if (x.t === 'title') {
      g.font = FONT_TITLE; g.fillStyle = '#1C1B19'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(x.l, W / 2, y + h / 2 - 10);
    } else if (x.t === 'dash') {
      g.strokeStyle = '#1C1B19'; g.lineWidth = 3; g.setLineDash([12, 10]);
      g.beginPath(); g.moveTo(L, y + h / 2); g.lineTo(R, y + h / 2); g.stroke(); g.setLineDash([]);
    } else if (x.t === 'barcode') {
      const r = rng(x.seed); let bx = L; g.fillStyle = '#1C1B19';
      while (bx < R - 12) { const bw = 3 + Math.floor(r() * 4) * 3; g.fillRect(bx, y + 30, Math.min(bw, R - bx), 96); bx += bw + 4 + Math.floor(r() * 3) * 4; }
    } else {
      g.textBaseline = 'middle';
      g.font = x.bold ? FONT_BOLD : FONT_BODY;
      g.fillStyle = x.muted ? '#6B675F' : '#1C1B19';
      const mid = y + h / 2;
      if (x.hl && x.r) {
        const tw = g.measureText(x.r).width;
        g.fillStyle = '#EBD63A'; g.fillRect(R - tw - 10, mid - 28, tw + 20, 56);
        g.fillStyle = '#1C1B19';
      }
      const numeric = /^[\d.:\s]+[가-힣]?$/.test(x.l);
      g.font = numeric ? (x.bold ? FONT_BOLD : FONT_BODY) : (x.bold ? FONT_LABEL_BOLD : FONT_LABEL);
      g.fillStyle = x.muted ? '#6B675F' : '#1C1B19';
      g.textAlign = 'left'; g.fillText(x.l, L, mid);
      g.font = x.bold ? FONT_BOLD : FONT_BODY;
      if (x.hl) g.fillStyle = '#1C1B19';
      if (x.r) { g.textAlign = 'right'; g.fillText(x.r, R, mid); }
    }
    y += h;
  }
  return c;
}

const cardBlob = transparent => drawCard(transparent).then(c => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/png')));

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- 버튼 동작 ---------- */

const ACTIONS = {
  go: r => go(r),
  setGrade: g => { draft().grade = g; render(); },
  toggleSubj: s => {
    const d = draft(), i = d.subjects.indexOf(s);
    if (i >= 0) {
      if (d.subjects.length === 1) return toast('과목은 하나 이상 있어야 해요');
      d.subjects.splice(i, 1);
    } else d.subjects.push(s);
    render();
  },
  addSubj: () => {
    const el = document.getElementById('newSubj');
    const v = el ? el.value.trim() : '';
    if (!v) return;
    const d = draft();
    if (!d.subjects.includes(v)) d.subjects.push(v);
    render();
  },
  goal: n => { const d = draft(); d.goalMin = Math.min(16 * 60, Math.max(30, d.goalMin + Number(n))); render(); },
  onboardNext: () => {
    const d = draft();
    d.onboarded = true;
    db.settings = d;
    db.lastSubject = d.subjects[0];
    save();
    go('guide');
  },
  guideDone: () => go(ui.guideFrom === 'settings' ? 'settings' : 'home'),
  pickSubj: s => { db.lastSubject = s; save(); render(); },
  pickMode: m => {
    if (m === 'camera' && !db.camIntroSeen) return go('camIntro');
    db.mode = m === 'camera' ? 'camera' : 'flip'; save(); render();
  },
  camIntroOk: () => { db.camIntroSeen = true; db.mode = 'camera'; save(); go(ui.camFrom === 'settings' ? 'settings' : 'home'); },
  camIntroNo: () => { db.camIntroSeen = true; db.mode = 'flip'; save(); go(ui.camFrom === 'settings' ? 'settings' : 'home'); },
  start: () => {
    const mode = db.mode === 'camera' ? 'camera' : 'flip';
    const asked = requestSensor();   // iOS는 버튼을 누른 그 순간에 권한을 물어야 한다
    const k = dayKey();
    if (db.closed[k]) { delete db.closed[k]; toast('오늘 마감을 풀었어요'); }
    const now = Date.now();
    db.active = { subject: currentSubject(), start: now, study: 0, brk: 0, up: 0, upCount: 0, away: [], state: 'waiting', savedAt: now, awayAt: 0, mode };
    if (mode === 'camera') Object.assign(db.active, { absentCount: 0, absentMs: 0, drowsyCount: 0, drowsyMs: 0, lapseMs: 4000, lapseCount: 0, lapseBytes: 0 });
    ui.awayPending = 0;
    save();
    lapse.clear();   // 지난 세션에서 남은 타임랩스 사진은 새 세션을 시작할 때 지운다
    if (mode === 'camera') cam.start();   // 카메라 권한도 누른 그 순간에 묻는다
    go('timer');
    engine.begin();
    asked.then(() => engine.refresh());
  },
  resume: () => {
    requestSensor().then(() => engine.refresh());
    if (db.active && db.active.mode === 'camera') cam.start();
    engine.begin();
    renderTimerState();
  },
  toFlip: () => {
    const a = db.active;
    if (!a) return;
    cam.stop(); lapse.clear();
    a.mode = 'flip'; a.state = 'waiting';
    db.mode = 'flip';
    save();
    requestSensor().then(() => engine.refresh());
    engine.begin();
    renderTimerState();
  },
  breakOn: () => { const a = db.active; if (!a) return; engine.tick(); a.state = 'break'; save(); renderTimerState(); },
  unbreak: () => { const a = db.active; if (!a) return; engine.tick(); a.state = 'waiting'; save(); engine.refresh(); },
  endSession: (_, el) => {
    const a = db.active;
    if (!a) return;
    if (!ui.endArm || Date.now() - ui.endArm > 3000) {
      ui.endArm = Date.now();
      el.textContent = '한 번 더 누르면 끝';
      setTimeout(() => { if (route === 'timer') renderTimerState(); }, 3000);
      return;
    }
    ui.endArm = 0;
    engine.tick();
    engine.stop();
    const isCam = a.mode === 'camera';
    if (isCam) cam.stop();
    const now = Date.now();
    db.active = null;
    ui.awayPending = 0;
    ui.lapse = null;
    if (a.study < 60000) { if (isCam) lapse.clear(); save(); toast('1분이 안 돼서 저장하지 않았어요'); return go('home'); }
    const s = {
      id: now.toString(36), day: dayKey(a.start), subject: a.subject, start: a.start, end: now,
      study: Math.round(a.study), brk: Math.round(a.brk), up: Math.round(a.up), upCount: a.upCount,
      away: a.away, sensor: isCam || sensor.mode === 'on', mode: isCam ? 'camera' : 'flip',
    };
    if (isCam) Object.assign(s, {
      absentCount: a.absentCount || 0, absentMs: Math.round(a.absentMs || 0),
      drowsyCount: a.drowsyCount || 0, drowsyMs: Math.round(a.drowsyMs || 0),
    });
    db.sessions.push(s);
    save();
    ui.lastSession = s.id;
    go('done');
  },
  awayReason: k => {
    const a = db.active;
    if (a && ui.awayPending) a.away.push({ reason: k, ms: Math.round(ui.awayPending), at: Date.now() });
    ui.awayPending = 0;
    save();
    render();
  },
  closeDay: () => { const k = closeKey(); db.closed[k] = true; ui.shareKey = k; save(); go('share'); },
  openShare: () => { ui.shareKey = closeKey(); go('share'); },
  reopen: () => { delete db.closed[shareKey()]; ui.shareKey = null; save(); go('home'); },
  lapseMake: async () => {
    const s = db.sessions.find(x => x.id === ui.lastSession);
    if (!s || (ui.lapse && ui.lapse.state === 'making')) return;
    const n = ui.lapse && ui.lapse.n;
    ui.lapse = { state: 'making', pct: 0, n };
    render();
    try {
      const r = await makeTimelapse(s, p => {
        if (ui.lapse) ui.lapse.pct = p;
        const el = document.getElementById('lapsePct');
        if (el) el.textContent = Math.round(p * 100) + '%';
      });
      await lapse.clear();   // 영상을 만들면 사진은 바로 지운다
      const v = { sessionId: s.id, day: s.day, subject: s.subject, ext: r.ext, type: r.blob.type || 'video/mp4' };
      try { await lapse.putVideo({ ...v, buf: await r.blob.arrayBuffer() }); }
      catch (e) { console.warn('video save', e); }   // 저장 공간이 모자라도 이번엔 화면에서 저장할 수 있다
      setVideo({ ...v, blob: r.blob });
      ui.lapse = { state: 'ready' };
    } catch (e) {
      console.warn('timelapse', e);
      if (e && e.message === 'few') { lapse.clear(); ui.lapse = { state: 'few' }; }
      else ui.lapse = { state: 'fail', n };
    }
    if (route === 'done') render();
  },
  lapseShare: async () => {
    const V = ui.video;
    if (!V) return;
    const name = `eopeodwo-${V.day}.${V.ext}`;
    const file = new File([V.blob], name, { type: V.blob.type || 'video/mp4' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else { downloadBlob(V.blob, name); toast('영상을 저장했어요'); }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      downloadBlob(V.blob, name);
      toast('공유 창을 못 열어서 파일로 저장했어요');
    }
  },
  lapseDelete: () => { lapse.clear(); ui.lapse = { state: 'deleted' }; render(); },
  videoDelete: async () => {
    await lapse.delVideo();
    setVideo(null);
    if (route === 'done') ui.lapse = { state: 'videoDeleted' };
    toast('영상을 지웠어요');
    render();
  },
  togglePhoneStop: () => {
    db.settings.phoneStop = db.settings.phoneStop === false;
    if (ui.draft) ui.draft.phoneStop = db.settings.phoneStop;
    save(); render();
  },
  toggleDrowsy: () => {
    db.settings.drowsy = !db.settings.drowsy;
    if (ui.draft) ui.draft.drowsy = db.settings.drowsy;
    save(); render();
  },
  toggleNick: () => { db.settings.showNick = !db.settings.showNick; save(); render(); },
  shareCard: async () => {
    const blob = ui.cardBlob;
    if (!blob) return toast('카드를 만드는 중이에요. 잠시 뒤에 다시 눌러 주세요.');
    const file = new File([blob], `eopeodwo-${shareKey()}.png`, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else { downloadBlob(blob, file.name); toast('이미지를 저장했어요. 인스타에서 불러와 주세요.'); }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      downloadBlob(blob, file.name);
      toast('공유 창을 못 열어서 이미지로 저장했어요');
    }
  },
  copySticker: () => {
    if (!navigator.clipboard || !window.ClipboardItem) return toast('이 브라우저는 이미지 복사를 지원하지 않아요');
    navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob(true) })])
      .then(() => toast('복사했어요. 스토리 화면에서 붙여 넣으세요.'))
      .catch(() => toast('복사하지 못했어요'));
  },
  recTab: t => { ui.recTab = t; render(); },
  recShift: n => {
    const today = dayKey();
    let k = shiftKey(ui.recKey || today, Number(n));
    if (k > today) k = today;
    ui.recKey = k;
    render();
  },
  saveSettings: () => {
    const d = draft();
    db.settings = { ...d };
    if (!d.subjects.includes(db.lastSubject)) db.lastSubject = d.subjects[0];
    save();
    ui.draft = null;
    toast('저장했어요');
    render();
  },
  resetAll: () => {
    if (!ui.resetArm) {
      ui.resetArm = true;
      render();
      setTimeout(() => { if (ui.resetArm) { ui.resetArm = false; if (route === 'settings') render(); } }, 4000);
      return;
    }
    db = { ...blank(), settings: { ...db.settings } };
    lapse.clear(); lapse.delVideo(); setVideo(null);   // 타임랩스 사진과 영상도 같이 지운다
    ui.resetArm = false;
    save();
    toast('기록을 지웠어요');
    render();
  },
};

app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset.arg, el, e);
});

function syncField(e) {
  const t = e.target;
  if (!ui.draft) return;
  if (t.id === 'examName') ui.draft.examName = t.value.trim();
  else if (t.id === 'examDate') ui.draft.examDate = t.value;
  else if (t.id === 'nickname') ui.draft.nickname = t.value.trim();
}
app.addEventListener('input', syncField);
app.addEventListener('change', syncField);
app.addEventListener('keydown', e => {
  if (e.target.id === 'newSubj' && e.key === 'Enter') { e.preventDefault(); ACTIONS.addSubj(); }
});

/* ---------- 시작 ---------- */

(function boot() {
  if (db.settings.onboarded) save();   // 다시 계산한 세션 날짜를 저장해 둔다
  if (!db.settings.onboarded) route = 'onboard';
  else if (db.active) {
    // 공부 중에 앱이 꺼졌다가 다시 열린 경우
    const a = db.active, now = Date.now();
    const from = a.awayAt || a.savedAt;
    if (from && now - from >= AWAY_MIN_MS && a.state !== 'break') ui.awayPending = now - from;
    if (a.mode === 'camera') { if (a.state !== 'break') a.state = 'waiting'; }
    else if (a.state === 'counting') a.state = 'up';
    a.awayAt = 0;
    sensor.mode = 'unknown';
    route = 'timer';
    save();
  }
  render();
  if (db.active) { engine.lastTick = Date.now(); engine.loop(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
