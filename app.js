'use strict';

/* ══════════════════════════════════════════════════════════
   設定
   ══════════════════════════════════════════════════════════ */
const CFG = {
  OUT_W: 800,
  OUT_H: 600,
  RATIO: 4 / 3,
  LIMIT: 102400,        // 100 KiB（嚴格小於）
  MIN_COVERAGE: 0.70,   // 主體至少佔裁剪區 70%
  Q_START: 0.85,
  Q_STEP: 0.05,
  Q_FLOOR: 0.30,
  MIN_BOX: 16,          // 原圖座標下的最小主體框邊長
};

/* ══════════════════════════════════════════════════════════
   DOM
   ══════════════════════════════════════════════════════════ */
const $ = (id) => document.getElementById(id);
const el = {
  stageUpload: $('stageUpload'), stageEdit: $('stageEdit'),
  stageBusy: $('stageBusy'), stageResult: $('stageResult'),
  dropzone: $('dropzone'), fileInput: $('fileInput'),
  grid: $('grid'), btnAdd: $('btnAdd'), btnAutoAll: $('btnAutoAll'),
  btnClear: $('btnClear'), btnProcess: $('btnProcess'),
  busyCount: $('busyCount'), busyBar: $('busyBar'),
  tbody: $('tbody'), summary: $('summary'),
  btnReset: $('btnReset'), btnZip: $('btnZip'),
};

/* ══════════════════════════════════════════════════════════
   狀態
   ══════════════════════════════════════════════════════════ */
const state = {
  items: [],      // { id, file, img, box, crop }
  results: [],    // { name, originalSize, blob, quality, checks, ok, coverage, thumbUrl }
  thumbs: [],     // 需要 revoke 的 URL
  nextId: 1,
  busy: false,
};

/* ══════════════════════════════════════════════════════════
   小工具
   ══════════════════════════════════════════════════════════ */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

function showStage(name) {
  el.stageUpload.hidden = name !== 'upload';
  el.stageEdit.hidden   = name !== 'edit';
  el.stageBusy.hidden   = name !== 'busy';
  el.stageResult.hidden = name !== 'result';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════════════
   讀取圖片
   ══════════════════════════════════════════════════════════ */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取：' + file.name)); };
    img.src = url;
  });
}

/* ══════════════════════════════════════════════════════════
   自動偵測主體（純前端：Sobel 能量 + 中心先驗 + 能量分位框）
   ══════════════════════════════════════════════════════════ */
function autoDetectBox(img) {
  const MAXS = 96;
  const ar = img.width / img.height;
  const w = Math.max(8, ar >= 1 ? MAXS : Math.round(MAXS * ar));
  const h = Math.max(8, ar >= 1 ? Math.round(MAXS / ar) : MAXS);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g2 = c.getContext('2d', { willReadFrequently: true });
  g2.drawImage(img, 0, 0, w, h);

  let px;
  try { px = g2.getImageData(0, 0, w, h).data; }
  catch (e) { return null; }              // 跨網域圖片會拋錯

  const N = w * h;
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }

  // Sobel 邊緣能量
  const energy = new Float32Array(N);
  let totalE = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1])
               - (gray[i - w - 1] + 2 * gray[i - 1] + gray[i + w - 1]);
      const gy = (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1])
               - (gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1]);
      const m = Math.hypot(gx, gy);
      energy[i] = m;
      totalE += m;
    }
  }
  if (totalE < 1e-3) return null;         // 純色圖，無法判斷主體

  // 中心先驗：越靠中心的能量權重越高（抑制背景邊緣搶焦）
  const cx0 = (w - 1) / 2, cy0 = (h - 1) / 2;
  const maxD = Math.hypot(cx0, cy0) || 1;
  let sw = 0, sx = 0, sy = 0;
  const pts = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const e = energy[i];
      if (e <= 0) continue;
      const d = Math.hypot(x - cx0, y - cy0) / maxD;
      const wt = e * (1 - 0.55 * d);
      if (wt <= 0) continue;
      sw += wt; sx += x * wt; sy += y * wt;
      pts.push([x, y, wt]);
    }
  }
  const cx = sx / sw, cy = sy / sw;

  // 依到質心距離排序，取累積 62% 能量的半徑
  pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  let acc = 0, R = 1;
  const target = sw * 0.62;
  for (let i = 0; i < pts.length; i++) {
    acc += pts[i][2];
    if (acc >= target) { R = Math.hypot(pts[i][0] - cx, pts[i][1] - cy); break; }
  }
  R = Math.max(R, Math.min(w, h) * 0.12);

  // 換算回原圖座標
  const k = img.width / w;
  let bx = (cx - R) * k;
  let by = (cy - R) * k;
  let bw = 2 * R * k;
  let bh = 2 * R * k;

  // 比例限制在 [0.72, 1.45]，避免過於細長導致無法達到 70%
  const ratio = bw / bh;
  if (ratio < 0.72) {
    const nw = bh * 0.72;
    bx -= (nw - bw) / 2; bw = nw;
  } else if (ratio > 1.45) {
    const nh = bw / 1.45;
    by -= (nh - bh) / 2; bh = nh;
  }

  // 夾回圖片內
  bx = clamp(bx, 0, img.width - 1);
  by = clamp(by, 0, img.height - 1);
  bw = Math.min(bw, img.width - bx);
  bh = Math.min(bh, img.height - by);

  return { x: bx, y: by, w: bw, h: bh };
}

