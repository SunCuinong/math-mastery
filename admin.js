'use strict';

const $ = sel => document.querySelector(sel);
const listEl = $('#list');
const statsEl = $('#stats');
const statusBar = $('#statusBar');
const searchInput = $('#searchInput');
const filterSelect = $('#filterSelect');
const sortSelect = $('#sortSelect');
const editorPanel = $('#editorPanel');
const editorCloseBtn = $('#editorCloseBtn');
const editorSaveBtn = $('#editorSaveBtn');
const editTopic = $('#editTopic');
const editStatus = $('#editStatus');
const editText = $('#editText');
const editAnswer = $('#editAnswer');
const selectPaperBtn = $('#selectPaperBtn');
const autoPaperBtn = $('#autoPaperBtn');
const paperSelectionCount = $('#paperSelectionCount');
const paperSelectionNextBtn = $('#paperSelectionNextBtn');
const composeDefault = $('#composeDefault');
const composeSelect = $('#composeSelect');
const composeAuto = $('#composeAuto');
const selectAllPaper = $('#selectAllPaper');
const paperRecords = $('#paperRecords');
const paperRecordCount = $('#paperRecordCount');
const paperRecordList = $('#paperRecordList');
const historyDialog = $('#historyDialog');
const historyTitle = $('#historyTitle');
const historyList = $('#historyList');
const historyCloseBtn = $('#historyCloseBtn');

let questions = [];
let papers = [];
let filter = 'all';
let keyword = '';
let sortOrder = 'desc'; // 默认倒序（最新在前）
let editingId = '';
let selectingForPaper = false;
const selectedPaperIds = new Set();
let shownQuestions = [];

/* ============ LaTeX 渲染 ============ */
// 保护 LaTeX 片段，避免其中的 < > & 被 HTML 转义或误判
const MATH_TOKEN = '\u0000MATH\u0000';

function renderMath(raw) {
  if (!raw) return '';
  if (typeof katex === 'undefined') return escapeHtml(String(raw)).replace(/\n/g, '<br>');
  let parts = [];
  let text = String(raw).replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, d, i) => {
    const expr = d !== undefined ? d : i;
    const displayMode = d !== undefined;
    parts.push({ expr, displayMode });
    return MATH_TOKEN + (parts.length - 1) + MATH_TOKEN;
  });
  text = escapeHtml(text);
  text = text.replace(new RegExp(MATH_TOKEN + '(\\d+)' + MATH_TOKEN, 'g'), (m, idx) => {
    const part = parts[Number(idx)];
    return katex.renderToString(part.expr, {
      throwOnError: false,
      displayMode: part.displayMode,
      output: 'html'
    });
  });
  return text.replace(/\n/g, '<br>');
}

function svgDataUrl(svg) {
  if (!svg) return '';
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  } catch (e) {
    return '';
  }
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
  // 「未掌握(new)」状态已合并入「巩固中(learning)」：旧数据在此统一迁移
  questions.forEach(q => { if (q.status === 'new') q.status = 'learning'; });
  render();
}

async function loadPapers() {
  try {
    const r = await fetch('/api/papers', { cache: 'no-store' });
    const d = await r.json();
    papers = Array.isArray(d.papers) ? d.papers : [];
  } catch (e) {
    papers = [];
  }
  renderPapers();
}

async function saveAll() {
  await fetch('/api/questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions })
  });
  render();
}

async function saveOne(question) {
  const r = await fetch('/api/question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(question)
  });
  const d = await r.json();
  if (!r.ok || !d.ok || !d.question) {
    throw new Error(d.error || '保存失败');
  }
  const idx = questions.findIndex(q => q.id === d.question.id);
  if (idx >= 0) questions[idx] = d.question;
  else questions.unshift(d.question);
  return d.question;
}

