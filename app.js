'use strict';

/* ============ DOM ============ */
const $ = sel => document.querySelector(sel);
const pickPanel = $('#pickPanel');
const editToolbar = $('#editToolbar');
const editStage = $('#editStage');
const editFooter = $('#editFooter');
const cv = $('#cv');
const ctx = cv.getContext('2d');
const uploadBtn = $('#uploadBtn');

const fileInput = $('#fileInput');   // 拍照
const fileInput2 = $('#fileInput2'); // 相册

/* ============ 状态 ============ */
let srcImg = null;      // 原始 Image 对象
let boxes = [];         // 已确认的框（原图坐标）{x,y,w,h}
let drawing = null;     // 正在拖拽的框
let uploading = false;

/* ===== 视图变换 =====
   baseScale: 适应屏幕时的缩放（基准像素 / 原图像素）
   baseW/baseH: canvas 的布局尺寸（= 适应屏幕尺寸），恒定不变
   zoom: 用户缩放倍数，1 = 适应屏幕
   tx/ty: 视口左上角对应的「缩放后内容坐标」

   映射关系：内容基准坐标 b → 视口坐标 screen：
       screenX = b.x * zoom - tx
       screenY = b.y * zoom - ty
   反解（视口坐标 → 内容基准坐标）见 toBase()。

   关键：手势进行中只改 CSS transform（GPU 合成层的矩阵变换，
   不触发重排、不重采样位图、浮点矩阵无取整量化），松手后再按
   最终 zoom 重建一次高清缓冲区。此前「改 CSS 宽高拉伸旧位图」
   的预览方式会让浏览器每帧用不同比例重采样，是抖动的根源。 */
let baseScale = 1;
let baseW = 0, baseH = 0;
let zoom = 1;
let targetZoom = 1;      // 手势目标缩放，zoom 平滑跟随它（抑制手指坐标量化噪声）
let tx = 0, ty = 0;
let viewW = 0, viewH = 0;   // wrap 视口尺寸（不含 border）
let renderDpr = 1;          // 实际渲染用的 DPR（受像素上限约束）

const wrapEl = cv.parentElement;

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;     // 按钮档位缩放步长
/* 缩放一阶低通系数：1 = 完全跟手（手指抖动原样放大），0 = 不动。
   0.5 在 60fps 下时间常数约 33ms，既压掉高频噪声又不影响跟手感。 */
const ZOOM_SMOOTH = 0.5;
/* 框选最小边长。必须用「屏幕 CSS 像素」判断——用原图坐标判断时，
   手机照片原图动辄 3000px，屏幕上 200px 的框换算后不足阈值会被误当误触丢弃。 */
const MIN_BOX_PX = 24;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024; // iOS Safari canvas 像素上限

/* 单指操作模式：select = 画框；pan = 移动画面。
   canvas 需 touch-action:none 才能让画框不被系统手势打断，
   代价是长图/放大后单指无法滚动查看，故用模式切换补齐。 */
let mode = 'select';

/* ============ 选图 ============ */
$('#cameraBtn').addEventListener('click', () => fileInput.click());
$('#albumBtn').addEventListener('click', () => fileInput2.click());
$('#reselectBtn').addEventListener('click', () => { resetAll(); fileInput.click(); });

fileInput.addEventListener('change', e => onPick(e.target));
fileInput2.addEventListener('change', e => onPick(e.target));

function onPick(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => { setupImage(img); };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function setupImage(img) {
  srcImg = img;
  boxes = [];
  drawing = null;
  zoom = 1;

  // 关键：必须先显示面板，隐藏元素的 clientWidth 为 0 会导致 canvas 尺寸算成 0
  pickPanel.hidden = true;
  editToolbar.hidden = false;
  editStage.hidden = false;
  editFooter.hidden = false;

  // 按容器宽度铺满显示（不按高度压缩，避免图片被缩得太小；超长图靠滚动查看）
  const availW = cv.parentElement.clientWidth || (window.innerWidth - 40);
  const maxW = Math.max(240, Math.min(availW, 1200));
  const maxH = 1400; // 仅防止极端长图

  let w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) { w = 800; h = 600; }

  let s = Math.min(maxW / w, 1);
  if (h * s > maxH) s = maxH / h;

  baseScale = s;
  baseW = Math.max(1, Math.round(w * s));
  baseH = Math.max(1, Math.round(h * s));

  zoom = 1; targetZoom = 1; tx = 0; ty = 0;
  clampView();
  applyView(false);
  rebuildBuffer();
  syncBoxes();

  // 回到页面顶部：工具条吸顶、图片顶部对齐，方便立即框选
  window.scrollTo(0, 0);
}

