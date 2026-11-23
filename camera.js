'use strict';

/* 세워 두기(카메라) 모드
   - 전면 카메라로 얼굴이 있는지만 본다. 영상은 폰 밖으로 보내지 않는다.
   - 폰을 들었는지는 기울기 센서와 화면 전체 변화로 같이 본다.
   - 졸음(실험)은 설정에서 켰을 때만 눈 감은 정도를 본다.
   - 타임랩스용 작은 사진을 IndexedDB에 모았다가 영상으로 만든다.
   app.js보다 먼저 불러온다. app.js의 전역(db, engine, ui, route...)은 함수 안에서만 쓴다. */

const VENDOR = 'vendor/mediapipe-1.2.2';
const MUXER_SRC = 'vendor/mp4-muxer-5.2.2/mp4-muxer.js';
const CAMCFG = {
  DETECT_MS: 500,          // 얼굴 감지는 초당 2번
  LANDMARK_MS: 700,        // 졸음 판정용 눈 점수는 초당 1~2번
  ABSENT_MS: 20000,        // 얼굴이 이만큼 안 보이면 자리 비움
  DROWSY_MS: 10000,        // 눈을 이만큼 감고 있으면 졸음
  LIFT_DEG: 27,            // 기준 자세에서 이만큼 기울면 든 걸로
  LIFT_HOLD_MS: 1500,      // 이만큼 이어져야 든 걸로
  SETTLE_MS: 2500,         // 이만큼 가만히 있으면 그 자세를 기준으로
  SETTLE_DEG: 3,
  SCENE_CORR: 0.5,         // 칸 하나의 무늬 상관계수가 이보다 낮으면 바뀐 칸
  SCENE_LIFT: 0.6,         // 사람 자리를 뺀 칸 중 이 비율 넘게 바뀌면 든 걸로
  SCENE_STILL: 0.15,       // 바로 앞 장과 비교해 이 비율 밑이면 가만히 있는 것
  EYE_MIN: 0.6, EYE_MAX: 0.85, EYE_MARGIN: 0.3,
  PITCH_OFF_DEG: 15,       // 고개를 이만큼 숙이거나 들면 졸음 판정을 쉰다
  FRAME_MS: 4000,          // 타임랩스 사진 간격(처음)
  FRAME_H: 720,
  MAX_FRAMES: 1800,        // 30초 영상에는 900장이면 충분하다. 넘으면 한 장씩 건너 지운다
  MAX_BYTES: 300 * 1024 * 1024,
};

/* ---------- 타임랩스 사진·영상 저장소 ---------- */
// frames: 세션 중 모으는 사진. video: 만든 영상 하나. 지우기를 누를 때까지 남겨 둔다

