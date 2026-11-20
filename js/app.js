/*
 * Ping Pong — practice10
 * CPU対戦（3段階）／2人対戦、マウス・タッチ・キーボード操作、効果音＋BGM、戦績保存
 */
(() => {
  'use strict';

  // ===== 定数 =====
  const W = 1200, H = 800;
  const PADDLE_W = 18, PADDLE_H = 120, BALL = 14;
  const KEY_SPEED = 760;        // キーボード操作時のパドル速度(px/s)
  const POINTER_SPEED = 2600;   // マウス・タッチ追従の最大速度(px/s)
  const MAX_ANGLE = 55 * Math.PI / 180;
  const COLORS = { left: '#4fd1ff', right: '#ff5fa2', ball: '#ffffff' };

  const DIFF = {
    easy:   { label: 'かんたん',   speed: 460, max: 950,  accel: 1.035, cpuSpeed: 380, react: 0.30, err: 60, aim: 0.15 },
    normal: { label: 'ふつう',     speed: 540, max: 1200, accel: 1.05,  cpuSpeed: 560, react: 0.15, err: 34, aim: 0.30 },
    hard:   { label: 'むずかしい', speed: 620, max: 1450, accel: 1.06,  cpuSpeed: 820, react: 0.06, err: 14, aim: 0.40 },
  };

  // 3x5 ドット数字
  const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
                  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const canvas = $('pong');
  const ctx = canvas.getContext('2d');
  const gameEl = $('game');
  const overlays = { menu: $('menu'), pause: $('pauseMenu'), over: $('overMenu') };

  // ===== 保存（localStorage が使えない環境でも動くように） =====
  const STORE_KEY = 'practice10-pong-v2';
  const store = (() => {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { data = {}; }
    return {
      get: (k, def) => (k in data ? data[k] : def),
      set: (k, v) => { data[k] = v; try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* noop */ } },
    };
  })();

  const settings = {
    mode: store.get('mode', 'cpu'),
    diff: store.get('diff', 'normal'),
    points: store.get('points', 11),
  };
  let sfxOn = store.get('sfxOn', !store.get('muted', false));
  let bgmOn = store.get('bgmOn', true);

  // ===== ユーティリティ =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a = -1, b = 1) => a + Math.random() * (b - a);

  // ===== サウンド（WebAudio：効果音＋BGM） =====
  const audio = { ctx: null, sfxBus: null, bgmBus: null, noiseBuf: null };
  const BGM_VOL = 0.5;

  function ensureAudio() {
    if (audio.ctx) {
      if (audio.ctx.state === 'suspended') audio.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = audio.ctx = new AC();
    const master = c.createGain();
    master.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp).connect(c.destination);
    audio.sfxBus = c.createGain();
    audio.sfxBus.gain.value = sfxOn ? 1 : 0;
    audio.sfxBus.connect(master);
    audio.bgmBus = c.createGain();
    audio.bgmBus.gain.value = bgmOn ? BGM_VOL : 0;
    audio.bgmBus.connect(master);
    const len = c.sampleRate;
    audio.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = audio.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    bgm.start();
    syncBgm();
  }

  function applyVolumes() {
    if (!audio.ctx) return;
    const t = audio.ctx.currentTime;
    audio.sfxBus.gain.setTargetAtTime(sfxOn ? 1 : 0, t, 0.02);
    audio.bgmBus.gain.setTargetAtTime(bgmOn ? BGM_VOL : 0, t, 0.05);
  }

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // 基本の音。o.at=絶対時刻 / o.when=今からの秒数 / o.ui=メニューでも鳴らす / o.bgm=BGM用
  function tone(freq, dur, o = {}) {
    const c = audio.ctx;
    if (!c) return;
    if (!o.ui && !o.bgm && state === 'menu') return;  // 背景デモ中の効果音は鳴らさない
    const t = o.at != null ? o.at : c.currentTime + (o.when || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t + dur);
    const v = o.vol != null ? o.vol : 0.07;
    const a = o.attack || 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(o.bgm ? audio.bgmBus : audio.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  // ノイズ音（打楽器・爆発・風切り音）
  function noise(dur, o = {}) {
    const c = audio.ctx;
    if (!c) return;
    if (!o.ui && !o.bgm && state === 'menu') return;
    const t = o.at != null ? o.at : c.currentTime + (o.when || 0);
    const src = c.createBufferSource();
    src.buffer = audio.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = o.type || 'highpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, t + dur);
    const g = c.createGain();
    const v = o.vol != null ? o.vol : 0.08;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(o.bgm ? audio.bgmBus : audio.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.03);
  }

  function melody(notes, o = {}) {  // notes: [[midi|null, 秒], ...]
    let w = o.when || 0;
    for (const [n, d] of notes) {
      if (n != null) tone(midi(n), d * 0.95, { ...o, when: w });
      w += d;
    }
  }

  const sfx = {
    click:  () => tone(880, 0.04, { vol: 0.05, ui: true }),
    toggle: () => { tone(660, 0.05, { vol: 0.05, ui: true }); tone(990, 0.07, { vol: 0.05, ui: true, when: 0.05 }); },
    paddle: (edge) => {
      const base = 300 + Math.min(rally, 24) * 16;  // ラリーが続くほど音が高く
      tone(base, 0.08, { vol: 0.08 });
      tone(base * 1.5, 0.06, { type: 'triangle', vol: 0.05 });
      if (edge) {  // パドルの端で打ったスマッシュ
        noise(0.14, { type: 'bandpass', freq: 3200, freqTo: 700, vol: 0.14 });
        tone(base * 2, 0.14, { type: 'sawtooth', vol: 0.05, slide: base * 0.8 });
      }
    },
    wall:   () => tone(190, 0.05, { vol: 0.05, slide: 150 }),
    serve:  () => noise(0.25, { type: 'bandpass', freq: 400, freqTo: 2600, vol: 0.09 }),
    scoreGood: () => {
      noise(0.3, { type: 'lowpass', freq: 1500, freqTo: 200, vol: 0.14 });
      melody([[76, 0.07], [79, 0.07], [84, 0.16]], { vol: 0.07 });
    },
    scoreBad: () => {
      noise(0.4, { type: 'lowpass', freq: 900, freqTo: 90, vol: 0.16 });
      tone(440, 0.45, { type: 'triangle', vol: 0.1, slide: 100 });
    },
    count:  () => tone(660, 0.09, { vol: 0.06 }),
    go:     () => { tone(988, 0.2, { vol: 0.06 }); tone(1319, 0.2, { type: 'triangle', vol: 0.04 }); },
    rally:  () => melody([[79, 0.06], [83, 0.06], [86, 0.06], [91, 0.14]], { vol: 0.06 }),
    deuce:  () => melody([[81, 0.09], [76, 0.09], [81, 0.09], [76, 0.12]], { vol: 0.05 }),
    pause:  () => melody([[81, 0.06], [74, 0.1]], { vol: 0.05, ui: true }),
    resume: () => melody([[74, 0.06], [81, 0.1]], { vol: 0.05, ui: true }),
    win: () => {
      melody([[72, 0.12], [76, 0.12], [79, 0.12], [84, 0.3], [null, 0.06], [81, 0.12], [84, 0.6]], { vol: 0.07, ui: true });
      melody([[48, 0.36], [55, 0.36], [53, 0.18], [48, 0.6]], { type: 'triangle', vol: 0.09, ui: true });
    },
    lose: () => {
      melody([[67, 0.26], [66, 0.26], [65, 0.26]], { type: 'triangle', vol: 0.09, ui: true });
      tone(midi(64), 0.8, { type: 'triangle', vol: 0.09, ui: true, when: 0.78, slide: midi(58) });
    },
  };

  // ----- BGM（ステップシーケンサー） -----
  const TRACKS = {
    menu: {
      bpm: () => 96,
      chords: [[57, 60, 64], [52, 55, 59], [53, 57, 60], [55, 59, 62]],   // Am Em F G
      bass: [45, 40, 41, 43],
      mel: [[76, null, null, null, 74, null, 72, null], [71, null, null, null, 67, null, null, null],
            [69, null, 72, null, 76, null, 77, null], [74, null, null, null, 71, null, null, null]],
      drums: false,
    },
    game: {
      bpm: () => 138 + Math.min(rally, 20) * 1.5 + (isDeuce() ? 10 : 0),  // ラリー・デュースでテンポアップ
      chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],   // Am F C G
      bass: [45, 41, 48, 43],
      mel: [[76, null, 74, 76, 79, null, 76, 74], [72, null, 74, 72, 69, null, 72, null],
            [72, 74, 76, null, 79, 76, 74, 72], [74, null, 71, 74, 79, null, 74, null]],
      drums: true,
    },
  };

  const bgm = {
    track: null, step: 0, nextTime: 0, timer: null,
    start() { if (!this.timer) this.timer = setInterval(() => this.tick(), 25); },
    setTrack(name) {
      if (this.track === name) return;
      this.track = name;
      this.step = 0;
      if (audio.ctx) this.nextTime = audio.ctx.currentTime + 0.08;
    },
    tick() {
      const c = audio.ctx;
      if (!c || !this.track) return;
      if (this.nextTime < c.currentTime) this.nextTime = c.currentTime + 0.03;
      while (this.nextTime < c.currentTime + 0.12) {
        this.playStep(TRACKS[this.track], this.step, this.nextTime);
        this.nextTime += 60 / TRACKS[this.track].bpm() / 4;  // 16分音符
        this.step = (this.step + 1) % 64;
      }
    },
    playStep(tr, step, t) {
      const bar = step >> 4, s = step & 15;
      const sec16 = 60 / tr.bpm() / 4;
      const o = { bgm: true, at: t };
      const chord = tr.chords[bar];
      if (tr.drums) {
        // ベース（8分）
        if (s % 2 === 0) {
          const n = tr.bass[bar] + (s % 8 === 4 ? 12 : 0);
          tone(midi(n), sec16 * 1.7, { ...o, type: 'triangle', vol: 0.16 });
        }
        // アルペジオ（16分）
        tone(midi(chord[[0, 1, 2, 1][s % 4]] + 12), sec16 * 0.8, { ...o, type: 'square', vol: 0.025 });
        // ドラム
        if (s === 0 || s === 8 || s === 10) {
          tone(150, 0.12, { ...o, type: 'sine', vol: 0.22, slide: 45 });
        }
        if (s === 4 || s === 12) noise(0.12, { ...o, type: 'highpass', freq: 1800, vol: 0.07 });
        if (s % 2 === 1) noise(0.03, { ...o, type: 'highpass', freq: 7000, vol: 0.03 });
      } else {
        if (s === 0 || s === 8) tone(midi(tr.bass[bar]), sec16 * 7, { ...o, type: 'sine', vol: 0.16, attack: 0.02 });
        if (s % 2 === 0) tone(midi(chord[[0, 1, 2, 1, 2, 1, 0, 1][(s / 2) % 8]] + 12), sec16 * 1.8,
          { ...o, type: 'triangle', vol: 0.05 });
        if (s % 4 === 2) noise(0.03, { ...o, type: 'highpass', freq: 8000, vol: 0.015 });
      }
      // メロディ（8分）
      if (s % 2 === 0) {
        const n = tr.mel[bar][s / 2];
        if (n != null) tone(midi(n), sec16 * (tr.drums ? 1.6 : 3.2), { ...o, type: tr.drums ? 'square' : 'triangle', vol: tr.drums ? 0.045 : 0.07 });
      }
    },
  };

  function syncBgm() {
    const name = state === 'menu' ? 'menu' : (state === 'countdown' || state === 'playing') ? 'game' : null;
    bgm.setTrack(name);
  }

  // ===== エンティティ =====
  function makePaddle(x, color) {
    return { x, y: H / 2, w: PADDLE_W, h: PADDLE_H, vy: 0, score: 0, color, flash: 0,
             target: null, aiTimer: 0, aiTarget: H / 2, aiErr: 0 };
  }
  const paddles = [makePaddle(48, COLORS.left), makePaddle(W - 48, COLORS.right)];
  const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0, size: BALL, color: COLORS.ball };
  let trail = [];
  let particles = [];

  // ===== 状態 =====
  let state = 'menu';            // menu | countdown | playing | paused | over
  let pausedFrom = 'playing';
  let countdown = 0, lastCountInt = 0, showCountNumbers = false;
  let serveDir = 1;
  let rally = 0, bestRallyGame = 0;
  let shake = 0;
  let menuServeTimer = 0.5;
  let popText = null;            // 得点時のポップ表示 {text, color, t}
  const keys = new Set();

  const isDeuce = () => state !== 'menu' && paddles[0].score >= settings.points - 1 && paddles[1].score >= settings.points - 1;
  const inPlay = () => state === 'playing' || state === 'countdown';
  const aiParams = () => (state === 'menu' ? DIFF.normal : DIFF[settings.diff]);
  const ballParams = () => (state === 'menu' || settings.mode === 'pvp' ? DIFF.normal : DIFF[settings.diff]);

  // ===== ボール =====
  function resetBall() {
    ball.x = W / 2; ball.y = H / 2; ball.vx = 0; ball.vy = 0; ball.color = COLORS.ball;
    trail = [];
  }

  function serve(dir) {
    const p = ballParams();
    const ang = rand() * (25 * Math.PI / 180);
    ball.x = W / 2;
    ball.y = H / 2 + rand() * 120;
    ball.vx = dir * Math.cos(ang) * p.speed;
    ball.vy = Math.sin(ang) * p.speed;
    ball.color = COLORS.ball;
    rally = 0;
    const ap = aiParams();
    paddles.forEach((pd) => { pd.aiErr = rand() * ap.err; pd.aiTimer = ap.react; });
    sfx.serve();
  }

  // 指定X座標に到達したときのY座標を壁反射込みで予測
  function predictY(tx) {
    if (ball.vx === 0) return H / 2;
    const t = (tx - ball.x) / ball.vx;
    if (t < 0) return H / 2;
    const hs = ball.size / 2;
    const span = H - 2 * hs;
    let y = ball.y + ball.vy * t - hs;
    y = ((y % (2 * span)) + 2 * span) % (2 * span);
    if (y > span) y = 2 * span - y;
    return y + hs;
  }

  function hitPaddle(p, side) {
    const b = ball, hs = b.size / 2;
    if (b.x + hs < p.x - p.w / 2 || b.x - hs > p.x + p.w / 2 ||
        b.y + hs < p.y - p.h / 2 || b.y - hs > p.y + p.h / 2) return false;
    // 自分に向かってくるボールだけ跳ね返す（多重ヒット防止）
    if ((side === 0 && b.vx >= 0) || (side === 1 && b.vx <= 0)) return false;

    const bp = ballParams();
    const rel = clamp((b.y - p.y) / (p.h / 2 + hs), -1, 1);  // 当たった位置 -1(上端)〜1(下端)
    const ang = rel * MAX_ANGLE;
    const sp = Math.min(Math.hypot(b.vx, b.vy) * bp.accel, bp.max);
    const dir = side === 0 ? 1 : -1;
    b.vx = dir * Math.cos(ang) * sp;
    b.vy = clamp(Math.sin(ang) * sp + p.vy * 0.12, -sp * 0.85, sp * 0.85);  // パドルの動きで少し回転
    b.x = side === 0 ? p.x + p.w / 2 + hs : p.x - p.w / 2 - hs;
    b.color = p.color;

    p.flash = 1;
    rally++;
    bestRallyGame = Math.max(bestRallyGame, rally);
    const edge = Math.abs(rel) > 0.7;
    burst(b.x, b.y, p.color, edge ? 22 : 12, edge ? 380 : 260);
    sfx.paddle(edge);
    if (state !== 'menu' && rally % 10 === 0) {
      sfx.rally();
      popText = { text: `RALLY ${rally}!`, color: '#ffd166', x: W / 2, t: 1.2 };
    }

    // 相手CPUの狙い（ズレ）を決め直し、反応までの遅れをつける
    const opp = paddles[1 - side];
    const ap = aiParams();
    opp.aiErr = rand() * ap.err + rand() * opp.h * ap.aim;
    opp.aiTimer = ap.react;
    return true;
  }

  function stepBall(dt) {
    const dist = Math.hypot(ball.vx, ball.vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 6));  // すり抜け防止のため細かく分割
    const h = dt / steps, hs = ball.size / 2;
    for (let i = 0; i < steps; i++) {
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      if (ball.y - hs < 0) { ball.y = hs; ball.vy = Math.abs(ball.vy); onWall(); }
      else if (ball.y + hs > H) { ball.y = H - hs; ball.vy = -Math.abs(ball.vy); onWall(); }
      hitPaddle(paddles[0], 0) || hitPaddle(paddles[1], 1);
      if (ball.x < -40) { pointScored(1); return; }
      if (ball.x > W + 40) { pointScored(0); return; }
    }
  }

  function onWall() {
    burst(ball.x, ball.y, 'rgba(255,255,255,.8)', 5, 140);
    sfx.wall();
  }

  // ===== 得点・試合進行 =====
  function pointScored(side) {
    const scorer = paddles[side];
    const edgeY = clamp(ball.y, 0, H);
    burst(side === 1 ? 0 : W, edgeY, scorer.color, 40, 420);
    shake = 14;

    if (state === 'menu') {  // デモ中
      resetBall();
      menuServeTimer = 0.8;
      return;
    }

    scorer.score++;
    (settings.mode === 'cpu' && side === 1 ? sfx.scoreBad : sfx.scoreGood)();
    popText = { text: '+1', color: scorer.color, x: side === 0 ? W / 4 : W * 3 / 4, t: 1 };
    resetBall();

    const other = paddles[1 - side];
    if (scorer.score >= settings.points && scorer.score - other.score >= 2) {
      endGame(side);
      return;
    }
    if (isDeuce() && scorer.score === other.score) setTimeout(sfx.deuce, 450);
    serveDir = side === 0 ? 1 : -1;  // 失点した側へサーブ
    beginCountdown(1.1, false);
  }

  function beginCountdown(sec, numbers) {
    state = 'countdown';
    countdown = sec;
    showCountNumbers = numbers;
    lastCountInt = Math.ceil(sec);
    resetBall();
    if (numbers) sfx.count();
  }

  function startGame() {
    ensureAudio();
    paddles.forEach((p) => { p.score = 0; p.y = H / 2; p.vy = 0; p.target = null; p.aiErr = 0; p.flash = 0; });
    bestRallyGame = 0;
    rally = 0;
    particles = [];
    popText = null;
    serveDir = Math.random() < 0.5 ? -1 : 1;
    state = 'countdown';  // beep が鳴るよう先に menu を抜ける
    beginCountdown(3, true);
    syncBgm();
    showOverlay(null);
    gameEl.classList.add('playing');
  }

  function endGame(winner) {
    state = 'over';
    syncBgm();
    gameEl.classList.remove('playing');
    const [l, r] = paddles.map((p) => p.score);
    const lines = [];
    let title;

    const bestRally = store.get('bestRally', 0);
    const newBest = bestRallyGame > bestRally;
    if (newBest) store.set('bestRally', bestRallyGame);

    if (settings.mode === 'cpu') {
      const rec = store.get('rec', {});
      const r0 = rec[settings.diff] || { w: 0, l: 0 };
      if (winner === 0) r0.w++; else r0.l++;
      rec[settings.diff] = r0;
      store.set('rec', rec);
      title = winner === 0 ? 'あなたの勝ち！' : 'CPUの勝ち…';
      lines.push(`むずかしさ「${DIFF[settings.diff].label}」 通算 ${r0.w}勝 ${r0.l}敗`);
      (winner === 0 ? sfx.win : sfx.lose)();
    } else {
      title = winner === 0 ? 'P1の勝ち！' : 'P2の勝ち！';
      sfx.win();
    }
    lines.push(`この試合の最長ラリー：${bestRallyGame}` + (newBest ? ' <span class="new">★自己ベスト更新！</span>' : ''));

    $('overTitle').textContent = title;
    $('overTitle').style.color = winner === 0 ? COLORS.left : COLORS.right;
    $('overScore').innerHTML = `<span class="l">${l}</span> - <span class="r">${r}</span>`;
    $('overInfo').innerHTML = lines.join('<br>');
    showOverlay('over');
    burst(winner === 0 ? W / 4 : W * 3 / 4, H / 2, paddles[winner].color, 80, 520);
  }

  function goMenu() {
    state = 'menu';
    gameEl.classList.remove('playing');
    paddles.forEach((p) => { p.score = 0; p.target = null; });
    resetBall();
    menuServeTimer = 0.5;
    syncBgm();
    refreshMenu();
    showOverlay('menu');
  }

  function pause() {
    if (!inPlay()) return;
    pausedFrom = state;
    state = 'paused';
    syncBgm();
    sfx.pause();
    gameEl.classList.remove('playing');
    showOverlay('pause');
  }

  function resume() {
    if (state !== 'paused') return;
    state = pausedFrom;
    syncBgm();
    sfx.resume();
    gameEl.classList.add('playing');
    showOverlay(null);
  }

  // ===== パドル操作 =====
  function controlPaddle(p, dt, upKeys, downKeys) {
    const prev = p.y;
    let dir = 0;
    if (upKeys.some((k) => keys.has(k))) dir -= 1;
    if (downKeys.some((k) => keys.has(k))) dir += 1;
    if (dir !== 0) {
      p.target = null;
      p.y += dir * KEY_SPEED * dt;
    } else if (p.target != null) {
      const m = POINTER_SPEED * dt;
      p.y += clamp(p.target - p.y, -m, m);
    }
    p.y = clamp(p.y, p.h / 2, H - p.h / 2);
    p.vy = dt > 0 ? (p.y - prev) / dt : 0;
  }

  function aiMove(p, dt, ap, side) {
    p.aiTimer -= dt;
    if (p.aiTimer <= 0) {
      p.aiTimer = ap.react;
      const coming = side === 0 ? ball.vx < 0 : ball.vx > 0;
      if (coming) {
        const tx = side === 0 ? p.x + p.w / 2 : p.x - p.w / 2;
        p.aiTarget = predictY(tx) + p.aiErr;
      } else {
        p.aiTarget = H / 2 + (ball.y - H / 2) * 0.25;  // 戻り待ち
      }
    }
    const prev = p.y;
    const d = p.aiTarget - p.y;
    const m = ap.cpuSpeed * dt;
    if (Math.abs(d) > 4) p.y += clamp(d, -m, m);
    p.y = clamp(p.y, p.h / 2, H - p.h / 2);
    p.vy = dt > 0 ? (p.y - prev) / dt : 0;
  }

  // ===== エフェクト =====
  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      const life = 0.35 + Math.random() * 0.45;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: 3 + Math.random() * 4 });
    }
    if (particles.length > 600) particles.splice(0, particles.length - 600);
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.96; p.vy *= 0.96;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
  }

  function updateTrail() {
    if (ball.vx !== 0 || ball.vy !== 0) {
      trail.push({ x: ball.x, y: ball.y });
      if (trail.length > 14) trail.shift();
    }
  }

  // ===== 更新 =====
  function update(dt) {
    shake = Math.max(0, shake - dt * 40);
    paddles.forEach((p) => { p.flash = Math.max(0, p.flash - dt * 4); });
    updateParticles(dt);
    if (popText) { popText.t -= dt; if (popText.t <= 0) popText = null; }

    if (state === 'paused') return;

    if (state === 'menu') {  // 背景デモ（CPU同士）
      aiMove(paddles[0], dt, DIFF.normal, 0);
      aiMove(paddles[1], dt, DIFF.normal, 1);
      if (ball.vx === 0) {
        menuServeTimer -= dt;
        if (menuServeTimer <= 0) serve(Math.random() < 0.5 ? -1 : 1);
      } else {
        stepBall(dt);
      }
      updateTrail();
      return;
    }

    if (state === 'over') return;

    if (settings.mode === 'cpu') {
      controlPaddle(paddles[0], dt, ['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
      aiMove(paddles[1], dt, DIFF[settings.diff], 1);
    } else {
      controlPaddle(paddles[0], dt, ['KeyW'], ['KeyS']);
      controlPaddle(paddles[1], dt, ['ArrowUp'], ['ArrowDown']);
    }

    if (state === 'countdown') {
      countdown -= dt;
      const c = Math.ceil(countdown);
      if (showCountNumbers && c !== lastCountInt && c > 0) { sfx.count(); lastCountInt = c; }
      if (countdown <= 0) {
        if (showCountNumbers) sfx.go();
        state = 'playing';
        serve(serveDir);
      }
    } else if (state === 'playing') {
      stepBall(dt);
    }
    updateTrail();
  }

  // ===== 描画 =====
  function drawDigits(str, cx, y, px, color) {
    const cw = px * 4;
    let x = cx - (str.length * cw - px) / 2;
    ctx.fillStyle = color;
    for (const ch of str) {
      const bits = DIGITS[ch.charCodeAt(0) - 48];
      if (bits) {
        for (let i = 0; i < 15; i++) {
          if (bits[i] === '1') ctx.fillRect(x + (i % 3) * px, y + ((i / 3) | 0) * px, px, px);
        }
      }
      x += cw;
    }
  }

  function text(str, x, y, size, color, align = 'center') {
    ctx.font = `${size}px "DotGothic16", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function drawCourt() {
    const g = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.75);
    g.addColorStop(0, '#131c33');
    g.addColorStop(1, '#070a12');
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, W + 40, H + 40);

    ctx.fillStyle = 'rgba(79,209,255,.035)';
    ctx.fillRect(0, 0, W / 2, H);
    ctx.fillStyle = 'rgba(255,95,162,.035)';
    ctx.fillRect(W / 2, 0, W / 2, H);

    ctx.fillStyle = 'rgba(255,255,255,.16)';
    for (let y = 14; y < H; y += 40) ctx.fillRect(W / 2 - 3, y, 6, 20);

    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 90, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.fillRect(0, 0, W, 6);
    ctx.fillRect(0, H - 6, W, 6);
  }

  function drawScores() {
    const [l, r] = paddles;
    drawDigits(String(l.score), W / 4, 36, 12, 'rgba(79,209,255,.85)');
    drawDigits(String(r.score), W * 3 / 4, 36, 12, 'rgba(255,95,162,.85)');

    const names = settings.mode === 'cpu'
      ? ['あなた', `CPU（${DIFF[settings.diff].label}）`]
      : ['P1', 'P2'];
    text(names[0], W / 4, 118, 22, 'rgba(232,240,255,.55)');
    text(names[1], W * 3 / 4, 118, 22, 'rgba(232,240,255,.55)');

    // デュース表示
    const target = settings.points;
    if (l.score >= target - 1 && r.score >= target - 1) {
      let label = 'デュース', color = '#ffd166';
      if (l.score > r.score) { label = settings.mode === 'cpu' ? 'アドバンテージ あなた' : 'アドバンテージ P1'; color = COLORS.left; }
      if (r.score > l.score) { label = settings.mode === 'cpu' ? 'アドバンテージ CPU' : 'アドバンテージ P2'; color = COLORS.right; }
      ctx.fillStyle = 'rgba(7,10,18,.8)';
      ctx.fillRect(W / 2 - 170, 150, 340, 40);
      text(label, W / 2, 171, 24, color);
    }
  }

  function drawTrail() {
    trail.forEach((t, i) => {
      const k = (i + 1) / trail.length;
      ctx.globalAlpha = k * 0.35;
      ctx.fillStyle = ball.color;
      const s = ball.size * (0.4 + 0.6 * k);
      ctx.fillRect(t.x - s / 2, t.y - s / 2, s, s);
    });
    ctx.globalAlpha = 1;
  }

  function drawPaddle(p) {
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 18 + p.flash * 20;
    ctx.fillStyle = p.flash > 0.05 ? '#ffffff' : p.color;
    ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
    ctx.shadowBlur = 0;
  }

  function drawBall() {
    const visible = state === 'playing' || state === 'menu' ||
      (state === 'countdown' && Math.floor(countdown * 6) % 2 === 0) || state === 'paused';
    if (!visible) return;
    const hs = ball.size / 2;
    ctx.shadowColor = ball.color;
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ball.x - hs, ball.y - hs, ball.size, ball.size);
    ctx.shadowBlur = 0;
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.save();
    if (shake > 0) ctx.translate(rand() * shake, rand() * shake);

    drawCourt();
    if (state !== 'menu') drawScores();
    drawTrail();
    paddles.forEach(drawPaddle);
    drawBall();
    drawParticles();

    if (state === 'countdown' && showCountNumbers) {
      const c = Math.max(1, Math.ceil(countdown));
      const f = countdown - Math.floor(countdown);  // 1→0
      ctx.globalAlpha = 0.4 + 0.6 * f;
      text(String(c), W / 2, H / 2, 120 + 60 * f, '#ffffff');
      ctx.globalAlpha = 1;
    }

    if (popText) {
      ctx.globalAlpha = Math.min(1, popText.t * 1.5);
      text(popText.text, popText.x, 180 - (1 - popText.t) * 30, 40, popText.color);
      ctx.globalAlpha = 1;
    }

    if ((state === 'playing' || state === 'paused') && rally >= 3) {
      text(`RALLY ${rally}`, W / 2, H - 34, 24, 'rgba(255,209,102,.8)');
    }

    ctx.restore();
  }

  // ===== メインループ =====
  let last = 0;
  function frame(t) {
    const dt = last ? Math.min(0.033, (t - last) / 1000) : 0;
    last = t;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // ===== UI =====
  function showOverlay(name) {
    Object.entries(overlays).forEach(([k, el]) => { el.hidden = k !== name; });
    $('hud').hidden = !(name === null || name === 'pause') || state === 'menu' || state === 'over';
  }

  function refreshMenu() {
    document.querySelectorAll('.seg[data-key]').forEach((seg) => {
      const key = seg.dataset.key;
      seg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', String(settings[key]) === b.dataset.val);
      });
    });
    $('diffGroup').hidden = settings.mode !== 'cpu';

    const best = store.get('bestRally', 0);
    if (settings.mode === 'cpu') {
      const r = store.get('rec', {})[settings.diff] || { w: 0, l: 0 };
      $('record').textContent = `「${DIFF[settings.diff].label}」の戦績：${r.w}勝 ${r.l}敗 ／ 最長ラリー ${best}`;
      $('help').innerHTML = 'マウス・タッチで上下に動かす ／ キーボード：W・S または ↑・↓<br>Space：一時停止 ／ M：効果音 ／ B：BGM ／ Enter：スタート';
    } else {
      $('record').textContent = `最長ラリー ${best}`;
      $('help').innerHTML = '左（P1）：W・S または 画面左半分をタッチ<br>右（P2）：↑・↓ または 画面右半分をタッチ<br>Space：一時停止 ／ M：効果音 ／ B：BGM';
    }
  }

  function updateSoundUI() {
    $('muteBtn').textContent = sfxOn ? '🔊' : '🔇';
    $('muteBtn').classList.toggle('off', !sfxOn);
    $('bgmBtn').classList.toggle('off', !bgmOn);
    $('sfxToggle').textContent = `効果音 ${sfxOn ? 'ON' : 'OFF'}`;
    $('sfxToggle').classList.toggle('on', sfxOn);
    $('bgmToggle').textContent = `BGM ${bgmOn ? 'ON' : 'OFF'}`;
    $('bgmToggle').classList.toggle('on', bgmOn);
  }
  function toggleSfx() {
    ensureAudio();
    sfxOn = !sfxOn;
    store.set('sfxOn', sfxOn);
    applyVolumes();
    updateSoundUI();
    if (sfxOn) sfx.toggle();
  }
  function toggleBgm() {
    ensureAudio();
    bgmOn = !bgmOn;
    store.set('bgmOn', bgmOn);
    applyVolumes();
    updateSoundUI();
  }

  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const key = seg.dataset.key;
      const v = key === 'points' ? Number(b.dataset.val) : b.dataset.val;
      settings[key] = v;
      store.set(key, v);
      ensureAudio();
      refreshMenu();
    });
  });

  $('startBtn').addEventListener('click', startGame);
  $('againBtn').addEventListener('click', startGame);
  $('toMenuBtn').addEventListener('click', goMenu);
  $('resumeBtn').addEventListener('click', resume);
  $('quitBtn').addEventListener('click', goMenu);
  $('pauseBtn').addEventListener('click', () => (state === 'paused' ? resume() : pause()));
  $('muteBtn').addEventListener('click', toggleSfx);
  $('bgmBtn').addEventListener('click', toggleBgm);
  $('sfxToggle').addEventListener('click', toggleSfx);
  $('bgmToggle').addEventListener('click', toggleBgm);

  // ボタンのクリック音（効果音トグル自身は除く）
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.id !== 'sfxToggle' && b.id !== 'muteBtn' && b.id !== 'pauseBtn') { ensureAudio(); sfx.click(); }
  });
  // ブラウザの自動再生制限のため、最初の操作でサウンドを開始
  window.addEventListener('pointerdown', ensureAudio, { once: true });
  window.addEventListener('keydown', ensureAudio, { once: true });

  // ポインター（マウス・タッチ）
  function handlePointer(e) {
    if (!inPlay()) return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W;
    const y = (e.clientY - r.top) / r.height * H;
    const idx = settings.mode === 'pvp' ? (x < W / 2 ? 0 : 1) : 0;
    paddles[idx].target = y;
  }
  canvas.addEventListener('pointerdown', (e) => {
    ensureAudio();
    if (e.pointerType !== 'mouse' && canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }
    handlePointer(e);
  });
  canvas.addEventListener('pointermove', handlePointer);

  // キーボード
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.repeat) return;
    const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';

    if (e.code === 'KeyM') { toggleSfx(); return; }
    if (e.code === 'KeyB') { toggleBgm(); return; }
    if ((state === 'menu' || state === 'over') && e.code === 'Enter' && !onButton) { startGame(); return; }
    if (state === 'over' && e.code === 'Escape') { goMenu(); return; }
    if (inPlay() && ['Space', 'KeyP', 'Escape'].includes(e.code)) { pause(); return; }
    if (state === 'paused' && ['Space', 'KeyP', 'Enter'].includes(e.code)) { resume(); return; }
    if (state === 'paused' && e.code === 'Escape') { goMenu(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); pause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // ===== 起動 =====
  updateSoundUI();
  refreshMenu();
  showOverlay('menu');
  requestAnimationFrame(frame);
})();
