'use strict';

const $ = sel => document.querySelector(sel);
const listEl = $('#list');
const statsEl = $('#stats');
const statusBar = $('#statusBar');
const searchInput = $('#searchInput');
const filterSelect = $('#filterSelect');
const sortSelect = $('#sortSelect');

let questions = [];
let filter = 'all';
let keyword = '';
let sortOrder = 'desc'; // 默认倒序（最新在前）

/* ============ LaTeX 渲染 ============ */
// 保护 LaTeX 片段，避免其中的 < > & 被 HTML 转义或误判
const MATH_TOKEN = '\u0000MATH\u0000';

function renderMath(raw) {
  if (!raw) return '';
  let parts = [];
  // 先抽出 $$...$$ 与 $...$
  let text = String(raw).replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, d, i) => {
    parts.push(d !== undefined ? d : i);
    return MATH_TOKEN + (parts.length - 1) + MATH_TOKEN;
  });
  // 其余部分做 HTML 转义
  text = escapeHtml(text);
  // 回填并渲染
  text = text.replace(new RegExp(MATH_TOKEN + '(\\d+)' + MATH_TOKEN, 'g'), (m, idx) => {
    return katex.renderToString(parts[Number(idx)], {
      throwOnError: false,
      displayMode: false,
      output: 'html'
    });
  });
  return text.replace(/\n/g, '<br>');
}

/* ============ 加载 ============ */
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    statusBar.className = d.configured ? 'status-bar ok' : 'status-bar warn';
    statusBar.textContent = d.configured
      ? `✅ 服务正常 · 模型 ${d.model}`
      : '⚠️ 未配置 Gemini API Key（识别功能不可用）';
  } catch (e) {
    statusBar.className = 'status-bar warn';
    statusBar.textContent = '⚠️ 无法连接后端';
  }
}

async function loadQuestions() {
  try {
    const r = await fetch('/api/questions', { cache: 'no-store' });
    const d = await r.json();
    questions = Array.isArray(d.questions) ? d.questions : [];
  } catch (e) {
    questions = [];
    statusBar.textContent = '⚠️ 题库加载失败';
  }
  render();
}

async function saveAll() {
  await fetch('/api/questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions })
  });
  render();
}

/* ============ 渲染 ============ */
function render() {
  const total = questions.length;
  const fresh = questions.filter(q => q.status === 'new').length;
  const learning = questions.filter(q => q.status === 'learning').length;
  const mastered = questions.filter(q => q.status === 'mastered').length;
  statsEl.innerHTML = `
    <div class="stat"><div class="n">${total}</div><div class="l">总题数</div></div>
    <div class="stat"><div class="n">${fresh}</div><div class="l">未掌握</div></div>
    <div class="stat warn"><div class="n">${learning}</div><div class="l">巩固中</div></div>
    <div class="stat ok"><div class="n">${mastered}</div><div class="l">已掌握</div></div>`;

  const kw = keyword.trim().toLowerCase();
  let shown = questions.filter(q => {
    if (filter !== 'all' && q.status !== filter) return false;
    if (!kw) return true;
    return (q.text || '').toLowerCase().includes(kw)
      || (q.topic || '').toLowerCase().includes(kw)
      || (q.answer || '').toLowerCase().includes(kw);
  });

  // 排序：按 createdAt 时间
  shown = shown.slice().sort((a, b) => {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    return sortOrder === 'desc' ? tb - ta : ta - tb;
  });

  listEl.innerHTML = '';
  if (shown.length === 0) {
    listEl.innerHTML = `<div class="empty">暂无题目，去拍照端录入吧</div>`;
    return;
  }

  shown.forEach(q => {
    const idx = questions.indexOf(q);
    const label = q.status === 'new' ? '未掌握' : q.status === 'learning' ? '巩固中' : '已掌握';
    const cls = q.status === 'new' ? 'new' : q.status === 'learning' ? 'learning' : 'mastered';

    const card = document.createElement('div');
    card.className = 'q-card';
    card.innerHTML = `
      <div class="q-img">
        ${q.image ? `<img src="${q.image}" alt="题目图" loading="lazy" />` : '<div class="noimg">无图</div>'}
      </div>
      <div class="q-main">
        <div class="q-meta">
          <span class="badge ${cls}">${label}</span>
          <span class="topic">${escapeHtml(q.topic || '未分类')}</span>
          <span class="streak">连对 ${q.streak || 0} 次</span>
          ${q.has_figure ? '<span class="fig">🖼 有图</span>' : ''}
        </div>

        <div class="q-block" data-field="text" data-idx="${idx}">
          <div class="q-label">题目</div>
          <div class="q-value q-text">${renderMath(q.text || '(未识别到文字)')}</div>
        </div>

        <div class="q-block" data-field="answer" data-idx="${idx}">
          <div class="q-label">答案</div>
          <div class="q-value q-answer">${q.answer ? renderMath(q.answer) : '<span class="muted">（暂无答案）</span>'}</div>
        </div>

        ${q.figure_desc ? `<div class="q-fig"><b>图形：</b>${escapeHtml(q.figure_desc)}</div>` : ''}
        <div class="q-time">${escapeHtml(q.createdAt || '')}</div>
      </div>
      <div class="q-ops">
        <button class="del" data-idx="${idx}">删除</button>
      </div>`;
    listEl.appendChild(card);
  });

  bindEvents();
}

function bindEvents() {
  // 删除
  listEl.querySelectorAll('.del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.getAttribute('data-idx'), 10);
      if (!confirm('确定删除这道题？')) return;
      questions.splice(i, 1);
      await saveAll();
    });
  });

  // 点击题目/答案区域进入编辑
  listEl.querySelectorAll('.q-block').forEach(blk => {
    blk.addEventListener('click', () => {
      const idx = parseInt(blk.getAttribute('data-idx'), 10);
      const field = blk.getAttribute('data-field');
      if (blk.classList.contains('editing')) return;
      startEdit(blk, idx, field);
    });
  });
}

/* ============ 行内编辑 ============ */
function startEdit(blk, idx, field) {
  const q = questions[idx];
  if (!q) return;
  blk.classList.add('editing');
  const isAnswer = field === 'answer';
  const current = q[field] || '';

  blk.innerHTML = `
    <div class="q-label">${isAnswer ? '答案' : '题目'}（编辑中）</div>
    <textarea class="edit-area" rows="${isAnswer ? 2 : 4}">${escapeHtml(current)}</textarea>
    <div class="edit-tip">数学公式用 LaTeX：<code>$x^2$</code>、<code>$\\frac{3}{4}$</code>；独立公式用 <code>$$...$$</code></div>
    <div class="edit-btns">
      <button class="btn-mini save">保存</button>
      <button class="btn-mini cancel">取消</button>
    </div>`;

  const ta = blk.querySelector('textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  blk.querySelector('.save').addEventListener('click', async e => {
    e.stopPropagation();
    questions[idx][field] = ta.value.trim();
    await saveAll();
  });
  blk.querySelector('.cancel').addEventListener('click', e => {
    e.stopPropagation();
    render();
  });
  // 阻止冒泡，避免编辑中再次触发外层点击
  blk.addEventListener('click', e => e.stopPropagation());
}

/* ============ 交互 ============ */
searchInput.addEventListener('input', () => { keyword = searchInput.value; render(); });
filterSelect.addEventListener('change', () => { filter = filterSelect.value; render(); });
sortSelect.addEventListener('change', () => { sortOrder = sortSelect.value; render(); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadStatus();
loadQuestions();