/* ══════════════════════════════════════════════════════════
   核心：由主體框推算 4:3 裁剪區
   ── 條件：4:3、完整包含主體框、主體居中、主體佔比 ≥ 70%
   ══════════════════════════════════════════════════════════ */
function computeCrop(imgW, imgH, box) {
  const w = Math.max(1, box.w);
  const h = Math.max(1, box.h);
  const cx = box.x + w / 2;
  const cy = box.y + h / 2;

  // 4:3 框要完整包含主體框，所需的最小高度：
  //   H ≥ h  且  H·(4/3) ≥ w  →  H ≥ max(h, 0.75w)
  const H = Math.max(h, w * 0.75);
  const W = H * (4 / 3);

  // 以主體中心為中心
  const sx = cx - W / 2;
  const sy = cy - H / 2;

  // 邊界檢查（不允許平移，否則主體就不居中了）
  if (sx < -0.5 || sy < -0.5 || sx + W > imgW + 0.5 || sy + H > imgH + 0.5) {
    return { ok: false, reason: '主體太靠近畫面邊緣，居中裁剪會超出影像範圍' };
  }

  // 佔比
  const coverage = (w * h) / (W * H);
  if (coverage < CFG.MIN_COVERAGE - 1e-9) {
    return {
      ok: false,
      reason: `主體僅佔 ${(coverage * 100).toFixed(0)}%，低於 70%（主體框過於細長或過小）`,
    };
  }

  // 居中偏差（理論上為 0，仍做數值驗證）
  const devX = Math.abs((sx + W / 2) - cx);
  const devY = Math.abs((sy + H / 2) - cy);

  return {
    ok: true,
    sx, sy, sw: W, sh: H,
    coverage,
    deviation: Math.max(devX, devY),
    upscale: Math.max(W / imgW, H / imgH) < 1 ? 0 : 1, // 佔位，下面另算
  };
}

/* ══════════════════════════════════════════════════════════
   畫面繪製
   ══════════════════════════════════════════════════════════ */
function layoutCanvas(it, canvas, stage) {
  const cssW = Math.max(120, stage.clientWidth || 320);
  const ar = it.img.width / it.img.height;
  const cssH = Math.round(cssW / ar);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  it._view = {
    cssW, cssH, dpr,
    scale: canvas.width / it.img.width,   // 原圖 px → canvas px
    cssScale: cssW / it.img.width,        // 原圖 px → CSS px
  };
}