/* 按当前 zoom 重建 canvas 缓冲区。
   物理像素 = 布局尺寸 × 有效 DPR —— 这是清晰度的关键：手机 DPR 常为 3，
   若只按 CSS 尺寸建画布，浏览器会把画布拉伸到 3 倍显示，必然模糊。
   放大时同步抬高 DPR，保证放大后依然清晰（受 iOS canvas 像素上限约束）。
   注意：手势进行中不调用它，只做 CSS transform 预览。 */
function rebuildBuffer() {
  let dpr = Math.min((window.devicePixelRatio || 1) * Math.min(zoom, 2), 3);
  if (baseW * dpr * baseH * dpr > MAX_CANVAS_PIXELS) {
    dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (baseW * baseH)));
  }
  renderDpr = dpr;

  cv.width = Math.max(1, Math.round(baseW * dpr));
  cv.height = Math.max(1, Math.round(baseH * dpr));
  // 布局尺寸恒定 = 适应屏幕尺寸，缩放完全交给 transform
  cv.style.width = baseW + 'px';
  cv.style.height = baseH + 'px';

  baseDirty = true;   // DPR 变了，离屏层尺寸需同步重建
  draw();
}

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function updateZoomLabel() {
  const label = document.getElementById('zoomLabel');
  if (label) label.textContent = Math.round(zoom * 100) + '%';
}

/* 视口坐标（clientX/Y）→ 内容基准坐标 */
function toBase(clientX, clientY) {
  const r = wrapEl.getBoundingClientRect();
  // clientLeft/clientTop = border 宽度：矩形原点在 border 外沿，内容区需扣除
  return {
    x: (clientX - r.left - wrapEl.clientLeft + tx) / zoom,
    y: (clientY - r.top - wrapEl.clientTop + ty) / zoom
  };
}

/* 把 tx/ty 约束在内容范围内，避免把画面拖出视口留下空白 */
function clampView() {
  viewW = wrapEl.clientWidth;
  viewH = wrapEl.clientHeight;
  tx = Math.min(Math.max(0, baseW * zoom - viewW), Math.max(0, tx));
  ty = Math.min(Math.max(0, baseH * zoom - viewH), Math.max(0, ty));
}

/* 应用视图变换。
   anim=true：保留 CSS 过渡，用于按钮档位缩放（220ms 平滑动画，绝对不抖）
   anim=false：禁用过渡（dragging class），用于手势跟手，过渡会引入迟滞抖动 */
function applyView(anim) {
  cv.classList.toggle('dragging', !anim);
  cv.style.transform = `translate(${-tx}px, ${-ty}px) scale(${zoom})`;
  updateZoomLabel();
}

/* 以视口内某点为锚点缩放，保持该点下的内容位置不变。
   anchorVX/VY 为相对 wrap 内容区左上角的视口坐标，缺省取视口中心。
   anim=true 用于按钮缩放，此时不重建缓冲区（等过渡结束后再补高清）。 */
function setZoom(next, anchorVX, anchorVY, anim) {
  const z = clampZoom(next);
  const ax = (anchorVX === undefined ? wrapEl.clientWidth / 2 : anchorVX);
  const ay = (anchorVY === undefined ? wrapEl.clientHeight / 2 : anchorVY);

  // 锚点对应的内容基准坐标（用变换前的 zoom 反解）
  const bx = (ax + tx) / zoom;
  const by = (ay + ty) / zoom;

  zoom = z;
  targetZoom = z;
  tx = bx * zoom - ax;
  ty = by * zoom - ay;
  clampView();
  applyView(anim);
  if (!anim) rebuildBuffer();
}

function resetAll() {
  srcImg = null; boxes = []; drawing = null;
  pinchLast = null; wasPinchGesture = false; pointers.clear();
  pending.mode = 'draw'; pending.scale = 1; pending.dx = 0; pending.dy = 0;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  zoom = 1; targetZoom = 1; tx = 0; ty = 0;
  syncBoxes();
  editToolbar.hidden = true;
  editStage.hidden = true;
  editFooter.hidden = true;
  pickPanel.hidden = false;
}

/* ============ 框选交互 ============ */
/* 内容基准坐标 → 原图坐标（基准坐标只经过 baseScale，与 zoom 无关） */
function toImg(p) {
  return { x: p.x / baseScale, y: p.y / baseScale };
}