const lapse = {
  _db: null,
  open() {
    if (!this._db) this._db = new Promise((res, rej) => {
      const r = indexedDB.open('eopeodwo', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('frames')) d.createObjectStore('frames', { autoIncrement: true });
        if (!d.objectStoreNames.contains('video')) d.createObjectStore('video');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._db;
  },
  async run(mode, fn, store = 'frames') {
    const d = await this.open();
    return new Promise((res, rej) => {
      const tx = d.transaction(store, mode), st = tx.objectStore(store);
      let out;
      Promise.resolve(fn(st, v => { out = v; })).catch(rej);
      tx.oncomplete = () => res(out);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  },
  add(rec) { return this.run('readwrite', st => { st.add(rec); }); },
  count() { return this.run('readonly', (st, set) => { const r = st.count(); r.onsuccess = () => set(r.result); }); },
  keys() { return this.run('readonly', (st, set) => { const r = st.getAllKeys(); r.onsuccess = () => set(r.result); }); },
  get(k) { return this.run('readonly', (st, set) => { const r = st.get(k); r.onsuccess = () => set(r.result); }); },
  del(keys) { return this.run('readwrite', st => { for (const k of keys) st.delete(k); }); },
  clear() { return this.run('readwrite', st => { st.clear(); }).catch(() => {}); },
  putVideo(v) { return this.run('readwrite', st => { st.put(v, 'last'); }, 'video'); },
  getVideo() { return this.run('readonly', (st, set) => { const r = st.get('last'); r.onsuccess = () => set(r.result || null); }, 'video'); },
  delVideo() { return this.run('readwrite', st => { st.delete('last'); }, 'video').catch(() => {}); },
  async bytes() {
    return this.run('readonly', (st, set) => {
      let n = 0;
      const r = st.openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { n += (c.value.buf && c.value.buf.byteLength) || 0; c.continue(); } else set(n); };
    });
  },
};

/* ---------- 작은 계산 도구 ---------- */

const deg = r => r * 180 / Math.PI;
// 기울기(beta, gamma)를 중력 방향 벡터로 바꾼다. 화면 방향(alpha)은 쓰지 않는다
function tiltVec(beta, gamma) {
  const b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  return [Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}
function vecAngle(a, b) {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return deg(Math.acos(d));
}
function vecMean(list) {
  const m = [0, 0, 0];
  for (const v of list) { m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; }
  const n = Math.hypot(m[0], m[1], m[2]) || 1;
  return [m[0] / n, m[1] / n, m[2] / n];
}
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const abs = p => new URL(p, location.href).href;

/* ---------- 카메라 모드 본체 ---------- */

const cam = {
  status: 'off',          // off · starting · on · error
  errKind: '',            // perm · nocam · model
  stream: null, video: null, box: null, timer: null,
  vision: null, fileset: null, detector: null, landmarker: null, lmLoading: null,

  /* 화면 */
  ensureDom() {
    if (this.box) return;
    const box = document.createElement('div');
    box.className = 'campv';
    box.innerHTML = '<video playsinline muted autoplay></video><span></span>';
    document.body.appendChild(box);
    this.box = box;
    this.video = box.querySelector('video');
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
  },
  syncPreview() {
    this.ensureDom();
    const a = db.active;
    const show = route === 'timer' && a && a.mode === 'camera' && this.status === 'on';
    this.box.classList.toggle('on', !!show);
    this.box.classList.toggle('dim', !!(show && a.state === 'counting'));
    if (show) this.box.querySelector('span').textContent = this.statusText();
  },
  statusText() {
    const a = db.active;
    if (!a) return '';
    if (this.status !== 'on') return '카메라 켜는 중';
    if (a.state === 'break') return '쉬는 중';
    if (a.state === 'up' || this.lifted) return '폰 움직임';
    if (!this.calibrated) return '자리 잡는 중';
    if (this.faceVisible) {
      if (a.state === 'drowsy') return '눈 감음';
      return '얼굴 보여요';
    }
    if (!this.lastFaceAt) return '얼굴 찾는 중';
    return `자리 비움 ${Math.floor((Date.now() - this.lastFaceAt) / 1000)}초`;
  },

  /* 켜고 끄기 */
  resetTracking() {
    const now = Date.now();
    this.faceVisible = false; this.lastFaceAt = 0; this.lostStudy = 0; this.faceBox = null;
    this.calibrated = false; this.lifted = false; this.offSince = 0;
    this.base = null; this.tiltNow = null; this.tiltLog = []; this.lastTiltAt = 0;
    this.sceneRef = null; this.scenePrev = null; this.stillLog = [];
    this.eyeCal = []; this.eyeBase = null; this.pitchBase = null; this.closedSince = 0; this.closedStudy = 0;
    this.lastLm = 0; this.lastFrameAt = now; this.lastDetect = 0;
    this.sceneFrac = 0; this.stillFrac = 1;
  },
  async start() {
    this.ensureDom();
    this.stopStream();
    this.status = 'starting'; this.errKind = '';
    this.resetTracking();
    engine.refresh(); this.syncPreview();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return this.fail('nocam');
    try {
      // 전면 카메라 센서는 4:3이다. 9:16을 달라고 하면 양옆을 잘라서 주니까 4:3으로 받아 화각을 다 쓴다
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 15, max: 30 } },
      });
      this.zoomOut();
    } catch (e) {
      return this.fail(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'perm' : 'nocam');
    }
    if (!db.active || db.active.mode !== 'camera') { this.stopStream(); return; }
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch (e) { /* autoplay 속성으로 다시 시도된다 */ }
    try { await this.loadDetector(); } catch (e) { console.warn('detector', e); this.stopStream(); return this.fail('model'); }
    if (db.settings.drowsy) this.loadLandmarker();
    if (window.VideoEncoder) fetch(MUXER_SRC).catch(() => {});   // 오프라인에서도 타임랩스를 만들 수 있게 미리 받아 둔다
    if (!db.active || db.active.mode !== 'camera') { this.stopStream(); return; }
    this.status = 'on';
    this.resetTracking();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.analyze(), CAMCFG.DETECT_MS);
    engine.refresh(); this.syncPreview();
  },
  // 줌을 지원하는 카메라(일부 안드로이드)는 가장 넓게 돌려 둔다
  zoomOut() {
    try {
      const t = this.stream.getVideoTracks()[0], caps = t.getCapabilities ? t.getCapabilities() : {};
      if (caps.zoom && caps.zoom.min != null) t.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] }).catch(() => {});
    } catch (e) { /* 줌이 없으면 그대로 */ }
  },
  fail(kind) {
    this.status = 'error'; this.errKind = kind;
    clearInterval(this.timer); this.timer = null;
    engine.refresh(); this.syncPreview();
  },
  stopStream() {
    clearInterval(this.timer); this.timer = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  },
  stop() { this.stopStream(); this.status = 'off'; this.syncPreview(); },
  // 다른 앱에 다녀오면 iOS가 카메라를 끈다. 돌아오면 다시 켜 보고 안 되면 계속하기 버튼을 띄운다
  pause() { clearInterval(this.timer); this.timer = null; },
  async wake() {
    const a = db.active;
    if (!a || a.mode !== 'camera' || this.status === 'off' || this.status === 'error') return;
    const live = this.stream && this.stream.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
    if (live && this.status === 'on') {
      this.lastFaceAt = this.faceVisible ? Date.now() : this.lastFaceAt && Date.now();
      this.offSince = 0; this.closedSince = 0;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.analyze(), CAMCFG.DETECT_MS);
      return;
    }
    await this.start();
    if (this.status !== 'on') { this.status = 'off'; sensor.mode = 'unknown'; engine.refresh(); this.syncPreview(); }
  },

  /* 모델 */
  async loadVision() {
    if (this.vision) return;
    this.vision = await import('./' + VENDOR + '/vision_bundle.mjs');
    this.fileset = { wasmLoaderPath: abs(VENDOR + '/wasm/vision_wasm_internal.js'), wasmBinaryPath: abs(VENDOR + '/wasm/vision_wasm_internal.wasm') };
  },
  async loadDetector() {
    if (this.detector) return;
    await this.loadVision();
    this.detector = await this.vision.FaceDetector.createFromOptions(this.fileset, {
      baseOptions: { modelAssetPath: abs(VENDOR + '/models/blaze_face_short_range.tflite'), delegate: 'CPU' },
      runningMode: 'VIDEO', minDetectionConfidence: 0.5,
    });
  },
  loadLandmarker() {
    if (this.landmarker || this.lmLoading) return this.lmLoading;
    this.lmLoading = (async () => {
      await this.loadVision();
      this.landmarker = await this.vision.FaceLandmarker.createFromOptions(this.fileset, {
        baseOptions: { modelAssetPath: abs(VENDOR + '/models/face_landmarker.task'), delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
    })().catch(e => { console.warn('landmarker', e); this.lmLoading = null; });
    return this.lmLoading;
  },

  /* 기울기 */
  onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    const now = Date.now();
    this.tiltNow = tiltVec(e.beta, e.gamma);
    this.lastTiltAt = now;
    this.tiltLog.push([now, this.tiltNow]);
    while (this.tiltLog.length && now - this.tiltLog[0][0] > CAMCFG.SETTLE_MS + 500) this.tiltLog.shift();
  },
  tiltLive() { return Date.now() - this.lastTiltAt < 1500; },
  tiltStill(now) {
    if (!this.tiltLive()) return true;
    const log = this.tiltLog.filter(x => now - x[0] <= CAMCFG.SETTLE_MS);
    if (!log.length || now - log[0][0] < CAMCFG.SETTLE_MS - 600) return false;
    const last = log[log.length - 1][1];
    return log.every(x => vecAngle(x[1], last) < CAMCFG.SETTLE_DEG);
  },

  /* 화면 전체 변화: 작게 줄인 흑백 프레임을 칸마다 무늬로 비교한다.
     칸마다 상관계수를 보니까 밝기나 대비가 바뀌어도 흔들리지 않는다 */
  grayFrame() {
    const v = this.video, land = v.videoWidth > v.videoHeight;
    const W = land ? 64 : 48, H = land ? 48 : 64;
    if (!this.gc) { this.gc = document.createElement('canvas'); this.gx = this.gc.getContext('2d', { willReadFrequently: true }); }
    if (this.gc.width !== W || this.gc.height !== H) { this.gc.width = W; this.gc.height = H; }
    this.gx.drawImage(v, 0, 0, W, H);
    const px = this.gx.getImageData(0, 0, W, H).data, n = W * H, f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
    return { W, H, f };
  },
  // 사람이 있을 만한 곳(얼굴 위쪽부터 아래로, 얼굴 폭 3배)은 빼고 4×4 칸마다 비교해서 바뀐 칸의 비율을 돌려준다.
  // 사람이 자리를 뜨면 그 영역만 바뀌고, 폰을 들면 머리 위 배경과 양옆까지 다 바뀐다
  sceneDiff(a, b) {
    if (!a || !b || a.W !== b.W) return 1;
    const { W, H } = a, C = 4, N = C * C, fb = this.faceBox;
    const fx = fb ? fb.x + fb.w / 2 : 0;
    let changed = 0, total = 0, all = 0, allChanged = 0;
    for (let cy = 0; cy < H; cy += C) for (let cx = 0; cx < W; cx += C) {
      let ma = 0, mb = 0;
      for (let y = cy; y < cy + C; y++) for (let x = cx; x < cx + C; x++) { ma += a.f[y * W + x]; mb += b.f[y * W + x]; }
      ma /= N; mb /= N;
      let va = 0, vb = 0, cov = 0;
      for (let y = cy; y < cy + C; y++) for (let x = cx; x < cx + C; x++) {
        const p = a.f[y * W + x] - ma, q = b.f[y * W + x] - mb;
        va += p * p; vb += q * q; cov += p * q;
      }
      const sa = Math.sqrt(va / N), sb = Math.sqrt(vb / N);
      if (sa < 4 && sb < 4) continue;          // 둘 다 밋밋한 칸은 판단하지 않는다
      const hit = sa < 4 || sb < 4 || cov / N / (sa * sb) < CAMCFG.SCENE_CORR;
      all++; if (hit) allChanged++;
      if (fb) {
        const x = (cx + C / 2) / W, y = (cy + C / 2) / H;
        if (Math.abs(x - fx) < fb.w * 1.5 && y > fb.y - fb.h * 0.6) continue;
      }
      total++; if (hit) changed++;
    }
    // 사람이 화면을 거의 다 채워서 남는 칸이 너무 적으면 전체를 보되 더 엄하게 본다
    if (total < 12) return all ? Math.max(0, (allChanged / all - 0.3) / 0.7) : 0;
    return changed / total;
  },

  /* 0.5초마다 */
  analyze() {
    const a = db.active, v = this.video;
    if (!a || a.mode !== 'camera' || this.status !== 'on' || !v || v.readyState < 2 || !v.videoWidth) return;
    const now = Date.now(), t = performance.now();

    // 1) 얼굴. 모델은 128×128 정사각형으로 보니까 세로 영상을 통째로 넘기면 얼굴이 너무 작아진다.
    //    얼굴이 있던 자리(처음엔 위쪽 가운데)를 정사각형으로 잘라 넘기고, 못 찾으면 세 번에 한 번은 전체를 본다
    if (!this.ac) { this.ac = document.createElement('canvas'); this.ax = this.ac.getContext('2d'); }
    const vw = v.videoWidth, vh = v.videoHeight, fb0 = this.faceBox;
    const whole = !this.faceVisible && (this.missN = (this.missN || 0) + 1) % 3 === 0;
    let sx = 0, sy = 0, sw = vw, sh = vh, aw, ah;
    if (whole) {
      const k = 256 / Math.max(vw, vh); aw = Math.round(vw * k); ah = Math.round(vh * k);
    } else {
      const side = Math.min(vw, vh); sw = sh = side; aw = ah = 192;
      const clamp = (x, hi) => Math.max(0, Math.min(hi, x));
      if (vh > vw) sy = clamp((fb0 ? (fb0.y + fb0.h / 2) * vh : vh * 0.4) - side / 2, vh - side);
      else sx = clamp((fb0 ? (fb0.x + fb0.w / 2) * vw : vw / 2) - side / 2, vw - side);
    }
    if (this.ac.width !== aw || this.ac.height !== ah) { this.ac.width = aw; this.ac.height = ah; }
    this.ax.drawImage(v, sx, sy, sw, sh, 0, 0, aw, ah);
    let det = null;
    try {
      const r = this.detector.detectForVideo(this.ac, Math.max(t, this.lastDetect + 1));
      this.lastDetect = Math.max(t, this.lastDetect + 1);
      for (const d of (r && r.detections) || []) {
        const sc = d.categories && d.categories[0] ? d.categories[0].score : 0;
        if (sc >= 0.5 && (!det || sc > det.sc)) det = { sc, b: d.boundingBox };
      }
    } catch (e) { console.warn('detect', e); }
    const was = this.faceVisible;
    this.faceVisible = !!det;
    if (det) {
      // 잘라 낸 좌표를 전체 화면 기준(0~1)으로 바꿔 둔다
      this.faceBox = {
        x: (sx + det.b.originX / aw * sw) / vw, y: (sy + det.b.originY / ah * sh) / vh,
        w: det.b.width / aw * sw / vw, h: det.b.height / ah * sh / vh,
      };
      this.lastFaceAt = now; this.missN = 0;
    } else if (was) {
      this.lostStudy = a.study;   // 얼굴이 사라진 순간의 순공. 자리 비움이 되면 여기서부터 뺀다
    }

    // 2) 폰 움직임: 기울기와 화면 전체 변화
    const g = this.grayFrame();
    this.stillFrac = this.sceneDiff(g, this.scenePrev);
    this.scenePrev = g;
    this.stillLog.push([now, this.stillFrac]);
    while (this.stillLog.length && now - this.stillLog[0][0] > CAMCFG.SETTLE_MS + 300) this.stillLog.shift();
    const camStill = this.stillLog.length >= Math.floor(CAMCFG.SETTLE_MS / CAMCFG.DETECT_MS)
      && now - this.stillLog[0][0] >= CAMCFG.SETTLE_MS - 600
      && this.stillLog.every(x => x[1] < CAMCFG.SCENE_STILL);
    const settled = camStill && this.tiltStill(now);

    if (!this.calibrated || this.lifted) {
      // 가만히 놓이면 그 자세를 기준으로 잡는다. 처음 시작할 때도, 들었다가 내려놨을 때도 같다
      if (settled) {
        this.base = this.tiltLive() ? vecMean(this.tiltLog.filter(x => now - x[0] <= CAMCFG.SETTLE_MS).map(x => x[1])) : null;
        this.sceneRef = g;
        this.calibrated = true; this.lifted = false; this.offSince = 0;
        if (this.faceVisible) this.lastFaceAt = now;
      }
    } else {
      this.sceneFrac = this.sceneDiff(g, this.sceneRef);
      const tiltOff = !!(this.base && this.tiltNow && this.tiltLive() && vecAngle(this.tiltNow, this.base) > CAMCFG.LIFT_DEG);
      const sceneOff = this.sceneFrac > CAMCFG.SCENE_LIFT;
      if (tiltOff || sceneOff) {
        if (!this.offSince) this.offSince = now;
        if (now - this.offSince >= CAMCFG.LIFT_HOLD_MS) { this.lifted = true; this.stillLog = []; }
      } else {
        this.offSince = 0;
        // 조명이 천천히 바뀌는 건 기준에 녹여 둔다
        if (this.sceneFrac < 0.3) for (let i = 0; i < g.f.length; i++) this.sceneRef.f[i] = this.sceneRef.f[i] * 0.95 + g.f[i] * 0.05;
      }
    }

    // 3) 졸음(실험)
    if (db.settings.drowsy) this.checkEyes(now, t, a);
    else this.closedSince = 0;

    // 4) 타임랩스 사진
    if (a.state !== 'break' && now - this.lastFrameAt >= (a.lapseMs || CAMCFG.FRAME_MS)) {
      this.lastFrameAt = now;
      this.capture(a);
    }

    engine.refresh();
    this.syncPreview();
  },

  checkEyes(now, t, a) {
    if (!this.landmarker) { this.loadLandmarker(); return; }
    if (!this.faceVisible || this.lifted || !this.calibrated) { this.closedSince = 0; return; }
    if (now - this.lastLm < CAMCFG.LANDMARK_MS) return;
    this.lastLm = now;
    const v = this.video;
    if (!this.lc) { this.lc = document.createElement('canvas'); this.lx = this.lc.getContext('2d'); }
    const s = 480 / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
    if (this.lc.width !== w || this.lc.height !== h) { this.lc.width = w; this.lc.height = h; }
    this.lx.drawImage(v, 0, 0, w, h);
    let r;
    try { r = this.landmarker.detectForVideo(this.lc, Math.max(t, (this.lastLmT || 0) + 1)); this.lastLmT = Math.max(t, (this.lastLmT || 0) + 1); }
    catch (e) { console.warn('landmark', e); return; }
    const bs = r && r.faceBlendshapes && r.faceBlendshapes[0];
    if (!bs) { this.closedSince = 0; return; }
    const score = n => { const c = bs.categories.find(x => x.categoryName === n); return c ? c.score : 0; };
    const L = score('eyeBlinkLeft'), R = score('eyeBlinkRight');
    const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
    const pitch = m && m.data ? deg(Math.atan2(m.data[6], m.data[10])) : 0;
    // 시작하고 몇 번은 평소 눈 점수와 고개 각도를 모은다
    if (this.eyeBase == null) {
      this.eyeCal.push([(L + R) / 2, pitch]);
      if (this.eyeCal.length >= 6) {
        this.eyeBase = median(this.eyeCal.map(x => x[0]));
        this.pitchBase = median(this.eyeCal.map(x => x[1]));
      }
      return;
    }
    const thr = Math.min(CAMCFG.EYE_MAX, Math.max(CAMCFG.EYE_MIN, this.eyeBase + CAMCFG.EYE_MARGIN));
    const headOff = Math.abs(pitch - this.pitchBase) > CAMCFG.PITCH_OFF_DEG;   // 고개를 숙이면 판정을 쉰다
    const closed = L > thr && R > thr && !headOff;
    if (closed) {
      if (!this.closedSince) { this.closedSince = now; this.closedStudy = a.study; }
    } else this.closedSince = 0;
  },

  /* 상태 판정. engine.decide가 부른다 */
  decide(a) {
    const prev = a.state, now = Date.now();
    let next = prev;
    if (this.status !== 'on' || !this.calibrated) next = this.lifted ? 'up' : 'waiting';
    else if (this.lifted) next = 'up';
    else if (prev === 'counting') {
      if (!this.faceVisible && this.lastFaceAt && now - this.lastFaceAt > CAMCFG.ABSENT_MS) next = 'absent';
      else if (db.settings.drowsy && this.closedSince && now - this.closedSince > CAMCFG.DROWSY_MS) next = 'drowsy';
    } else if (prev === 'drowsy') {
      if (!this.faceVisible && this.lastFaceAt && now - this.lastFaceAt > CAMCFG.ABSENT_MS) next = 'absent';
      else if (!this.closedSince) next = this.faceVisible ? 'counting' : 'drowsy';
    } else if (prev === 'absent') {
      if (this.faceVisible) next = 'counting';
    } else {
      // waiting · up
      if (this.faceVisible) next = 'counting';
      else if (prev === 'up') next = 'waiting';
    }
    if (next === prev) return;
    if (next === 'up' && (prev === 'counting' || prev === 'drowsy' || prev === 'absent')) a.upCount++;
    if (next === 'absent') {
      // 얼굴이 사라진 뒤 20초는 순공에서 빼서 자리 비움으로 옮긴다
      const moved = prev === 'counting' ? Math.max(0, a.study - this.lostStudy) : 0;
      a.study -= moved;
      a.absentMs = (a.absentMs || 0) + moved;
      a.absentCount = (a.absentCount || 0) + 1;
    }
    if (next === 'drowsy') {
      const moved = Math.max(0, a.study - this.closedStudy);
      a.study -= moved;
      a.drowsyMs = (a.drowsyMs || 0) + moved;
      a.drowsyCount = (a.drowsyCount || 0) + 1;
    }
    a.state = next;
    renderTimerState();
  },

  /* 타임랩스 사진 한 장: 세로 720px, 카메라 화면 전체.
     미리보기는 거울처럼 보여 주지만 사진은 뒤집지 않는다. 책과 필기 글씨가 바로 보이게 */
  async capture(a) {
    if (this.capturing) return;
    this.capturing = true;
    try {
      // 카메라가 보는 그대로(자르지 않고) 세로 720px로 줄인다
      const v = this.video, vw = v.videoWidth, vh = v.videoHeight, H = CAMCFG.FRAME_H, W = Math.round(H * vw / vh);
      if (!this.fc) { this.fc = document.createElement('canvas'); this.fx = this.fc.getContext('2d'); }
      if (this.fc.width !== W || this.fc.height !== H) { this.fc.width = W; this.fc.height = H; }
      this.fx.drawImage(v, 0, 0, W, H);
      const blob = await new Promise(r => this.fc.toBlob(r, 'image/jpeg', 0.72));
      if (!blob || !db.active || db.active.start !== a.start) return;
      const buf = await blob.arrayBuffer();
      await lapse.add({ sid: a.start, t: Date.now(), study: Math.round(a.study), buf });
      a.lapseCount = (a.lapseCount || 0) + 1;
      a.lapseBytes = (a.lapseBytes || 0) + buf.byteLength;
      // 장 수나 용량이 넘칠 것 같으면 한 장 건너 하나씩 지우고 간격을 두 배로 늘린다
      if (a.lapseCount >= CAMCFG.MAX_FRAMES || a.lapseBytes >= CAMCFG.MAX_BYTES * 0.9) await this.thin(a);
    } catch (e) {
      console.warn('frame', e);
    } finally { this.capturing = false; }
  },
  async thin(a) {
    const keys = await lapse.keys();
    await lapse.del(keys.filter((_, i) => i % 2 === 1));
    a.lapseMs = (a.lapseMs || CAMCFG.FRAME_MS) * 2;
    a.lapseCount = await lapse.count();
    a.lapseBytes = await lapse.bytes();
    save();
  },
};

/* ---------- 타임랩스 영상 만들기 ---------- */

const VID_W = 720, VID_H = 1280, IMG_H = 960, VID_FPS = 30, END_S = 2.5;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src; s.onload = res; s.onerror = () => rej(new Error('script ' + src));
    document.head.appendChild(s);
  });
}