function drawItem(it, canvas) {
  const v = it._view;
  if (!v) return;
  const ctx = canvas.getContext('2d');
  const CW = canvas.width, CH = canvas.height;

  ctx.clearRect(0, 0, CW, CH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(it.img, 0, 0, CW, CH);

  const s = v.scale;
  const crop = it.crop;
  const boxOk = crop && crop.ok;

  // ── 裁剪區外暗化 + 白框 + 三分線
  if (boxOk) {
    const L = crop.sx * s, T = crop.sy * s, W = crop.sw * s, H = crop.sh * s;

    ctx.fillStyle = 'rgba(2,6,23,0.58)';
    ctx.fillRect(0, 0, CW, T);
    ctx.fillRect(0, T + H, CW, Math.max(0, CH - T - H));
    ctx.fillRect(0, T, Math.max(0, L), H);
    ctx.fillRect(L + W, T, Math.max(0, CW - L - W), H);

    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(1, v.dpr);
    ctx.strokeRect(L, T, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.26)';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(L + (W * i) / 3, T); ctx.lineTo(L + (W * i) / 3, T + H);
      ctx.moveTo(L, T + (H * i) / 3); ctx.lineTo(L + W, T + (H * i) / 3);
    }
    ctx.stroke();
  }

  // ── 主體框
  const b = it.box;
  const bx = b.x * s, by = b.y * s, bw = b.w * s, bh = b.h * s;
  const accent = boxOk ? '#3b82f6' : '#ef4444';

  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(2, 2 * v.dpr);
  ctx.setLineDash([]);
  ctx.strokeRect(bx, by, bw, bh);

  // ── 四角把手
  const r = Math.max(4, 5 * v.dpr);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1.5, 1.5 * v.dpr);
  const corners = [
    [bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh],
  ];
  for (const [x, y] of corners) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/* ══════════════════════════════════════════════════════════
   拖曳互動
   ══════════════════════════════════════════════════════════ */
function hitTest(it, px, py) {
  const b = it.box;
  const tol = 14 / (it._view ? it._view.cssScale : 1); // 14 CSS px 容差 → 原圖 px
  const corners = [
    ['nw', b.x, b.y],
    ['ne', b.x + b.w, b.y],
    ['sw', b.x, b.y + b.h],
    ['se', b.x + b.w, b.y + b.h],
  ];
  for (const [key, x, y] of corners) {
    if (Math.abs(px - x) <= tol && Math.abs(py - y) <= tol) return key;
  }
  if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return 'move';
  return null;
}

function cursorFor(mode) {
  if (mode === 'move') return 'move';
  if (mode === 'nw' || mode === 'se') return 'nwse-resize';
  if (mode === 'ne' || mode === 'sw') return 'nesw-resize';
  return 'default';
}

