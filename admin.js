'use strict';

const $ = sel => document.querySelector(sel);
const listEl = $('#list');
const statsEl = $('#stats');
const statusBar = $('#statusBar');
const searchInput = $('#searchInput');
const filterSelect = $('#filterSelect');

let questions = [];
let filter = 'all';
let keyword = '';

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
  const shown = questions.filter(q => {
    if (filter !== 'all' && q.status !== filter) return false;
    if (!kw) return true;
    return (q.text || '').toLowerCase().includes(kw)
      || (q.topic || '').toLowerCase().includes(kw);
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
        <div class="q-text">${escapeHtml(q.text || '(未识别到文字)')}</div>
        ${q.figure_desc ? `<div class="q-fig">图形：${escapeHtml(q.figure_desc)}</div>` : ''}
        <div class="q-time">${escapeHtml(q.createdAt || '')}</div>
      </div>
      <div class="q-ops">
        <button class="del" data-idx="${idx}">删除</button>
      </div>`;
    listEl.appendChild(card);
  });

  listEl.querySelectorAll('.del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.getAttribute('data-idx'), 10);
      if (!confirm('确定删除这道题？')) return;
      questions.splice(i, 1);
      await fetch('/api/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions })
      });
      render();
    });
  });
}

searchInput.addEventListener('input', () => { keyword = searchInput.value; render(); });
filterSelect.addEventListener('change', () => { filter = filterSelect.value; render(); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadStatus();
loadQuestions();