// 영상 길이: 사진 5장에 1초, 8초~30초. 끝에 결과 장면 2.5초
function lapsePlan(n) {
  const T = Math.min(30, Math.max(8, n / 5));
  return { T, frames: Math.round(T * VID_FPS), end: Math.round(END_S * VID_FPS) };
}

async function makeTimelapse(session, onProgress) {
  const keys = await lapse.keys();
  if (keys.length < 8) throw new Error('few');
  const recs = [];   // 시각과 순공만 먼저 읽는다. 사진은 그릴 때 하나씩 읽는다
  for (const k of keys) { const r = await lapse.get(k); if (r) recs.push({ k, study: r.study }); }
  const plan = lapsePlan(recs.length);
  await fontsReady('0123456789:' + session.subject + '순공 엎어둬 월일요');

  const c = document.createElement('canvas');
  c.width = VID_W; c.height = VID_H;
  const g = c.getContext('2d');
  let curIdx = -1, bmp = null;
  const total = plan.frames + plan.end;

  async function drawAt(i) {
    if (i >= plan.frames) return drawEnd(g, session);
    const pos = i * recs.length / plan.frames, idx = Math.min(recs.length - 1, Math.floor(pos));
    if (idx !== curIdx) {
      const r = await lapse.get(recs[idx].k);
      if (bmp && bmp.close) bmp.close();
      bmp = r ? await createImageBitmap(new Blob([r.buf], { type: 'image/jpeg' })) : null;
      curIdx = idx;
    }
    // 위쪽 720×960에 카메라 화면 전체를 자르지 않고 넣고, 아래 320px에 타이머를 둔다
    g.fillStyle = '#1C1B19'; g.fillRect(0, 0, VID_W, VID_H);
    if (bmp) {
      const sc = Math.min(VID_W / bmp.width, IMG_H / bmp.height), dw = bmp.width * sc, dh = bmp.height * sc;
      g.drawImage(bmp, (VID_W - dw) / 2, (IMG_H - dh) / 2, dw, dh);
    }
    const a = recs[idx].study, b = recs[Math.min(recs.length - 1, idx + 1)].study;
    drawOverlay(g, a + (b - a) * (pos - idx), session.subject);
  }

  let blob = null, ext = 'mp4';
  try {
    blob = await encodeWebCodecs(c, drawAt, total, onProgress);
  } catch (e) {
    console.warn('webcodecs', e);
    curIdx = -1;
    const r = await encodeRecorder(c, drawAt, total, onProgress);
    blob = r.blob; ext = r.ext;
  }
  if (bmp && bmp.close) bmp.close();
  return { blob, ext };
}

