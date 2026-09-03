'use strict';

/* ============ DOM ============ */
const $ = sel => document.querySelector(sel);
const statusBar = $('#statusBar');
const pickPanel = $('#pickPanel');
const editPanel = $('#editPanel');
const resultPanel = $('#resultPanel');
const cv = $('#cv');
const ctx = cv.getContext('2d');
const boxList = $('#boxList');
const uploadBtn = $('#uploadBtn');
const progressEl = $('#progress');
const resultList = $('#resultList');

const fileInput = $('#fileInput');   // 拍照
const fileInput2 = $('#fileInput2'); // 相册

/* ============ 状态 ============ */
let srcImg = null;      // 原始 Image 对象
let boxes = [];         // 已确认的框（原图坐标）{x,y,w,h}
let drawing = null;     // 正在拖拽的框
let viewScale = 1;      // 显示尺寸 / 原图尺寸
let uploading = false;

/* ============ 服务状态 ============ */
async function checkStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    if (!d.configured) {
      statusBar.className = 'status-bar warn';
      statusBar.textContent = '⚠️ 后端未配置 Gemini API Key，识别功能不可用（见 config.json）';
    } else {
      statusBar.className = 'status-bar ok';
      statusBar.textContent = `✅ 服务正常 · 模型 ${d.model} · 题库 ${d.questions} 题`;
    }
  } catch (e) {
    statusBar.className = 'status-bar warn';
    statusBar.textContent = '⚠️ 无法连接后端，请确认 server.py 已启动';
  }
}
checkStatus();

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
  renderBoxList();

  // 按容器宽度等比缩放显示（同时限制最大尺寸，保证手机流畅）
  const maxW = Math.min(cv.parentElement.clientWidth, 1200);
  const maxH = Math.min(window.innerHeight * 0.55, 1400);
  let w = img.naturalWidth, h = img.naturalHeight;
  const s1 = maxW / w, s2 = maxH / h;
  const s = Math.min(s1, s2, 1);
  w = Math.round(w * s); h = Math.round(h * s);

  cv.width = w; cv.height = h;
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  viewScale = s;

  pickPanel.hidden = true;
  editPanel.hidden = false;
  resultPanel.hidden = true;
  draw();
}

function resetAll() {
  srcImg = null; boxes = []; drawing = null;
  renderBoxList();
  editPanel.hidden = true;
  resultPanel.hidden = true;
  pickPanel.hidden = false;
}

/* ============ 框选交互 ============ */
function toImg(p) { return { x: p.x / viewScale, y: p.y / viewScale }; }

function getPos(e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

cv.addEventListener('pointerdown', e => {
  if (!srcImg || uploading) return;
  cv.setPointerCapture(e.pointerId);
  const p = getPos(e);
  drawing = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});
cv.addEventListener('pointermove', e => {
  if (!drawing) return;
  const p = getPos(e);
  drawing.x1 = p.x; drawing.y1 = p.y;
  draw();
});
cv.addEventListener('pointerup', e => {
  if (!drawing) return;
  const p = getPos(e);
  drawing.x1 = p.x; drawing.y1 = p.y;
  const x = Math.min(drawing.x0, drawing.x1);
  const y = Math.min(drawing.y0, drawing.y1);
  const w = Math.abs(drawing.x1 - drawing.x0);
  const h = Math.abs(drawing.y1 - drawing.y0);
  drawing = null;
  // 过滤误触的极小框
  if (w * viewScale > 40 && h * viewScale > 30) {
    const a = toImg({ x, y });
    const b = toImg({ x: x + w, y: y + h });
    boxes.push({ x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) });
    renderBoxList();
  }
  draw();
});
cv.addEventListener('pointercancel', () => { drawing = null; draw(); });

