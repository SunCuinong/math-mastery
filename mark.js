'use strict';

const $ = sel => document.querySelector(sel);
const markStatus = $('#markStatus');
const markList = $('#markList');
const markActionBar = $('#markActionBar');
const markProgress = $('#markProgress');
const finishMarkBtn = $('#finishMarkBtn');
const marks = new Map();
let paper = null;
const MATH_TOKEN = '\u0000MATH\u0000';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMath(raw) {
  if (!raw) return '';
  if (typeof katex === 'undefined') return escapeHtml(String(raw)).replace(/\n/g, '<br>');
  const parts = [];
  let text = String(raw).replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, d, i) => {
    parts.push({ expr: d !== undefined ? d : i, displayMode: d !== undefined });
    return MATH_TOKEN + (parts.length - 1) + MATH_TOKEN;
  });
  text = escapeHtml(text);
  text = text.replace(new RegExp(MATH_TOKEN + '(\\d+)' + MATH_TOKEN, 'g'), (m, index) => {
    const part = parts[Number(index)];
    return katex.renderToString(part.expr, { throwOnError: false, displayMode: part.displayMode, output: 'html' });
  });
  return text.replace(/\n/g, '<br>');
}

function svgDataUrl(svg) {
  if (!svg) return '';
  try { return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`; } catch (e) { return ''; }
}

function updateProgress() {
  const total = paper ? paper.items.length : 0;
  markProgress.textContent = `已批改 ${marks.size} / ${total} 题`;
  finishMarkBtn.disabled = !total || marks.size !== total;
}

function render() {
  markList.innerHTML = '';
  if (!paper) return;
  markStatus.className = 'status-bar ok';
  markStatus.textContent = `试卷生成于 ${paper.createdAt.replace('T', ' ')} · 共 ${paper.items.length} 题`;
  paper.items.forEach((item, index) => {
    const result = marks.get(item.sourceId);
    const card = document.createElement('article');
    card.className = 'mark-card';
    card.innerHTML = `
      <div class="mark-photo">${item.image ? `<img src="${item.image}" alt="原题照片" />` : '<div class="noimg">无原题照片</div>'}</div>
      <div class="mark-main">
        <div class="mark-head"><strong>第 ${index + 1} 题</strong><span>${escapeHtml(item.topic || '综合练习')}</span></div>
        <div class="mark-label">题目</div>
        <div class="mark-question">${renderMath(item.text)}</div>
        ${item.cleanOriginalImage ? `<img class="mark-clean-figure" src="${item.cleanOriginalImage}" alt="清洁后的原题图" />` : (item.cleanFigureSvg ? `<img class="mark-clean-figure" src="${svgDataUrl(item.cleanFigureSvg)}" alt="题目清洁图" />` : '')}
        <div class="mark-label">答案</div>
        <div class="mark-answer">${item.answer ? renderMath(item.answer) : '（暂无答案）'}</div>
        <div class="mark-buttons">
          <button class="btn mark-correct ${result === true ? 'active' : ''}" data-source-id="${escapeHtml(item.sourceId)}" data-correct="true" type="button">正确</button>
          <button class="btn mark-wrong ${result === false ? 'active' : ''}" data-source-id="${escapeHtml(item.sourceId)}" data-correct="false" type="button">错误</button>
        </div>
      </div>`;
    markList.appendChild(card);
  });
  markList.querySelectorAll('.mark-buttons button').forEach(button => {
    button.addEventListener('click', () => {
      marks.set(button.dataset.sourceId, button.dataset.correct === 'true');
      render();
      updateProgress();
    });
  });
}

async function loadPaper() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    markStatus.className = 'status-bar warn';
    markStatus.textContent = '未找到要批改的试卷。';
    return;
  }
  try {
    const response = await fetch(`/api/paper?id=${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok || !data.paper) throw new Error(data.error || '加载失败');
    paper = data.paper;
    if (paper.status === 'completed') {
      markStatus.className = 'status-bar warn';
      markStatus.textContent = '这份试卷已经批改完成，结果已计入题库。';
      paper.items.forEach(item => marks.set(item.sourceId, item.result));
    }
    markActionBar.hidden = paper.status === 'completed';
    render();
    updateProgress();
  } catch (error) {
    markStatus.className = 'status-bar warn';
    markStatus.textContent = `试卷加载失败：${error.message || error}`;
  }
}

finishMarkBtn.addEventListener('click', async () => {
  if (!paper || finishMarkBtn.disabled) return;
  finishMarkBtn.disabled = true;
  finishMarkBtn.textContent = '正在保存…';
  try {
    const results = paper.items.map(item => ({ sourceId: item.sourceId, correct: marks.get(item.sourceId) }));
    const response = await fetch('/api/paper/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: paper.id, results })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '保存失败');
    window.location.href = 'admin.html';
  } catch (error) {
    alert(`批改保存失败：${error.message || error}`);
    finishMarkBtn.disabled = false;
    finishMarkBtn.textContent = '批改完毕';
  }
});

window.addEventListener('load', loadPaper);