/* ===== 多指手势：单指画框，双指缩放 + 平移 =====
   所有事件只把增量累积进 pending，由 rAF 在下一帧统一应用一次，
   避免 120Hz 下每帧重复计算；缩放与平移在同一个矩阵里一次算完，
   不再分两步改 scroll，杜绝误差叠加。 */
const pointers = new Map();   // pointerId -> {x,y}（wrap 视口坐标）
let pinchLast = null;         // 上一次事件时的双指状态
/* 本次手势是否经历过双指。不能靠 pinchLast 判断：两指先后抬起时，
   先抬起的那根会把 pinchLast 清空，导致最后一根抬起时误判为单指手势，
   从而跳过松手后的高清重建，画面会一直停留在拉伸的模糊纹理上。 */
let wasPinchGesture = false;
let rafId = null;
const pending = { mode: 'draw', scale: 1, dx: 0, dy: 0, cx: 0, cy: 0, x: 0, y: 0 };

/* clientX/Y → wrap 视口坐标（左上角为原点，不含 border） */
function viewportPos(e) {
  const r = wrapEl.getBoundingClientRect();
  return {
    x: e.clientX - r.left - wrapEl.clientLeft,
    y: e.clientY - r.top - wrapEl.clientTop
  };
}

function pinchInfo() {
  const p = Array.from(pointers.values());
  return {
    dist: Math.max(1, Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)),
    cx: (p[0].x + p[1].x) / 2,
    cy: (p[0].y + p[1].y) / 2
  };
}

function scheduleApply() {
  if (rafId === null) rafId = requestAnimationFrame(applyPending);
}

/* 把累积的增量一次性应用到视图。
   顺序很重要：先平移、再以「最新双指中心」为锚点缩放。
   这样双指中心下的内容点天然保持不动，缩放与平移一次算完。 */
function applyPending() {
  rafId = null;
  if (!srcImg) return;
  const p = pending;

  if (p.mode === 'draw') {
    if (drawing) { drawing.x1 = p.x; drawing.y1 = p.y; draw(); }
    return;
  }

  // 平移：内容跟随手指（视口原点对应的内容点反向移动）
  tx -= p.dx;
  ty -= p.dy;

  if (p.mode === 'pinch') {
    // 缩放：一阶低通跟随 targetZoom，抑制触摸坐标量化带来的高频抖动
    targetZoom = clampZoom(targetZoom * p.scale);
    const next = zoom + (targetZoom - zoom) * ZOOM_SMOOTH;
    const bx = (p.cx + tx) / zoom;   // 用变换前的 zoom 反解锚点
    const by = (p.cy + ty) / zoom;
    zoom = next;
    tx = bx * zoom - p.cx;
    ty = by * zoom - p.cy;
  }

  clampView();
  applyView(false);
  p.scale = 1; p.dx = 0; p.dy = 0;
}

cv.addEventListener('pointerdown', e => {
  if (!srcImg || uploading) return;
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}

  /* 删除按钮优先于画框/平移：命中即删除，且不把该指针记入手势集合，
     否则抬起时会被当成一次画框或平移，产生多余的空框。 */
  const hit = hitDelete(toBase(e.clientX, e.clientY));
  if (hit >= 0) {
    boxes.splice(hit, 1);
    syncBoxes();
    draw();
    return;
  }

  const p = viewportPos(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 1) {
    pending.mode = (mode === 'pan') ? 'pan' : 'draw';
    pending.scale = 1; pending.dx = 0; pending.dy = 0;
    if (mode === 'select') {
      const b = toBase(e.clientX, e.clientY);
      drawing = { x0: b.x, y0: b.y, x1: b.x, y1: b.y };
      pending.x = b.x; pending.y = b.y;
    }
  } else if (pointers.size === 2) {
    drawing = null;          // 转为缩放手势，放弃正在画的框
    pending.mode = 'pinch';
    pending.scale = 1; pending.dx = 0; pending.dy = 0;
    wasPinchGesture = true;
    pinchLast = pinchInfo();
    pending.cx = pinchLast.cx; pending.cy = pinchLast.cy;
    targetZoom = zoom;
    draw();
  }
});