/* ============ 渲染 ============ */
function render() {
  const total = questions.length;
  const learning = questions.filter(q => q.status === 'learning').length;
  const mastered = questions.filter(q => q.status === 'mastered').length;
  statsEl.innerHTML = `
    <div class="stat"><div class="n">${total}</div><div class="l">总题数</div></div>
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
  shownQuestions = shown;

  listEl.innerHTML = '';
  if (shown.length === 0) {
    listEl.innerHTML = `<div class="empty">暂无题目，去拍照端录入吧</div>`;
    updatePaperSelectionBar();
    return;
  }

  shown.forEach(q => {
    const idx = questions.findIndex(item => item.id === q.id);
    // 状态只有两种：巩固中 / 已掌握（原「未掌握」已合并入巩固中）
    const learned = q.status === 'mastered';
    const label = learned ? '已掌握' : '巩固中';
    const cls = learned ? 'mastered' : 'learning';
    const isActive = editingId && editingId === q.id;

    const card = document.createElement('div');
    card.className = 'q-card' + (selectedPaperIds.has(q.id) ? ' selected-for-paper' : '');
    card.innerHTML = `
      ${selectingForPaper ? `<label class="paper-checkbox" title="选择此题"><input class="paper-select" data-id="${escapeHtml(q.id)}" type="checkbox" ${selectedPaperIds.has(q.id) ? 'checked' : ''} /><span>选择</span></label>` : ''}
      <div class="q-img">
        ${q.image ? `<img src="${q.image}" alt="题目图" loading="lazy" />` : '<div class="noimg">无图</div>'}
      </div>
      <div class="q-main">
        <div class="q-meta">
          <span class="badge ${cls}">${label}</span>
          ${renderHistoryDots(q)}
        </div>

        <!-- 顺序：题目 → 图 → 图形解释及按钮 → 答案 → 时间 -->
        <div class="q-block" data-field="text" data-idx="${idx}">
          <div class="q-value q-text">${renderMath(q.text || '(未识别到文字)')}</div>
        </div>

        ${q.cleanOriginalImage ? `<div class="clean-figure"><img src="${escapeHtml(q.cleanOriginalImage)}" alt="AI 清洁后的原题图" /></div>` : (q.cleanFigureSvg ? `<div class="clean-figure"><img src="${svgDataUrl(q.cleanFigureSvg)}" alt="AI 重绘的清洁图" /></div>` : '')}

        ${q.has_figure ? `<div class="figure-panel"><div>${q.figure_desc ? `<b>图形：</b>${escapeHtml(q.figure_desc)}` : '已识别到题目插图'}</div><div class="figure-panel-actions"><button class="btn-mini clean-original-btn" data-id="${escapeHtml(q.id)}" type="button">${q.cleanOriginalImage ? '重新清洁原图' : '使用原图清洁'}</button><button class="btn-mini clean-figure-btn" data-id="${escapeHtml(q.id)}" type="button">${q.cleanFigureSvg ? '重新生成清洁图' : '生成清洁图'}</button></div></div>` : ''}

        <div class="q-block" data-field="answer" data-idx="${idx}">
          <div class="q-label">答案</div>
          <div class="q-value q-answer">${q.answer ? renderMath(q.answer) : '<span class="muted">（暂无答案）</span>'}</div>
        </div>

        <div class="q-time">${escapeHtml(q.createdAt || '')}</div>
      </div>
      <div class="q-ops">
        <button class="icon-btn history-info" data-id="${escapeHtml(q.id)}" type="button" aria-label="查看答题历史"><span class="material-symbols-rounded">history</span></button>
        <details class="more-menu"><summary aria-label="更多操作"><span class="material-symbols-rounded">more_horiz</span></summary><div class="more-menu-popover"><button class="edit-one" data-id="${escapeHtml(q.id)}" type="button">修改</button><button class="del" data-idx="${idx}" type="button">删除</button></div></details>
      </div>`;
    listEl.appendChild(card);
  });

  bindEvents();
  updatePaperSelectionBar();
}

function renderHistoryDots(question) {
  const history = Array.isArray(question.history) ? question.history : [];
  // 查看历史统一使用右上角的时钟按钮（icon-btn），此处仅展示结果圆点
  if (!history.length) return '<span class="history-empty">暂无练习记录</span>';
  const visible = history.slice(-8);
  const dots = visible.map(item => `<span class="result-dot ${item.correct ? 'correct' : 'wrong'}" title="${item.correct ? '正确' : '错误'}"></span>`).join('');
  const extra = history.length > visible.length ? `<span class="history-more">+${history.length - visible.length}</span>` : '';
  return `<span class="history-dots" aria-label="答题记录">${dots}${extra}</span>`;
}

function renderPapers() {
  paperRecordList.innerHTML = '';
  const pendingPapers = papers.filter(paper => paper.status !== 'completed');
  paperRecords.hidden = false;
  paperRecordCount.textContent = `共 ${pendingPapers.length} 份`;
  if (!pendingPapers.length) {
    paperRecordList.innerHTML = '<div class="empty">暂无待批改试卷，可在试卷档案中查看已批改记录。</div>';
    return;
  }
  pendingPapers.forEach(paper => {
    const card = document.createElement('article');
    card.className = 'paper-record';
    card.innerHTML = `
      <div>
        <div class="paper-record-title">练习卷 · ${paper.items.length} 题 <span class="paper-record-status">待批改</span></div>
        <div class="paper-record-time">生成于 ${escapeHtml((paper.createdAt || '').replace('T', ' '))}</div>
      </div>
      <div class="paper-record-actions">
        <a class="btn btn-ghost" href="paper-view.html?id=${encodeURIComponent(paper.id)}&download=1" target="_blank"><span class="material-symbols-rounded">download</span>下载 PDF</a>
        <a class="btn btn-primary" href="mark.html?id=${encodeURIComponent(paper.id)}"><span class="material-symbols-rounded">fact_check</span>去批改</a>
        <details class="more-menu"><summary aria-label="更多操作"><span class="material-symbols-rounded">more_horiz</span></summary><div class="more-menu-popover"><button class="del delete-paper-record" data-id="${escapeHtml(paper.id)}" type="button">删除</button></div></details>
      </div>`;
    paperRecordList.appendChild(card);
  });
  paperRecordList.querySelectorAll('.delete-paper-record').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除这份试卷记录？题库中的答题记录不会被删除。')) return;
      try {
        const response = await fetch('/api/paper/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.id })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '删除失败');
        await loadPapers();
      } catch (error) {
        alert(`删除试卷失败：${error.message || error}`);
      }
    });
  });
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
      if (selectingForPaper) return;
      const idx = parseInt(blk.getAttribute('data-idx'), 10);
      const field = blk.getAttribute('data-field');
      if (blk.classList.contains('editing')) return;
      startEdit(blk, idx, field);
    });
  });

  listEl.querySelectorAll('.edit-one').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openEditor(btn.getAttribute('data-id'));
    });
  });

  listEl.querySelectorAll('.paper-select').forEach(input => {
    input.addEventListener('change', () => {
      const id = input.dataset.id;
      if (input.checked) selectedPaperIds.add(id);
      else selectedPaperIds.delete(id);
      updatePaperSelectionBar();
      input.closest('.q-card').classList.toggle('selected-for-paper', input.checked);
    });
  });

  listEl.querySelectorAll('.history-info').forEach(button => {
    button.addEventListener('click', () => openHistory(button.dataset.id));
  });

  listEl.querySelectorAll('.clean-figure-btn').forEach(button => {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = '清洁图生成中…';
      try {
        const response = await fetch('/api/question/clean-figure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: button.dataset.id })
        });
        const data = await response.json();
        if (!response.ok || !data.ok || !data.question) throw new Error(data.error || '生成失败');
        const index = questions.findIndex(item => item.id === data.question.id);
        if (index >= 0) questions[index] = data.question;
        render();
      } catch (error) {
        alert(`清洁图生成失败：${error.message || error}`);
        button.disabled = false;
        button.textContent = label;
      }
    });
  });

  listEl.querySelectorAll('.clean-original-btn').forEach(button => {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = '原图清洁中…';
      try {
        const response = await fetch('/api/question/clean-original', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: button.dataset.id })
        });
        const data = await response.json();
        if (!response.ok || !data.ok || !data.question) throw new Error(data.error || '清洁失败');
        const index = questions.findIndex(item => item.id === data.question.id);
        if (index >= 0) questions[index] = data.question;
        render();
      } catch (error) {
        alert(`原图清洁失败：${error.message || error}`);
        button.disabled = false;
        button.textContent = label;
      }
    });
  });
}

function openHistory(id) {
  const question = questions.find(item => item.id === id);
  const history = Array.isArray(question?.history) ? question.history : [];
  historyTitle.textContent = '答题记录';
  historyList.innerHTML = history.length
    ? history.slice().reverse().map(item => `<div class="history-row"><span class="result-dot ${item.correct ? 'correct' : 'wrong'}"></span><span>${item.correct ? '答对' : '答错'}</span><time>${escapeHtml((item.at || '').replace('T', ' '))}</time></div>`).join('')
    : '<div class="empty">暂无答题记录</div>';
  historyDialog.showModal();
}

historyCloseBtn.addEventListener('click', () => historyDialog.close());

/* ============ 行内编辑 ============ */
function startEdit(blk, idx, field) {
  const q = questions[idx];
  if (!q) return;
  blk.classList.add('editing');
  const isAnswer = field === 'answer';
  const current = q[field] || '';

  blk.innerHTML = `
    <div class="q-label">${isAnswer ? '答案' : '题目'}（编辑中）</div>
    <textarea class="edit-area" rows="${isAnswer ? 2 : 4}"></textarea>
    <div class="edit-tip">数学公式用 LaTeX：<code>$x^2$</code>、<code>$\\frac{3}{4}$</code>；独立公式用 <code>$$...$$</code></div>
    <div class="edit-btns">
      <button class="btn-mini save">保存</button>
      <button class="btn-mini cancel">取消</button>
    </div>`;

  const ta = blk.querySelector('textarea');
  ta.value = current;
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

function openEditor(id) {
  const q = questions.find(item => item.id === id);
  if (!q) return;
  editingId = id;
  editTopic.value = q.topic || '';
  editStatus.value = (q.status === 'mastered') ? 'mastered' : 'learning';
  editText.value = q.text || '';
  editAnswer.value = q.answer || '';
  editorPanel.hidden = false;
  render();
  editorPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEditor() {
  editingId = '';
  editorPanel.hidden = true;
  render();
}

editorCloseBtn.addEventListener('click', closeEditor);
editorSaveBtn.addEventListener('click', async () => {
  if (!editingId) return;
  try {
    await saveOne({
      id: editingId,
      topic: editTopic.value.trim(),
      status: editStatus.value,
      text: editText.value.trim(),
      answer: editAnswer.value.trim()
    });
    closeEditor();
  } catch (e) {
    alert(String(e.message || e));
  }
});

/* ============ 交互 ============ */
searchInput.addEventListener('input', () => { keyword = searchInput.value; render(); });
filterSelect.addEventListener('change', () => { filter = filterSelect.value; render(); });
sortSelect.addEventListener('change', () => { sortOrder = sortSelect.value; render(); });

/* ============ 组卷 ============ */
function eligibleQuestions() {
  const kw = keyword.trim().toLowerCase();
  return questions.filter(q => {
    if (filter !== 'all' && q.status !== filter) return false;
    if (!kw) return true;
    return (q.text || '').toLowerCase().includes(kw)
      || (q.topic || '').toLowerCase().includes(kw)
      || (q.answer || '').toLowerCase().includes(kw);
  });
}

function updatePaperSelectionBar() {
  paperSelectionCount.textContent = `已选 ${selectedPaperIds.size} 道题`;
  paperSelectionNextBtn.disabled = selectedPaperIds.size === 0;
  const visibleIds = shownQuestions.map(q => q.id);
  selectAllPaper.checked = visibleIds.length > 0 && visibleIds.every(id => selectedPaperIds.has(id));
  selectAllPaper.indeterminate = selectedPaperIds.size > 0 && !selectAllPaper.checked;
}

function openPaper(questionsForPaper) {
  if (!questionsForPaper.length) {
    alert('请先选择至少一道题。');
    return;
  }
  sessionStorage.setItem('math-mastery-paper', JSON.stringify(questionsForPaper));
  window.location.href = 'paper.html';
}

function setPaperMode(mode) {
  selectingForPaper = mode === 'select';
  composeDefault.hidden = mode !== 'idle';
  composeSelect.hidden = mode !== 'select';
  composeAuto.hidden = mode !== 'auto';
  if (mode !== 'select') selectedPaperIds.clear();
  updatePaperSelectionBar();
  render();
}

selectPaperBtn.addEventListener('click', () => setPaperMode('select'));

autoPaperBtn.addEventListener('click', () => setPaperMode('auto'));

document.querySelectorAll('.paper-mode-exit').forEach(button => {
  button.addEventListener('click', () => setPaperMode('idle'));
});

selectAllPaper.addEventListener('change', () => {
  if (selectAllPaper.checked) shownQuestions.forEach(q => selectedPaperIds.add(q.id));
  else shownQuestions.forEach(q => selectedPaperIds.delete(q.id));
  updatePaperSelectionBar();
  render();
});

paperSelectionNextBtn.addEventListener('click', () => {
  openPaper(questions.filter(q => selectedPaperIds.has(q.id)));
});

document.querySelectorAll('.auto-count').forEach(button => button.addEventListener('click', () => {
  const pool = eligibleQuestions();
  const count = Number(button.dataset.count);
  if (!pool.length) {
    alert('当前筛选结果没有可出题目。');
    return;
  }
  const selected = pool.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(count, pool.length));
  openPaper(selected);
}));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadStatus();
loadQuestions();
loadPapers();
