// 邪王炎殺黒龍波 — Webカメラ + MediaPipeで黒龍を放つ
// ✊拳で力を溜め(邪眼開眼+黒いオーラ)、🖐手のひらを向けた方向へ渦を巻く黒龍が飛ぶ

import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
  ImageSegmenter,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");
const kanjiEl = document.getElementById("kanji");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("start");
const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("error");

// ---- 定数 ----
const CHARGE_MIN_MS = 450; // これ未満で開いても不発
const CHARGE_FULL_MS = 1600; // チャージ演出が最大になるまで
const COOLDOWN_MS = 1000; // 発射後の再チャージ受付までの時間
const HAND_LOST_GRACE = 20; // 手を見失っても保持するフレーム数
const FACE_LOST_GRACE = 15; // 顔を見失っても保持するフレーム数

// ---- 状態 ----
let handLandmarker = null;
let faceLandmarker = null;
let segmenter = null;
let lastVideoTime = -1;
let hand = null; // {x, y, dirX, dirY, fist, open, facing, auraR} スクリーン座標系
let handMissFrames = 0;
let face = null; // {x, y, w, angle} 額(邪眼)の位置
let faceMissFrames = 0;
let eyeOpen = 0; // 邪眼の開き具合0..1
let state = "idle"; // idle | charging | cooldown
let chargeStart = 0;
let cooldownUntil = 0;
let dragons = [];
let particles = [];
let rings = [];
let shake = 0;
let darkness = 0;
let flash = 0; // 着弾時の画面フラッシュ
let blackoutStart = -1; // 黒龍が飛び終わった後のブラックアウト開始時刻
let hadDragons = false;
let lastFrameTime = performance.now();
let running = false;
let rafId = 0;

// 人物シルエット(セグメンテーション結果)
const silCanvas = document.createElement("canvas");
const silCtx = silCanvas.getContext("2d");
let silImage = null;
let personPixels = []; // マスク座標での人物ピクセルのサンプル(黒炎の湧き出し元)
let auraStrength = 0;

// ---- 座標変換(object-fit: cover + 鏡映し) ----
function coverRect() {
  const W = canvas.width;
  const H = canvas.height;
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
}

