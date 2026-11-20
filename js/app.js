/*
 * Ping Pong — practice10
 * CPU対戦（3段階）／2人対戦、マウス・タッチ・キーボード操作、効果音、戦績保存
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
  let muted = store.get('muted', false);

  // ===== ユーティリティ =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a = -1, b = 1) => a + Math.random() * (b - a);

  // ===== 効果音（WebAudio） =====
  let actx = null;
  function ensureAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  function beep(freq, dur, type = 'square', vol = 0.07, slideTo = 0) {
    if (muted || !actx || state === 'menu') return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    paddle: () => beep(320 + Math.min(rally, 20) * 18, 0.07, 'square', 0.07),
    wall:   () => beep(200, 0.05, 'square', 0.045),
    score:  () => beep(520, 0.28, 'triangle', 0.09, 130),
    count:  () => beep(660, 0.08, 'square', 0.05),
    go:     () => beep(990, 0.16, 'square', 0.06),
    click:  () => beep(800, 0.04, 'square', 0.04),
    win:    () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'square', 0.07), i * 120)),
    lose:   () => [392, 330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.22, 'triangle', 0.08), i * 160)),
  };

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
    burst(b.x, b.y, p.color, 12, 260);
    sfx.paddle();

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
    sfx.score();
    popText = { text: '+1', color: scorer.color, x: side === 0 ? W / 4 : W * 3 / 4, t: 1 };
    resetBall();

    const other = paddles[1 - side];
    if (scorer.score >= settings.points && scorer.score - other.score >= 2) {
      endGame(side);
      return;
    }
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
    showOverlay(null);
    gameEl.classList.add('playing');
  }

  function endGame(winner) {
    state = 'over';
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
    refreshMenu();
    showOverlay('menu');
  }

  function pause() {
    if (!inPlay()) return;
    pausedFrom = state;
    state = 'paused';
    gameEl.classList.remove('playing');
    showOverlay('pause');
  }

  function resume() {
    if (state !== 'paused') return;
    state = pausedFrom;
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
    document.querySelectorAll('.seg').forEach((seg) => {
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
      $('help').innerHTML = 'マウス・タッチで上下に動かす ／ キーボード：W・S または ↑・↓<br>Space：一時停止 ／ M：音のオン・オフ ／ Enter：スタート';
    } else {
      $('record').textContent = `最長ラリー ${best}`;
      $('help').innerHTML = '左（P1）：W・S または 画面左半分をタッチ<br>右（P2）：↑・↓ または 画面右半分をタッチ<br>Space：一時停止 ／ M：音のオン・オフ';
    }
  }

  function updateMuteBtn() {
    $('muteBtn').textContent = muted ? '🔇' : '🔊';
  }
  function toggleMute() {
    muted = !muted;
    store.set('muted', muted);
    updateMuteBtn();
  }

  document.querySelectorAll('.seg').forEach((seg) => {
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
  $('muteBtn').addEventListener('click', () => { ensureAudio(); toggleMute(); });

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

    if (e.code === 'KeyM') { ensureAudio(); toggleMute(); return; }
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
  updateMuteBtn();
  refreshMenu();
  showOverlay('menu');
  requestAnimationFrame(frame);
})();