function drawOverlay(g, study, subject) {
  g.fillStyle = '#1C1B19';
  g.fillRect(0, IMG_H, VID_W, VID_H - IMG_H);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#A8A295'; g.font = '500 32px "IBM Plex Sans KR", sans-serif';
  g.fillText(`${subject} 순공`, VID_W / 2, VID_H - 168);
  g.fillStyle = '#F6F3EC'; g.font = '500 104px "IBM Plex Mono", monospace';
  g.fillText(hms(study), VID_W / 2, VID_H - 62);
  g.textAlign = 'left'; g.font = '700 30px "IBM Plex Sans KR", sans-serif';
  g.fillStyle = 'rgba(246,243,236,0.9)';
  g.fillText('엎어둬', 36, 72);
}

function drawEnd(g, s) {
  g.fillStyle = '#F6F3EC'; g.fillRect(0, 0, VID_W, VID_H);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const d = new Date(s.start);
  g.fillStyle = '#6B675F'; g.font = '400 34px "IBM Plex Sans KR", sans-serif';
  g.fillText(`${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`, VID_W / 2, 470);
  g.fillStyle = '#1C1B19'; g.font = '700 64px "IBM Plex Sans KR", sans-serif';
  g.fillText(s.subject, VID_W / 2, 570);
  const t = hms(s.study);
  g.font = '500 120px "IBM Plex Mono", monospace';
  const tw = g.measureText(t).width;
  g.fillStyle = '#EBD63A'; g.fillRect((VID_W - tw) / 2 - 18, 640, tw + 36, 140);
  g.fillStyle = '#1C1B19'; g.fillText(t, VID_W / 2, 752);
  g.fillStyle = '#6B675F'; g.font = '400 34px "IBM Plex Sans KR", sans-serif';
  g.fillText('순공', VID_W / 2, 840);
  g.fillStyle = '#1C1B19'; g.font = '700 34px "IBM Plex Sans KR", sans-serif';
  g.fillText('엎어둬', VID_W / 2, VID_H - 120);
}