function bindDrag(it, canvas, stage) {
  let mode = null;
  let start = null;

  const toImg = (ev) => {
    const r = canvas.getBoundingClientRect();
    const v = it._view;
    return {
      x: ((ev.clientX - r.left) / r.width) * it.img.width,
      y: ((ev.clientY - r.top) / r.height) * it.img.height,
    };
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (state.busy) return;
    const p = toImg(ev);
    const hit = hitTest(it, p.x, p.y);
    if (!hit) return;
    ev.preventDefault();
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    mode = hit;
    start = { p, box: { ...it.box } };
    canvas.style.cursor = cursorFor(mode);
  });

  canvas.addEventListener('pointermove', (ev) => {
    const v = it._view;
    if (!v) return;

    if (!mode) {
      const p = toImg(ev);
      canvas.style.cursor = cursorFor(hitTest(it, p.x, p.y));
      return;
    }

    ev.preventDefault();
    const p = toImg(ev);
    const dx = p.x - start.p.x;
    const dy = p.y - start.p.y;
    const b0 = start.box;
    const IW = it.img.width, IH = it.img.height;
    const MIN = Math.min(CFG.MIN_BOX, IW, IH);

    let b;
    if (mode === 'move') {
      b = {
        x: clamp(b0.x + dx, 0, IW - b0.w),
        y: clamp(b0.y + dy, 0, IH - b0.h),
        w: b0.w, h: b0.h,
      };
    } else {
      let x1 = b0.x, y1 = b0.y;
      let x2 = b0.x + b0.w, y2 = b0.y + b0.h;
      const vKey = mode[0]; // 'n' | 's'
      const hKey = mode[1]; // 'w' | 'e'
      if (hKey === 'w') x1 = clamp(b0.x + dx, 0, x2 - MIN);
      if (hKey === 'e') x2 = clamp(b0.x + b0.w + dx, x1 + MIN, IW);
      if (vKey === 'n') y1 = clamp(b0.y + dy, 0, y2 - MIN);
      if (vKey === 's') y2 = clamp(b0.y + b0.h + dy, y1 + MIN, IH);
      b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    it.box = b;
    it.crop = computeCrop(IW, IH, b);
    drawItem(it, canvas);
    const card = canvas.closest('.item');
    updateFoot(it, card.querySelector('.item-foot'));
  });

  const end = (ev) => {
    if (!mode) return;
    mode = null;
    start = null;
    canvas.style.cursor = 'default';
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', () => { mode = null; start = null; });
}

/* ══════════════════════════════════════════════════════════
   卡片渲染
   ══════════════════════════════════════════════════════════ */
function updateFoot(it, footEl) {
  if (!footEl) return;
  const c = it.crop;
  if (!c || !c.ok) {
    footEl.className = 'item-foot err';
    footEl.textContent = '⚠ ' + ((c && c.reason) || '尚未框選主體');
  } else {
    footEl.className = 'item-foot ok';
    footEl.textContent =
      `主體佔比 ${(c.coverage * 100).toFixed(0)}% · 裁剪區 ${Math.round(c.sw)}×${Math.round(c.sh)}` +
      (c.sw < CFG.OUT_W * 0.6 ? ' · 原圖偏小，放大後可能略模糊' : '');
  }
  updateProcessBtn();
}

function updateProcessBtn() {
  const okCount = state.items.filter((it) => it.crop && it.crop.ok).length;
  const total = state.items.length;
  el.btnProcess.disabled = okCount === 0 || state.busy;
  el.btnProcess.textContent = total === 0
    ? '開始處理'
    : `開始處理（${okCount} / ${total} 張符合條件）`;
}

function renderGrid() {
  el.grid.innerHTML = '';

  if (state.items.length === 0) {
    showStage('upload');
    return;
  }

  for (const it of state.items) {
    const card = document.createElement('div');
    card.className = 'item';
    card.dataset.id = String(it.id);

    // 標題列
    const head = document.createElement('div');
    head.className = 'item-head';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = it.file.name;
    name.title = it.file.name;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.title = '移除這張';
    del.textContent = '✕';
    del.addEventListener('click', () => removeItem(it.id));
    head.append(name, del);

    // 畫布
    const stage = document.createElement('div');
    stage.className = 'stage';
    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);

    // 狀態列
    const foot = document.createElement('div');
    foot.className = 'item-foot';

    card.append(head, stage, foot);
    el.grid.appendChild(card);

    // 等瀏覽器完成佈局再繪製
    requestAnimationFrame(() => {
      it.crop = computeCrop(it.img.width, it.img.height, it.box);
      layoutCanvas(it, canvas, stage);
      drawItem(it, canvas);
      updateFoot(it, foot);
      bindDrag(it, canvas, stage);
    });
  }

  showStage('edit');
  updateProcessBtn();
}

function removeItem(id) {
  const idx = state.items.findIndex((x) => x.id === id);
  if (idx < 0) return;
  state.items.splice(idx, 1);
  renderGrid();
}

/* ══════════════════════════════════════════════════════════
   加入檔案
   ══════════════════════════════════════════════════════════ */
async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;

  el.dropzone.classList.add('over');

  for (const file of files) {
    try {
      const img = await loadImage(file);
      const box = autoDetectBox(img) || {
        x: img.width * 0.15,
        y: img.height * 0.15,
        w: img.width * 0.7,
        h: img.height * 0.7,
      };
      state.items.push({ id: state.nextId++, file, img, box, crop: null });
    } catch (err) {
      console.warn(err);
    }
  }

  el.dropzone.classList.remove('over');
  el.fileInput.value = '';
  renderGrid();
}