function toScreen(nx, ny) {
  const { ox, oy, dw, dh } = coverRect();
  return { x: canvas.width - (ox + nx * dw), y: oy + ny * dh };
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

// ---- サウンド(WebAudio自前生成) ----
let actx = null;
let chargeNodes = null;

function ensureAudio() {
  if (!actx) actx = new AudioContext();
  if (actx.state === "suspended") actx.resume();
}

function makeNoiseBuffer(seconds) {
  const len = Math.floor(actx.sampleRate * seconds);
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function startChargeSound() {
  if (!actx) return;
  stopChargeSound();
  const src = actx.createBufferSource();
  src.buffer = makeNoiseBuffer(2);
  src.loop = true;
  const filter = actx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 140;
  const gain = actx.createGain();
  gain.gain.setValueAtTime(0.0001, actx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + CHARGE_FULL_MS / 1000);
  src.connect(filter).connect(gain).connect(actx.destination);
  src.start();
  chargeNodes = { src, gain };
}

function stopChargeSound() {
  if (!chargeNodes) return;
  const { src, gain } = chargeNodes;
  gain.gain.cancelScheduledValues(actx.currentTime);
  gain.gain.setTargetAtTime(0.0001, actx.currentTime, 0.05);
  src.stop(actx.currentTime + 0.3);
  chargeNodes = null;
}

function playFireSound() {
  if (!actx) return;
  const t = actx.currentTime;
  // 轟音(ノイズバースト)
  const noise = actx.createBufferSource();
  noise.buffer = makeNoiseBuffer(1.5);
  const nf = actx.createBiquadFilter();
  nf.type = "lowpass";
  nf.frequency.setValueAtTime(900, t);
  nf.frequency.exponentialRampToValueAtTime(90, t + 1.2);
  const ng = actx.createGain();
  ng.gain.setValueAtTime(0.5, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
  noise.connect(nf).connect(ng).connect(actx.destination);
  noise.start(t);
  // 咆哮(のこぎり波スイープ)
  const osc = actx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(28, t + 0.9);
  const og = actx.createGain();
  og.gain.setValueAtTime(0.22, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
  osc.connect(og).connect(actx.destination);
  osc.start(t);
  osc.stop(t + 1.1);
}

// ---- ジェスチャー判定 ----
function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 指が伸びているか: 指先が第2関節より手首から遠いかで判定
function countExtendedFingers(lm) {
  const wrist = lm[0];
  const pairs = [
    [8, 6], // 人差し指
    [12, 10], // 中指
    [16, 14], // 薬指
    [20, 18], // 小指
  ];
  let n = 0;
  for (const [tip, pip] of pairs) {
    if (dist2d(lm[tip], wrist) > dist2d(lm[pip], wrist) * 1.15) n++;
  }
  return n;
}

function parseHand(result) {
  const lm = result?.landmarks?.[0];
  if (!lm) return null;
  // 手のひら中心(手首+各指の付け根の平均)
  let cx = 0;
  let cy = 0;
  for (const i of [0, 5, 9, 13, 17]) {
    cx += lm[i].x;
    cy += lm[i].y;
  }
  const center = toScreen(cx / 5, cy / 5);
  // 手首→中指付け根の向き=指先方向(画面内での手の向き)
  const wrist = toScreen(lm[0].x, lm[0].y);
  const mcp9 = toScreen(lm[9].x, lm[9].y);
  let dirX = mcp9.x - wrist.x;
  let dirY = mcp9.y - wrist.y;
  const len = Math.hypot(dirX, dirY);
  if (len > 1e-6) {
    dirX /= len;
    dirY /= len;
  } else {
    dirX = 0;
    dirY = -1;
  }
  // 手のひらがカメラへ向いている度合い:
  // 手のひら三角形(手首・人差し指付け根・小指付け根)の見かけ面積が
  // 手の長さの2乗に対して大きいほど正面向き
  const mcp5 = toScreen(lm[5].x, lm[5].y);
  const mcp17 = toScreen(lm[17].x, lm[17].y);
  const ax = mcp5.x - wrist.x;
  const ay = mcp5.y - wrist.y;
  const bx = mcp17.x - wrist.x;
  const by = mcp17.y - wrist.y;
  const area = Math.abs(ax * by - ay * bx) / 2;
  const ratio = area / (len * len + 1e-6);
  const facing = Math.min(1, Math.max(0, (ratio - 0.07) / 0.1));
  const extended = countExtendedFingers(lm);
  return {
    x: center.x,
    y: center.y,
    dirX,
    dirY,
    facing,
    fist: extended === 0,
    open: extended >= 3,
    auraR: Math.max(60, len * 1.6),
  };
}

// 額(邪眼)の位置: 眉間(9)と額上部(10)の間、傾きは両目の外眼角(33, 263)から
// サイズは実際の片目(目尻33〜目頭133)と同程度にする
function parseFace(result) {
  const lm = result?.faceLandmarks?.[0];
  if (!lm) return null;
  const a = toScreen(lm[9].x, lm[9].y);
  const b = toScreen(lm[10].x, lm[10].y);
  const l = toScreen(lm[33].x, lm[33].y);
  const r = toScreen(lm[263].x, lm[263].y);
  const inner = toScreen(lm[133].x, lm[133].y);
  return {
    x: a.x + (b.x - a.x) * 0.55,
    y: a.y + (b.y - a.y) * 0.55,
    w: dist2d(l, inner) * 0.55,
    angle: Math.atan2(r.y - l.y, r.x - l.x),
  };
}

function showKanji(text, cls) {
  kanjiEl.textContent = text;
  kanjiEl.className = cls;
}

function hideKanji() {
  kanjiEl.className = "hidden";
}

function cancelCharge() {
  state = "idle";
  stopChargeSound();
  hideKanji();
}

function fire(now) {
  state = "cooldown";
  cooldownUntil = now + COOLDOWN_MS;
  stopChargeSound();
  playFireSound();
  dragons.push(new Dragon(hand.x, hand.y, hand.dirX, hand.dirY, hand.facing));
  rings.push({ x: hand.x, y: hand.y, r: 20, alpha: 1 });
  // 発射の火花
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 150 + Math.random() * 500;
    particles.push({
      x: hand.x,
      y: hand.y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.35 + Math.random() * 0.4,
      maxLife: 0.75,
      r: 2 + Math.random() * 5,
      kind: "burst",
    });
  }
  shake = 22;
  showKanji("黒 龍 波 !!", "fire");
  setTimeout(() => {
    if (kanjiEl.className === "fire") hideKanji();
  }, 1100);
}

function updateGesture(now) {
  if (state === "cooldown" && now >= cooldownUntil) state = "idle";
  if (!hand) {
    if (state === "charging") cancelCharge();
    return;
  }
  if (state === "idle" && hand.fist && now >= cooldownUntil) {
    state = "charging";
    chargeStart = now;
    startChargeSound();
    showKanji("邪眼の力を舐めるなよ…", "charge");
  } else if (state === "charging" && hand.open) {
    if (now - chargeStart >= CHARGE_MIN_MS) {
      fire(now);
    } else {
      cancelCharge();
    }
  }
}

// ---- 黒龍 ----
class Dragon {
  // zFrac: 手のひらがカメラへ向いている度合い。高いほど画面手前へ迫ってくる(拡大)
  constructor(x, y, dirX, dirY, zFrac) {
    this.cx = x;
    this.cy = y;
    this.dirX = dirX;
    this.dirY = dirY;
    this.zFrac = zFrac;
    // 正面向きのときは画面内の移動を抑えて手前への接近を主にする
    // 渦中心の進行速度は据え置き=到達時間は変えず、
    // 渦の回転(角速度・半径)を上げて頭の見かけの速度を2倍にする
    this.speed = Math.max(canvas.width, canvas.height) * 1.6 * (1 - zFrac * 0.8);
    this.scale = 1;
    this.spiralR = 10; // 渦の半径(成長する)
    this.spiralMax = Math.min(canvas.width, canvas.height) * 0.3;
    this.phase = Math.random() * Math.PI * 2;
    this.omega = 20 - zFrac * 6; // 渦の角速度
    this.t = 0;
    this.headR = Math.min(canvas.width, canvas.height) * 0.04 + 10;
    this.x = x;
    this.y = y;
    this.angle = Math.atan2(dirY, dirX);
    this.trail = [{ x, y, r: this.headR }];
    this.alive = true;
  }

  update(dt) {
    this.t += dt;
    // 渦の中心が手のひらの向きへ進む
    this.cx += this.dirX * this.speed * dt;
    this.cy += this.dirY * this.speed * dt;
    // 渦を巻きながら飛ぶ: 中心の周りを回転しつつ半径が広がる
    this.spiralR = Math.min(this.spiralMax, this.spiralR + (150 + 250 * this.t) * dt);
    this.phase += this.omega * dt;
    // 正面向きなら手前へ接近=指数的に拡大
    if (this.zFrac > 0.05) {
      this.scale += this.scale * 2.6 * this.zFrac * dt;
    }
    const r = this.spiralR * Math.pow(this.scale, 0.6);
    const px = this.x;
    const py = this.y;
    this.x = this.cx + Math.cos(this.phase) * r;
    this.y = this.cy + Math.sin(this.phase) * r;
    const dx = this.x - px;
    const dy = this.y - py;
    if (Math.hypot(dx, dy) > 1) this.angle = Math.atan2(dy, dx);
    this.trail.unshift({ x: this.x, y: this.y, r: this.headR * this.scale });
    if (this.trail.length > 110) this.trail.pop();
    // 胴体から黒炎を撒く
    for (let i = 0; i < 4; i++) {
      const p = this.trail[Math.floor(Math.random() * this.trail.length)];
      if (!p) continue;
      const a = Math.random() * Math.PI * 2;
      const sp = 20 + Math.random() * 90;
      particles.push({
        x: p.x + (Math.random() - 0.5) * 20,
        y: p.y + (Math.random() - 0.5) * 20,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 30,
        life: 0.3 + Math.random() * 0.5,
        maxLife: 0.8,
        r: (4 + Math.random() * 10) * Math.min(2.5, this.scale),
        kind: "blackflame",
      });
    }
    // 画面手前まで迫ったら着弾
    if (this.scale > 5.5) {
      this.impact();
      return;
    }
    // 画面外に十分出たら消す
    const m = 400 + 300 * this.scale;
    if (
      this.t > 0.5 &&
      (this.cx < -m || this.cx > canvas.width + m || this.cy < -m || this.cy > canvas.height + m)
    ) {
      this.alive = false;
    }
  }

  impact() {
    this.alive = false;
    flash = 1;
    shake = 35;
    rings.push({ x: this.x, y: this.y, r: 40, alpha: 1 });
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 200 + Math.random() * 700;
      particles.push({
        x: this.x,
        y: this.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.5,
        maxLife: 0.9,
        r: 4 + Math.random() * 10,
        kind: "burst",
      });
    }
  }

  draw() {
    const n = this.trail.length;
    // 胴体: 尾から頭へ、黒い核+紫の発光
    ctx.save();
    ctx.shadowColor = "rgba(140, 60, 255, 0.95)";
    ctx.shadowBlur = 26;
    for (let i = n - 1; i >= 0; i--) {
      const p = this.trail[i];
      const k = 1 - i / n;
      const r = p.r * (0.22 + 0.78 * k);
      ctx.fillStyle = i % 6 === 0 ? "#1a0533" : "#060210";
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 頭部
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    const R = this.headR * this.scale;
    ctx.shadowColor = "rgba(160, 80, 255, 1)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#08030f";
    // 頭(前方に尖った形)
    ctx.beginPath();
    ctx.moveTo(R * 2.1, 0);
    ctx.quadraticCurveTo(R * 1.2, -R * 1.1, -R * 0.6, -R * 0.9);
    ctx.quadraticCurveTo(-R * 1.0, 0, -R * 0.6, R * 0.9);
    ctx.quadraticCurveTo(R * 1.2, R * 1.1, R * 2.1, 0);
    ctx.fill();
    // 開いた顎
    ctx.beginPath();
    ctx.moveTo(R * 0.7, 0);
    ctx.lineTo(R * 2.3, -R * 0.75);
    ctx.lineTo(R * 1.1, -R * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(R * 0.7, 0);
    ctx.lineTo(R * 2.3, R * 0.75);
    ctx.lineTo(R * 1.1, R * 0.15);
    ctx.closePath();
    ctx.fill();
    // 角
    ctx.strokeStyle = "#2a0a4d";
    ctx.lineWidth = R * 0.22;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-R * 0.3, -R * 0.7);
    ctx.quadraticCurveTo(-R * 1.3, -R * 1.5, -R * 1.8, -R * 1.1);
    ctx.moveTo(-R * 0.3, R * 0.7);
    ctx.quadraticCurveTo(-R * 1.3, R * 1.5, -R * 1.8, R * 1.1);
    ctx.stroke();
    // 目(赤い発光)
    ctx.shadowColor = "rgba(255, 60, 60, 1)";
    ctx.shadowBlur = 14;
    ctx.fillStyle = "#ff3b3b";
    ctx.beginPath();
    ctx.arc(R * 0.45, -R * 0.42, R * 0.16, 0, Math.PI * 2);
    ctx.arc(R * 0.45, R * 0.42, R * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---- 人物セグメンテーション(黒いオーラ) ----
function updateSegmentation(now) {
  if (!segmenter || state !== "charging") return;
  const result = segmenter.segmentForVideo(video, now);
  const mask = result.categoryMask;
  if (!mask) return;
  const w = mask.width;
  const h = mask.height;
  const arr = mask.getAsUint8Array();
  // 人物側の判定: 通常は値>127が人物。ほぼ全面が該当する場合は反転とみなす
  let count = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > 127) count++;
  const inverted = count > arr.length * 0.92;
  if (silCanvas.width !== w || silCanvas.height !== h) {
    silCanvas.width = w;
    silCanvas.height = h;
    silImage = silCtx.createImageData(w, h);
  }
  const px = silImage.data;
  personPixels.length = 0;
  for (let i = 0; i < arr.length; i++) {
    const isPerson = (arr[i] > 127) !== inverted;
    const o = i * 4;
    px[o] = 25;
    px[o + 1] = 0;
    px[o + 2] = 50;
    px[o + 3] = isPerson ? 255 : 0;
    if (isPerson && i % 173 === 0) personPixels.push(i);
  }
  silCtx.putImageData(silImage, 0, 0);
  mask.close?.();
}

function drawPersonAura(now, dt) {
  const target =
    state === "charging"
      ? 0.35 + 0.65 * Math.min(1, (now - chargeStart) / CHARGE_FULL_MS)
      : 0;
  auraStrength += (target - auraStrength) * Math.min(1, dt * 5);
  if (auraStrength < 0.03 || silCanvas.width === 0) return;
  const { ox, oy, dw, dh } = coverRect();
  // 少し拡大した黒紫のシルエットを揺らしながら重ねてオーラにする
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1); // 鏡映しに合わせる
  const flicker = 0.8 + Math.random() * 0.4;
  ctx.filter = `blur(${16 * flicker}px)`;
  ctx.globalAlpha = 0.55 * auraStrength;
  for (let i = 0; i < 2; i++) {
    const s = 1.03 + i * 0.05;
    const jx = (Math.random() - 0.5) * 12;
    const jy = (Math.random() - 0.5) * 12 - i * 8;
    ctx.drawImage(
      silCanvas,
      ox + jx - (dw * (s - 1)) / 2,
      oy + jy - (dh * (s - 1)) / 2,
      dw * s,
      dh * s
    );
  }
  ctx.restore();
  // 体から立ち上る黒炎
  if (auraStrength > 0.1 && personPixels.length > 0) {
    const count = 2 + Math.floor(auraStrength * 5);
    for (let i = 0; i < count; i++) {
      const idx = personPixels[Math.floor(Math.random() * personPixels.length)];
      const nx = (idx % silCanvas.width) / silCanvas.width;
      const ny = Math.floor(idx / silCanvas.width) / silCanvas.height;
      const p = toScreen(nx, ny);
      particles.push({
        x: p.x + (Math.random() - 0.5) * 10,
        y: p.y,
        vx: (Math.random() - 0.5) * 40,
        vy: -60 - Math.random() * 120,
        life: 0.4 + Math.random() * 0.5,
        maxLife: 0.9,
        r: 3 + Math.random() * 6,
        kind: "blackflame",
      });
    }
  }
}

// ---- 邪眼(第三の目) ----
function updateThirdEye(dt) {
  const target = state === "charging" || dragons.length > 0 ? 1 : 0;
  const speed = target > eyeOpen ? 8 : 5; // 開くのは速く、閉じるのはゆっくり
  eyeOpen += (target - eyeOpen) * Math.min(1, dt * speed);
}

function drawThirdEye() {
  if (!face || eyeOpen < 0.02) return;
  const o = Math.pow(eyeOpen, 0.8);
  const w = face.w;
  const h = w * 0.5 * o;
  ctx.save();
  ctx.translate(face.x, face.y);
  ctx.rotate(face.angle);
  // 背後の妖気
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 1.6);
  glow.addColorStop(0, `rgba(130, 50, 220, ${0.35 * o})`);
  glow.addColorStop(1, "rgba(130, 50, 220, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, w * 1.6, 0, Math.PI * 2);
  ctx.fill();
  // まぶた(アーモンド形)で虹彩をクリップ
  ctx.shadowColor = "rgba(160, 80, 255, 0.9)";
  ctx.shadowBlur = 22 * o;
  ctx.beginPath();
  ctx.moveTo(-w, 0);
  ctx.quadraticCurveTo(0, -h * 1.7, w, 0);
  ctx.quadraticCurveTo(0, h * 1.7, -w, 0);
  ctx.closePath();
  ctx.fillStyle = "#12032a";
  ctx.fill();
  ctx.strokeStyle = `rgba(150, 80, 255, ${0.8 * o})`;
  ctx.lineWidth = Math.max(1.5, w * 0.045);
  ctx.stroke();
  ctx.clip();
  // 虹彩(紫の発光)
  const iris = ctx.createRadialGradient(0, 0, h * 0.1, 0, 0, h * 1.15);
  iris.addColorStop(0, "#c07bff");
  iris.addColorStop(0.6, "#5b13b8");
  iris.addColorStop(1, "#1a0533");
  ctx.fillStyle = iris;
  ctx.beginPath();
  ctx.arc(0, 0, h * 1.1, 0, Math.PI * 2);
  ctx.fill();
  // 瞳孔(縦スリット)
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.max(1, w * 0.06), h * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  // ハイライト
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.beginPath();
  ctx.arc(-h * 0.35, -h * 0.35, Math.max(1, h * 0.14), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---- パーティクル ----
function spawnChargeParticles(progress) {
  if (!hand) return;
  const count = 2 + Math.floor(progress * 6);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = hand.auraR * (1.4 + Math.random() * 1.2);
    const px = hand.x + Math.cos(a) * r;
    const py = hand.y + Math.sin(a) * r;
    // 手のひらへ収束
    const sp = 120 + progress * 260;
    particles.push({
      x: px,
      y: py,
      vx: (hand.x - px) / (r / sp),
      vy: (hand.y - py) / (r / sp),
      life: r / sp,
      maxLife: r / sp,
      r: 2 + Math.random() * 5 + progress * 4,
      kind: "charge",
    });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  if (particles.length > 900) particles.splice(0, particles.length - 900);
}

function drawParticles() {
  for (const p of particles) {
    const k = Math.max(0, p.life / p.maxLife);
    ctx.save();
    if (p.kind === "blackflame") {
      ctx.shadowColor = "rgba(130, 50, 255, 0.8)";
      ctx.shadowBlur = 16;
      ctx.fillStyle = `rgba(8, 3, 18, ${0.85 * k})`;
    } else if (p.kind === "charge") {
      ctx.shadowColor = "rgba(160, 80, 255, 0.9)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = `rgba(90, 30, 160, ${0.9 * k})`;
    } else {
      ctx.shadowColor = "rgba(190, 120, 255, 1)";
      ctx.shadowBlur = 18;
      ctx.fillStyle = `rgba(170, 100, 255, ${k})`;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (0.5 + 0.5 * k), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawChargeAura(now) {
  if (state !== "charging" || !hand) return;
  const progress = Math.min(1, (now - chargeStart) / CHARGE_FULL_MS);
  const flicker = 0.85 + Math.random() * 0.3;
  const r = hand.auraR * (0.6 + progress * 0.9) * flicker;
  const g = ctx.createRadialGradient(hand.x, hand.y, r * 0.1, hand.x, hand.y, r);
  g.addColorStop(0, `rgba(20, 5, 40, ${0.9 * progress + 0.1})`);
  g.addColorStop(0.55, `rgba(90, 30, 170, ${0.5 * progress + 0.1})`);
  g.addColorStop(1, "rgba(120, 50, 220, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(hand.x, hand.y, r, 0, Math.PI * 2);
  ctx.fill();
  spawnChargeParticles(progress);
}

function drawRings(dt) {
  for (const ring of rings) {
    ring.r += 1400 * dt;
    ring.alpha -= 2.2 * dt;
    if (ring.alpha <= 0) continue;
    ctx.save();
    ctx.strokeStyle = `rgba(160, 90, 255, ${ring.alpha})`;
    ctx.lineWidth = 6;
    ctx.shadowColor = "rgba(140, 60, 255, 0.9)";
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  rings = rings.filter((ring) => ring.alpha > 0);
}

// ---- メインループ ----
function loop() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // 検出(新しいフレームのときのみ)
  if (handLandmarker && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const handResult = handLandmarker.detectForVideo(video, now);
    const parsedHand = parseHand(handResult);
    if (parsedHand) {
      // 位置は少し平滑化
      if (hand) {
        parsedHand.x = hand.x * 0.5 + parsedHand.x * 0.5;
        parsedHand.y = hand.y * 0.5 + parsedHand.y * 0.5;
      }
      hand = parsedHand;
      handMissFrames = 0;
    } else {
      handMissFrames++;
      if (handMissFrames > HAND_LOST_GRACE) hand = null;
    }
    if (faceLandmarker) {
      const faceResult = faceLandmarker.detectForVideo(video, now);
      const parsedFace = parseFace(faceResult);
      if (parsedFace) {
        if (face) {
          parsedFace.x = face.x * 0.5 + parsedFace.x * 0.5;
          parsedFace.y = face.y * 0.5 + parsedFace.y * 0.5;
          parsedFace.w = face.w * 0.5 + parsedFace.w * 0.5;
        }
        face = parsedFace;
        faceMissFrames = 0;
      } else {
        faceMissFrames++;
        if (faceMissFrames > FACE_LOST_GRACE) face = null;
      }
    }
    updateSegmentation(now);
  }

  updateGesture(now);
  updateThirdEye(dt);

  // 画面の暗転(チャージ・黒龍飛行中に世界が暗くなる)
  let darkTarget = 0;
  if (state === "charging") {
    darkTarget = 0.25 + 0.3 * Math.min(1, (now - chargeStart) / CHARGE_FULL_MS);
  } else if (dragons.length > 0) {
    darkTarget = 0.5;
  }
  darkness += (darkTarget - darkness) * Math.min(1, dt * 6);

  // 画面揺れ
  if (shake > 0.5) {
    stage.style.transform = `translate(${(Math.random() - 0.5) * shake}px, ${(Math.random() - 0.5) * shake}px)`;
    shake *= Math.pow(0.02, dt);
  } else {
    stage.style.transform = "";
    shake = 0;
  }

  // 更新
  for (const d of dragons) d.update(dt);
  dragons = dragons.filter((d) => d.alive);
  // 黒龍が飛び終わったらブラックアウトを予約(着弾フラッシュを見せてから)
  if (hadDragons && dragons.length === 0) blackoutStart = now + 200;
  hadDragons = dragons.length > 0;
  updateParticles(dt);

  // 描画
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (darkness > 0.01) {
    ctx.fillStyle = `rgba(8, 0, 20, ${darkness})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawPersonAura(now, dt);
  drawRings(dt);
  drawChargeAura(now);
  drawParticles();
  for (const d of dragons) d.draw();
  drawThirdEye();
  // 着弾フラッシュ
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(220, 190, 255, ${flash * 0.85})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    flash -= dt * 2.2;
  }
  // ブラックアウト(急速に暗転→少し保持→ゆっくり明ける)
  if (blackoutStart >= 0) {
    const e = (now - blackoutStart) / 1000;
    let a = 0;
    if (e >= 0) {
      if (e < 0.25) a = e / 0.25;
      else if (e < 0.75) a = 1;
      else if (e < 1.55) a = 1 - (e - 0.75) / 0.8;
      else blackoutStart = -1;
    }
    if (a > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${a})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  rafId = requestAnimationFrame(loop);
}

// ---- 終了(Escでスタート画面へ戻る) ----
function stopApp() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  stopChargeSound();
  state = "idle";
  dragons = [];
  particles = [];
  rings = [];
  hand = null;
  face = null;
  shake = 0;
  darkness = 0;
  flash = 0;
  eyeOpen = 0;
  auraStrength = 0;
  blackoutStart = -1;
  hadDragons = false;
  hideKanji();
  stage.style.transform = "";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const stream = video.srcObject;
  if (stream) for (const track of stream.getTracks()) track.stop();
  video.srcObject = null;
  loadingEl.classList.add("hidden");
  overlay.classList.remove("hidden");
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") stopApp();
});

// ---- 初期化 ----
async function setup() {
  loadingEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
  try {
    ensureAudio();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    await createModels();

    overlay.classList.add("hidden");
    loadingEl.classList.add("hidden");
    lastVideoTime = -1;
    lastFrameTime = performance.now();
    running = true;
    rafId = requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    loadingEl.classList.add("hidden");
    errorEl.textContent = `起動に失敗しました: ${e.message ?? e}`;
    errorEl.classList.remove("hidden");
  }
}

// モデルは初回のみ生成(Escで戻って再起動しても再ダウンロードしない)
async function createModels() {
  if (handLandmarker) return;
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  [handLandmarker, faceLandmarker, segmenter] = await Promise.all([
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 1,
      }),
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
      }),
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }),
  ]);
}

startBtn.addEventListener("click", setup);