function draw() {
  if (!srcImg) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(srcImg, 0, 0, cv.width, cv.height);

  boxes.forEach((b, i) => {
    const x = b.x * viewScale, y = b.y * viewScale;
    const w = b.w * viewScale, h = b.h * viewScale;
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(37,99,235,0.12)';
    ctx.fillRect(x, y, w, h);
    // 序号
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(x + 16, y + 16, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x + 16, y + 16);
  });

  if (drawing) {
    const x = Math.min(drawing.x0, drawing.x1), y = Math.min(drawing.y0, drawing.y1);
    const w = Math.abs(drawing.x1 - drawing.x0), h = Math.abs(drawing.y1 - drawing.y0);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
}

/* ============ 已选框列表 ============ */
function cropDataURL(box) {
  const c = document.createElement('canvas');
  c.width = box.w; c.height = box.h;
  const cc = c.getContext('2d');
  cc.fillStyle = '#fff';
  cc.fillRect(0, 0, box.w, box.h);
  cc.drawImage(srcImg, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return c.toDataURL('image/jpeg', 0.85);
}

function renderBoxList() {
  boxList.innerHTML = '';
  if (boxes.length === 0) {
    boxList.innerHTML = '<div class="empty">还没有框选任何题目</div>';
    uploadBtn.disabled = true;
    uploadBtn.textContent = '上传 0 道题';
    return;
  }
  boxes.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'box-item';
    const thumb = document.createElement('img');
    thumb.src = cropDataURL(b);
    const no = document.createElement('span');
    no.className = 'box-no';
    no.textContent = i + 1;
    const del = document.createElement('button');
    del.className = 'box-del';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      boxes.splice(i, 1);
      renderBoxList();
      draw();
    });
    item.appendChild(thumb);
    item.appendChild(no);
    item.appendChild(del);
    boxList.appendChild(item);
  });
  uploadBtn.disabled = false;
  uploadBtn.textContent = `上传 ${boxes.length} 道题`;
}

$('#clearBoxesBtn').addEventListener('click', () => {
  boxes = []; renderBoxList(); draw();
});

/* ============ 上传 ============ */
uploadBtn.addEventListener('click', async () => {
  if (boxes.length === 0 || uploading) return;
  uploading = true;
  uploadBtn.disabled = true;
  resultList.innerHTML = '';
  resultPanel.hidden = false;
  progressEl.hidden = false;

  const results = [];
  for (let i = 0; i < boxes.length; i++) {
    progressEl.textContent = `正在识别第 ${i + 1} / ${boxes.length} 题…`;
    const card = document.createElement('div');
    card.className = 'res-card loading';
    card.innerHTML = `<div class="res-head">第 ${i + 1} 题</div>
      <div class="res-body">识别中…</div>`;
    resultList.appendChild(card);

    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: cropDataURL(boxes[i]) })
      });
      const d = await r.json();
      if (d.ok && d.question) {
        results.push(d.question);
        card.classList.remove('loading');
        const q = d.question;
        card.innerHTML = `
          <div class="res-head">第 ${i + 1} 题 · ${escapeHtml(q.topic || '未分类')}</div>
          <div class="res-body">${escapeHtml(q.text || '(未识别到文字)')}</div>
          ${q.has_figure ? `<div class="res-fig">🖼 图形：${escapeHtml(q.figure_desc)}</div>` : ''}
          ${q.ocrError ? `<div class="res-err">⚠️ ${escapeHtml(q.ocrError)}</div>` : ''}`;
      } else {
        card.classList.remove('loading');
        card.classList.add('error');
        card.innerHTML = `<div class="res-head">第 ${i + 1} 题</div>
          <div class="res-err">识别失败：${escapeHtml(d.error || '未知错误')}</div>`;
      }
    } catch (e) {
      card.classList.remove('loading');
      card.classList.add('error');
      card.innerHTML = `<div class="res-head">第 ${i + 1} 题</div>
        <div class="res-err">请求失败：${escapeHtml(String(e))}</div>`;
    }
  }

  progressEl.hidden = true;
  uploading = false;
  uploadBtn.disabled = false;
  checkStatus();
});

$('#continueBtn').addEventListener('click', () => resetAll());

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('resize', () => { if (srcImg) draw(); });