/* ══════════════════════════════════════════════════════════
   壓縮：先線性降質（0.85 → 0.30，每次 −0.05），
        仍超標再二分搜尋
   ══════════════════════════════════════════════════════════ */
function toJpegBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
}

async function encodeUnderLimit(canvas) {
  // 1) 線性掃描
  for (let q = CFG.Q_START; q >= CFG.Q_FLOOR - 1e-9; q -= CFG.Q_STEP) {
    const qq = Math.max(q, 0.01);
    const blob = await toJpegBlob(canvas, qq);
    if (blob && blob.size < CFG.LIMIT) {
      return { blob, quality: qq, ok: true };
    }
  }

  // 2) 二分搜尋（品質越低檔案越小，單調可二分）
  let lo = 0.02;
  let hi = CFG.Q_FLOOR;
  let best = null;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const blob = await toJpegBlob(canvas, mid);
    if (blob && blob.size < CFG.LIMIT) {
      best = { blob, quality: mid, ok: true };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (best) return best;

  // 3) 極限仍無法達標
  const blob = await toJpegBlob(canvas, 0.02);
  return { blob, quality: 0.02, ok: !!(blob && blob.size < CFG.LIMIT) };
}

/* ══════════════════════════════════════════════════════════
   驗證
   ══════════════════════════════════════════════════════════ */
async function isJpegBlob(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch (_) {
    return false;
  }
}

async function verifyResult(blob, canvas, crop) {
  const checks = [];

  // ① 格式：JPG（以 magic number 驗證，不只看 MIME）
  const jpeg = await isJpegBlob(blob);
  checks.push({ key: 'fmt', label: 'JPG', ok: jpeg, detail: jpeg ? 'image/jpeg' : '格式不符' });

  // ② 尺寸：精確 800×600
  const sizeOk = canvas.width === CFG.OUT_W && canvas.height === CFG.OUT_H;
  checks.push({
    key: 'size', label: '800×600', ok: sizeOk,
    detail: `${canvas.width}×${canvas.height}`,
  });

  // ③ 檔案大小：嚴格小於 100 KiB
  const limitOk = blob.size < CFG.LIMIT;
  checks.push({ key: 'limit', label: '<100KB', ok: limitOk, detail: fmtBytes(blob.size) });

  // ④ 主體佔比 ≥ 70%
  const coverOk = crop.coverage >= CFG.MIN_COVERAGE - 1e-9;
  checks.push({
    key: 'cover', label: '佔比≥70%', ok: coverOk,
    detail: (crop.coverage * 100).toFixed(1) + '%',
  });

  // ⑤ 主體居中（偏差 < 0.5 原圖 px）
  const centerOk = crop.deviation < 0.5;
  checks.push({
    key: 'center', label: '主體居中', ok: centerOk,
    detail: '偏差 ' + crop.deviation.toFixed(2) + 'px',
  });

  return checks;
}

/* ══════════════════════════════════════════════════════════
   批次處理
   ══════════════════════════════════════════════════════════ */
async function processAll() {
  const list = state.items.filter((it) => it.crop && it.crop.ok);
  if (list.length === 0 || state.busy) return;

  state.busy = true;
  updateProcessBtn();
  showStage('busy');

  state.results.forEach((r) => r.thumbUrl && URL.revokeObjectURL(r.thumbUrl));
  state.results = [];
  state.thumbs = [];

  const total = list.length;
  let done = 0;
  el.busyCount.textContent = `0 / ${total}`;
  el.busyBar.style.width = '0%';

  for (const it of list) {
    try {
      const crop = it.crop;

      // 離屏畫布：高品質縮放到 800×600
      const off = document.createElement('canvas');
      off.width = CFG.OUT_W;
      off.height = CFG.OUT_H;
      const octx = off.getContext('2d');
      octx.fillStyle = '#ffffff';                       // JPG 無透明，先鋪白底
      octx.fillRect(0, 0, off.width, off.height);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(
        it.img,
        crop.sx, crop.sy, crop.sw, crop.sh,
        0, 0, CFG.OUT_W, CFG.OUT_H
      );

      // 壓到 100KB 以下
      const enc = await encodeUnderLimit(off);

      // 驗證
      const checks = await verifyResult(enc.blob, off, crop);
      const allOk = checks.every((c) => c.ok);

      const thumbUrl = URL.createObjectURL(enc.blob);
      state.thumbs.push(thumbUrl);

      state.results.push({
        name: it.file.name,
        originalSize: it.file.size,
        blob: enc.blob,
        quality: enc.quality,
        checks,
        allOk,
        coverage: crop.coverage,
        thumbUrl,
      });
    } catch (err) {
      console.error('處理失敗：', it.file.name, err);
      state.results.push({
        name: it.file.name,
        originalSize: it.file.size,
        blob: null,
        quality: 0,
        checks: [{ key: 'err', label: '錯誤', ok: false, detail: String(err.message || err) }],
        allOk: false,
        coverage: 0,
        thumbUrl: '',
      });
    }

    done++;
    el.busyCount.textContent = `${done} / ${total}`;
    el.busyBar.style.width = `${(done / total) * 100}%`;
  }

  state.busy = false;
  renderResults();
  showStage('result');
}

/* ══════════════════════════════════════════════════════════
   結果表
   ══════════════════════════════════════════════════════════ */
function renderResults() {
  el.tbody.innerHTML = '';

  const okCount = state.results.filter((r) => r.allOk).length;
  el.summary.textContent = `共 ${state.results.length} 張，通過 ${okCount} 張`;

  for (let i = 0; i < state.results.length; i++) {
    const r = state.results[i];
    const tr = document.createElement('tr');

    const tdThumb = document.createElement('td');
    if (r.thumbUrl) {
      const img = document.createElement('img');
      img.src = r.thumbUrl;
      img.alt = r.name;
      tdThumb.appendChild(img);
    } else {
      tdThumb.textContent = '—';
    }

    const tdName = document.createElement('td');
    const spanName = document.createElement('div');
    spanName.className = 'fname';
    spanName.textContent = r.name;
    spanName.title = r.name;
    tdName.appendChild(spanName);

    const tdOrig = document.createElement('td');
    tdOrig.textContent = fmtBytes(r.originalSize);

    const tdNew = document.createElement('td');
    tdNew.className = r.allOk ? 'big-ok' : 'big-bad';
    tdNew.textContent = r.blob ? fmtBytes(r.blob.size) : '—';

    const tdCover = document.createElement('td');
    tdCover.textContent = (r.coverage * 100).toFixed(0) + '%';

    const tdChecks = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill ' + (r.allOk ? 'y' : 'n');
    pill.textContent = r.allOk ? '通過' : '未通過';
    tdChecks.appendChild(pill);

    const wrap = document.createElement('div');
    wrap.style.marginTop = '4px';
    for (const c of r.checks) {
      const s = document.createElement('span');
      s.className = 'chk ' + (c.ok ? 'y' : 'n');
      s.textContent = (c.ok ? '✓' : '✕') + ' ' + c.label;
      s.title = c.detail;
      wrap.appendChild(s);
    }
    tdChecks.appendChild(wrap);

    const tdAct = document.createElement('td');
    if (r.allOk && r.blob) {
      const a = document.createElement('a');
      a.className = 'btn sm ghost';
      a.style.textDecoration = 'none';
      a.href = r.thumbUrl;
      a.download = zipNameFor(r.name, i);
      a.textContent = '下載';
      tdAct.appendChild(a);
    }

    tr.append(tdThumb, tdName, tdOrig, tdNew, tdCover, tdChecks, tdAct);
    el.tbody.appendChild(tr);
  }

  el.btnZip.disabled = okCount === 0;
  el.btnZip.textContent = okCount === 0
    ? '沒有可下載的圖片'
    : `下載全部（ZIP · ${okCount} 張）`;
}

/* ══════════════════════════════════════════════════════════
   ZIP 打包（內建 store 模式，零依賴、離線可用）
   ══════════════════════════════════════════════════════════ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time: time & 0xffff, date: date & 0xffff };
}

async function buildZip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = new Uint8Array(await e.blob.arrayBuffer());
    const crc = crc32(data);

    // Local file header (30 + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0x0800, true);    // UTF-8 檔名
    lv.setUint16(8, 0, true);         // method 0 = store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);        // extra len
    lh.set(nameBytes, 30);

    locals.push(lh, data);

    // Central directory record (46 + name)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);        // version made by
    cv.setUint16(6, 20, true);        // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);        // extra
    cv.setUint16(32, 0, true);        // comment
    cv.setUint16(34, 0, true);        // disk
    cv.setUint16(36, 0, true);        // internal attrs
    cv.setUint32(38, 0, true);        // external attrs
    cv.setUint32(42, offset, true);   // local header offset
    ch.set(nameBytes, 46);

    centrals.push(ch);
    offset += lh.length + data.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...locals, ...centrals, eocd], { type: 'application/zip' });
}

function zipNameFor(name, index) {
  const dot = name.lastIndexOf('.');
  const base = (dot > 0 ? name.slice(0, dot) : name) || `image_${index + 1}`;
  return `${base}_800x600.jpg`;
}

async function downloadZip() {
  const okList = state.results.filter((r) => r.allOk && r.blob);
  if (okList.length === 0) return;

  const btnText = el.btnZip.textContent;
  el.btnZip.disabled = true;
  el.btnZip.textContent = '打包中…';

  try {
    const used = new Map();
    const entries = okList.map((r, i) => {
      let name = zipNameFor(r.name, i);
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        name = name.replace(/\.jpg$/i, `_${n}.jpg`);
      } else {
        used.set(name, 0);
      }
      return { name, blob: r.blob };
    });

    const zipBlob = await buildZip(entries);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'optimized_800x600.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    console.error('ZIP 失敗：', err);
    alert('打包 ZIP 時發生錯誤，請改用單張下載。');
  } finally {
    el.btnZip.disabled = false;
    el.btnZip.textContent = btnText;
  }
}

/* ══════════════════════════════════════════════════════════
   重置
   ══════════════════════════════════════════════════════════ */
function resetAll() {
  state.thumbs.forEach((u) => URL.revokeObjectURL(u));
  state.thumbs = [];
  state.results = [];
  state.items = [];
  state.busy = false;
  el.fileInput.value = '';
  el.grid.innerHTML = '';
  el.tbody.innerHTML = '';
  el.busyBar.style.width = '0%';
  showStage('upload');
}

/* ══════════════════════════════════════════════════════════
   事件綁定
   ══════════════════════════════════════════════════════════ */
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});