cv.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();
  const prev = pointers.get(e.pointerId);
  const now = viewportPos(e);
  pointers.set(e.pointerId, now);

  if (pointers.size >= 2) {
    if (!pinchLast) { pinchLast = pinchInfo(); return; }
    const cur = pinchInfo();
    // 只累积增量：一帧内多个 move 事件会被 rAF 合并成一次变换
    pending.mode = 'pinch';
    pending.dx += cur.cx - pinchLast.cx;
    pending.dy += cur.cy - pinchLast.cy;
    pending.scale *= cur.dist / pinchLast.dist;
    pending.cx = cur.cx; pending.cy = cur.cy;
    pinchLast = cur;
  } else if (pointers.size === 1) {
    if (pending.mode === 'pan') {
      pending.dx += now.x - prev.x;
      pending.dy += now.y - prev.y;
    } else {
      const b = toBase(e.clientX, e.clientY);
      pending.x = b.x; pending.y = b.y;
    }
  }
  scheduleApply();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);

  // 先冲刷未应用的增量，避免模式切换时丢增量或位置跳变
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; applyPending(); }

  if (pointers.size === 0) {
    const wasPinch = wasPinchGesture;
    wasPinchGesture = false;
    pinchLast = null;

    if (wasPinch) {
      // 收敛低通残余，避免松手后缩放停在目标值之外
      if (Math.abs(targetZoom - zoom) > 0.001) {
        const bx = (pending.cx + tx) / zoom;
        const by = (pending.cy + ty) / zoom;
        zoom = targetZoom;
        tx = bx * zoom - pending.cx;
        ty = by * zoom - pending.cy;
        clampView();
        applyView(false);
      }
      rebuildBuffer();       // 按最终 zoom 重建高清缓冲区
    } else if (drawing) {
      const b = toBase(e.clientX, e.clientY);
      drawing.x1 = b.x; drawing.y1 = b.y;
      finishBox();           // finishBox 内部会 draw()
    }
  } else if (pointers.size === 1) {
    // 从双指回到单指：以剩余那指的当前位置为新的平移基准，避免画面跳变
    pinchLast = null;
    pending.mode = (mode === 'pan') ? 'pan' : 'draw';
    pending.scale = 1;
  }
}
cv.addEventListener('pointerup', endPointer);
/* 被系统打断时（来电、边缘手势等），若已画出有效框则保留，不再无条件丢弃 */
cv.addEventListener('pointercancel', endPointer);

function finishBox() {
  const d = drawing;
  drawing = null;
  if (!d) { draw(); return; }

  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
  const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);

  /* 关键：按「屏幕 CSS 像素」判断是否误触。
     此前用原图坐标判断（w * viewScale > 40），手机照片原图动辄 3000px，
     viewScale 仅约 0.12，屏幕上 200px 的框换算后不足 40 被丢弃，
     导致手机端「画得出框却框选不中」。
     d 存的是内容基准坐标，× zoom 才是屏幕上的实际大小。 */
  if (w * zoom >= MIN_BOX_PX && h * zoom >= MIN_BOX_PX) {
    const a = toImg({ x, y });
    const b = toImg({ x: x + w, y: y + h });
    const iw = srcImg.naturalWidth || 1, ih = srcImg.naturalHeight || 1;
    const x1 = Math.max(0, Math.min(iw, Math.round(a.x)));
    const y1 = Math.max(0, Math.min(ih, Math.round(a.y)));
    const x2 = Math.max(0, Math.min(iw, Math.round(b.x)));
    const y2 = Math.max(0, Math.min(ih, Math.round(b.y)));
    if (x2 - x1 > 0 && y2 - y1 > 0) {
      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      syncBoxes();
    }
  }
  draw();
}

/* 离屏层：缓存「原图 + 已确认框」的合成结果。
   拖动画框时每帧只需 1:1 拷贝这一层再叠加虚线框，
   避免每帧对 3000px 大图做缩放绘制——那是画框掉帧的主因。 */
let baseCv = null, baseCtx = null;
let baseDirty = true;

function rebuildBase() {
  if (!srcImg) return;
  if (!baseCv) {
    baseCv = document.createElement('canvas');
    baseCtx = baseCv.getContext('2d');
  }
  const w = Math.max(1, Math.round(baseW * renderDpr));
  const h = Math.max(1, Math.round(baseH * renderDpr));
  if (baseCv.width !== w || baseCv.height !== h) {
    baseCv.width = w; baseCv.height = h;
  }

  // 用基准坐标作绘制坐标系，物理像素由 setTransform 的 DPR 还原
  const g = baseCtx;
  g.setTransform(renderDpr, 0, 0, renderDpr, 0, 0);
  g.clearRect(0, 0, baseW, baseH);
  g.drawImage(srcImg, 0, 0, baseW, baseH);

  // 已确认框是内容的一部分，随内容一起缩放
  boxes.forEach((b, i) => {
    const x = b.x * baseScale, y = b.y * baseScale;
    const bw = b.w * baseScale, bh = b.h * baseScale;
    g.strokeStyle = '#2563eb';
    g.lineWidth = 3;
    g.strokeRect(x, y, bw, bh);
    g.fillStyle = 'rgba(37,99,235,0.12)';
    g.fillRect(x, y, bw, bh);
    // 序号角标（内容的一部分，随内容一起缩放）
    g.fillStyle = '#2563eb';
    g.beginPath();
    g.arc(x + 12, y + 12, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 12px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), x + 12, y + 12);
  });
}