async function encodeWebCodecs(canvas, drawAt, total, onProgress) {
  if (!window.VideoEncoder || !window.VideoFrame) throw new Error('no VideoEncoder');
  const base = { width: VID_W, height: VID_H, bitrate: 3000000, framerate: VID_FPS };
  let cfg = null;
  for (const codec of ['avc1.4d0028', 'avc1.42e028', 'avc1.42001f', 'avc1.640028']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ ...base, codec, avc: { format: 'avc' } });
      if (r && r.supported) { cfg = { ...base, codec, avc: { format: 'avc' } }; break; }
    } catch (e) { /* 다음 코덱 */ }
  }
  if (!cfg) throw new Error('no avc');
  await loadScript(MUXER_SRC);
  const M = window.Mp4Muxer;
  const muxer = new M.Muxer({ target: new M.ArrayBufferTarget(), video: { codec: 'avc', width: VID_W, height: VID_H }, fastStart: 'in-memory' });
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { err = e; } });
  enc.configure(cfg);
  const step = 1e6 / VID_FPS;
  for (let i = 0; i < total; i++) {
    if (err) throw err;
    await drawAt(i);
    const f = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
    enc.encode(f, { keyFrame: i % (VID_FPS * 2) === 0 });
    f.close();
    while (enc.encodeQueueSize > 4) await wait(5);
    if (i % 10 === 0) { onProgress(i / total); await wait(0); }
  }
  await enc.flush();
  if (err) throw err;
  enc.close();
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// WebCodecs가 안 되면 캔버스를 실시간으로 녹화한다. 영상 길이만큼 걸린다
async function encodeRecorder(canvas, drawAt, total, onProgress) {
  if (!canvas.captureStream || !window.MediaRecorder) throw new Error('no recorder');
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  await drawAt(0);
  const stream = canvas.captureStream(VID_FPS);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3000000 } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise(r => { rec.onstop = r; });
  rec.start(1000);
  const t0 = performance.now(), step = 1000 / VID_FPS;
  for (let i = 0; i < total; i++) {
    await drawAt(i);
    const track = stream.getVideoTracks()[0];
    if (track && track.requestFrame) track.requestFrame();
    if (i % 10 === 0) onProgress(i / total);
    const due = t0 + (i + 1) * step - performance.now();
    if (due > 0) await wait(due);
  }
  rec.stop();
  await done;
  for (const t of stream.getTracks()) t.stop();
  const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}