el.fileInput.addEventListener('change', (e) => addFiles(e.target.files));

['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('over');
  })
);
['dragleave', 'dragend'].forEach((ev) =>
  el.dropzone.addEventListener(ev, () => el.dropzone.classList.remove('over'))
);
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('over');
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// 全域拖放（避免瀏覽器直接開啟檔案）
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// 貼上
document.addEventListener('paste', (e) => {
  const files = [];
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) { e.preventDefault(); addFiles(files); }
});

el.btnAdd.addEventListener('click', () => el.fileInput.click());

el.btnAutoAll.addEventListener('click', () => {
  for (const it of state.items) {
    const box = autoDetectBox(it.img);
    if (box) it.box = box;
  }
  renderGrid();
});

el.btnClear.addEventListener('click', resetAll);
el.btnProcess.addEventListener('click', processAll);
el.btnReset.addEventListener('click', resetAll);
el.btnZip.addEventListener('click', downloadZip);

// 視窗尺寸變化 → 重繪
let rzTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    for (const it of state.items) {
      const card = el.grid.querySelector(`.item[data-id="${it.id}"]`);
      if (!card) continue;
      const canvas = card.querySelector('canvas');
      const stage = card.querySelector('.stage');
      layoutCanvas(it, canvas, stage);
      drawItem(it, canvas);
    }
  }, 160);
});

/* ══════════════════════════════════════════════════════════
   PWA：註冊 Service Worker
   ══════════════════════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service Worker 註冊失敗：', err);
    });
  });
}