/* ===== 删除按钮 =====
   画在框的右上角，屏幕上保持恒定大小（半径按 zoom 反向补偿），
   所以不能画进随内容缩放的离屏层，必须每次 draw 时现画。 */
const DEL_R = 12;   // 屏幕 CSS 像素

/* 热区中心（内容基准坐标），并保证整块落在画布内、不越界被裁掉 */
function deleteCenter(b) {
  const r = DEL_R / zoom;
  const cx = (b.x + b.w) * baseScale;
  const cy = b.y * baseScale;
  return {
    x: Math.min(Math.max(cx, r), Math.max(r, baseW - r)),
    y: Math.min(Math.max(cy, r), Math.max(r, baseH - r)),
    r
  };
}

/* 命中检测。从后往前遍历：后画的框绘制在上层，应优先响应。 */
function hitDelete(pt) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const c = deleteCenter(boxes[i]);
    const dx = pt.x - c.x, dy = pt.y - c.y;
    if (dx * dx + dy * dy <= c.r * c.r) return i;
  }
  return -1;
}

function drawDeleteButtons() {
  const s = 1 / zoom;
  boxes.forEach(b => {
    const c = deleteCenter(b);
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    // 白色叉号
    const k = c.r * 0.42;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.6 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c.x - k, c.y - k); ctx.lineTo(c.x + k, c.y + k);
    ctx.moveTo(c.x + k, c.y - k); ctx.lineTo(c.x - k, c.y + k);
    ctx.stroke();
    ctx.lineCap = 'butt';
  });
}

function draw() {
  if (!srcImg) return;
  if (baseDirty) { rebuildBase(); baseDirty = false; }

  // 1:1 拷贝离屏层（同尺寸位图拷贝走 GPU 快速路径，远快于缩放绘制大图）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (baseCv) ctx.drawImage(baseCv, 0, 0);

  // 叠加层用基准坐标系，物理像素由 setTransform 的 DPR 还原
  ctx.setTransform(renderDpr, 0, 0, renderDpr, 0, 0);
  /* 双指缩放期间不画删除按钮：手势中只改 transform、不重绘，
     按钮会被一起拉伸变形，松手重建时再跳回原大小，观感突兀。
     缩放手势开始时已调过一次 draw，此时画的是「无按钮」的一帧。 */
  if (!pinchLast) drawDeleteButtons();

  if (drawing) {
    const x = Math.min(drawing.x0, drawing.x1);
    const y = Math.min(drawing.y0, drawing.y1);
    const w = Math.abs(drawing.x1 - drawing.x0);
    const h = Math.abs(drawing.y1 - drawing.y0);
    // 拖拽中的框是操作反馈，线宽按 zoom 反向补偿，放大后仍保持屏幕上的精细度
    const s = 1 / zoom;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3 * s;
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
}

/* ============ 已选框列表 ============ */
// 上传用的最大边长，避免手机上传超大 base64 导致超时
const UPLOAD_MAX_SIDE = 1600;

function cropDataURL(box, maxSide) {
  const limit = maxSide || UPLOAD_MAX_SIDE;
  // 先按原图裁剪
  const tmp = document.createElement('canvas');
  tmp.width = box.w; tmp.height = box.h;
  const tc = tmp.getContext('2d');
  tc.fillStyle = '#fff';
  tc.fillRect(0, 0, box.w, box.h);
  tc.drawImage(srcImg, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

  // 若裁剪结果过大，等比缩小后再上传
  const s = Math.min(1, limit / Math.max(box.w, box.h));
  if (s >= 1) return tmp.toDataURL('image/jpeg', 0.85);

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(box.w * s));
  out.height = Math.max(1, Math.round(box.h * s));
  const oc = out.getContext('2d');
  oc.fillStyle = '#fff';
  oc.fillRect(0, 0, out.width, out.height);
  oc.drawImage(tmp, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

/* 框集合变化的统一收口：离屏层失效 + 同步上传按钮状态。
   这里原本还会渲染一份缩略图列表，现已改为直接在画布上给每个框画删除按钮，
   省掉每框一次 cropDataURL 的开销，也不必在列表和画布之间来回对照。 */
function syncBoxes() {
  baseDirty = true;
  if (boxes.length === 0) {
    uploadBtn.disabled = true;
    uploadBtn.textContent = '上传 0 道题';
    return;
  }
  uploadBtn.disabled = false;
  uploadBtn.textContent = `上传 ${boxes.length} 道题`;
}

$('#clearBoxesBtn').addEventListener('click', () => {
  boxes = []; syncBoxes(); draw();
});

/* ============ 上传 ============ */
/* 轻提示：识别失败等提示，数秒后自动消失 */
let toastTimer = null;
function showToast(msg, isError) {
  let t = document.getElementById('toastMsg');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastMsg';
    document.body.appendChild(t);
  }
  t.className = 'toast-msg' + (isError ? ' error' : '');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

uploadBtn.addEventListener('click', async () => {
  if (boxes.length === 0 || uploading) return;
  uploading = true;
  uploadBtn.disabled = true;

  const total = boxes.length;
  let okCount = 0;
  const errs = [];
  for (let i = 0; i < total; i++) {
    uploadBtn.textContent = `正在识别 ${i + 1}/${total} 题…`;
    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: cropDataURL(boxes[i]) })
      });
      const d = await r.json();
      if (d.ok && d.question) okCount++;
      else errs.push(d.error || '未知错误');
    } catch (e) {
      errs.push(String(e && e.message ? e.message : e));
    }
  }

  uploading = false;

  if (okCount === total && total > 0) {
    uploadBtn.textContent = '识别完成，正在跳转…';
    window.location.href = 'admin.html';
    return;
  }
  if (errs.length) showToast(`有 ${errs.length} 题识别失败：${errs[0]}`, true);
  // 恢复按钮，方便直接重试或重选照片
  syncBoxes();
});

/* ============ 单指模式切换：框选 / 移动画面 ============ */
const modeBtn = $('#modeBtn');
modeBtn.addEventListener('click', () => {
  mode = mode === 'select' ? 'pan' : 'select';
  const isPan = mode === 'pan';
  modeBtn.textContent = isPan ? '✋ 移动' : '✏️ 框选';
  modeBtn.classList.toggle('on', !isPan);
  cv.classList.toggle('pan-mode', isPan);
  drawing = null;
  draw();
});

/* ============ 缩放控件 ============ */
/* 档位缩放：走 CSS transform 过渡，不与手指输入耦合，绝对不会抖。
   过渡结束后再按最终 zoom 重建高清缓冲区（过渡中重建会打断动画）。 */
const ZOOM_ANIM_MS = 240;
let animTimer = null;

function zoomTo(next) {
  if (!srcImg) return;
  const z = clampZoom(next);
  if (Math.abs(z - zoom) < 0.001) return;

  // 先摘掉 dragging（否则 transition:none，动画不会触发），
  // 再等一帧让样式生效后才改 transform，确保过渡被浏览器识别
  cv.classList.remove('dragging');
  requestAnimationFrame(() => {
    setZoom(z, undefined, undefined, true);
    clearTimeout(animTimer);
    animTimer = setTimeout(rebuildBuffer, ZOOM_ANIM_MS);
  });
}

$('#zoomInBtn').addEventListener('click', () => zoomTo(zoom * ZOOM_STEP));
$('#zoomOutBtn').addEventListener('click', () => zoomTo(zoom / ZOOM_STEP));

/* 窗口尺寸变化 / 转屏时重新适配并重建高清画布 */
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!srcImg) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const availW = wrapEl.clientWidth || (window.innerWidth - 40);
    const maxW = Math.max(240, Math.min(availW, 1200));
    const iw = srcImg.naturalWidth || 800, ih = srcImg.naturalHeight || 600;
    let s = Math.min(maxW / iw, 1);
    if (ih * s > 1400) s = 1400 / ih;

    // 保持当前观察位置：基准尺寸变了，偏移量按同比缩放
    const ratio = baseW ? (iw * s) / baseW : 0;
    baseScale = s;
    baseW = Math.max(1, Math.round(iw * s));
    baseH = Math.max(1, Math.round(ih * s));
    if (ratio > 0) { tx *= ratio; ty *= ratio; }

    clampView();
    applyView(false);
    rebuildBuffer();
  }, 150);
});
