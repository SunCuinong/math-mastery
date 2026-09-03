'use strict';

const $ = sel => document.querySelector(sel);
const paperPages = $('#paperPages');
const paperEmpty = $('#paperEmpty');
const paperTotal = $('#paperTotal');
const paperActionBar = $('#paperActionBar');

let paperQuestions = [];

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
  text = text.replace(new RegExp(MATH_TOKEN + '(\\d+)' + MATH_TOKEN, 'g'), (m, idx) => {
    const part = parts[Number(idx)];
    return katex.renderToString(part.expr, { throwOnError: false, displayMode: part.displayMode, output: 'html' });
  });
  return text.replace(/\n/g, '<br>');
}

function svgDataUrl(svg) {
  if (!svg) return '';
  try { return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`; } catch (e) { return ''; }
}

function persistPaper() {
  sessionStorage.setItem('wrongbook-paper', JSON.stringify(paperQuestions));
}

function render() {
  paperPages.innerHTML = '';
  const isEmpty = paperQuestions.length === 0;
  paperPages.hidden = isEmpty;
  paperActionBar.hidden = isEmpty;
  paperEmpty.hidden = !isEmpty;
  if (isEmpty) return;

  for (let start = 0; start < paperQuestions.length; start += 6) {
    const pageQuestions = paperQuestions.slice(start, start + 6);
    const page = document.createElement('section');
    page.className = 'paper-sheet';
    page.innerHTML = `
      <div class="paper-title-row">
        <div>
          <h2 contenteditable="true" spellcheck="false">数学错题巩固练习</h2>
          <p>姓名：____________　日期：____________</p>
        </div>
        <span class="paper-total">第 ${Math.floor(start / 6) + 1} 页 · 共 ${paperQuestions.length} 题</span>
      </div>
      <div class="paper-list"></div>`;
    const pageList = page.querySelector('.paper-list');
    pageQuestions.forEach((q, offset) => {
      const index = start + offset;
      const item = document.createElement('article');
      item.className = 'paper-question';
      item.innerHTML = `
        <div class="paper-question-head">
          <span class="paper-number">${index + 1}.</span>
          <span class="paper-topic">${escapeHtml(q.topic || '综合练习')}</span>
          <div class="paper-question-actions">
            <button class="btn-mini regenerate" data-index="${index}" type="button">AI 生成同类题</button>
            <button class="btn-mini delete-paper-question" data-index="${index}" type="button">删除</button>
          </div>
        </div>
        <div class="paper-question-text">${renderMath(q.text || '（题目内容为空）')}</div>
        ${q.cleanOriginalImage ? `<img class="paper-clean-figure" src="${q.cleanOriginalImage}" alt="清洁后的原题图" />` : (q.cleanFigureSvg ? `<img class="paper-clean-figure" src="${svgDataUrl(q.cleanFigureSvg)}" alt="题目清洁图" />` : '')}`;
      pageList.appendChild(item);
    });
    paperPages.appendChild(page);
  }
  bindQuestionActions();
}

function bindQuestionActions() {
  paperPages.querySelectorAll('.delete-paper-question').forEach(btn => {
    btn.addEventListener('click', () => {
      paperQuestions.splice(Number(btn.dataset.index), 1);
      persistPaper();
      render();
    });
  });

  paperPages.querySelectorAll('.regenerate').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = Number(btn.dataset.index);
      const original = paperQuestions[index];
      if (!original || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'AI 生成中…';
      try {
        const response = await fetch('/api/generate-similar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: original.text, topic: original.topic, answer: original.answer })
        });
        const data = await response.json();
        if (!response.ok || !data.ok || !data.question) {
          throw new Error(response.status === 404
            ? '服务尚未重启，未加载 AI 出题接口'
            : (data.error || '生成失败'));
        }
        paperQuestions[index] = {
          ...original,
          ...data.question,
          sourceId: original.sourceId || original.id,
          id: `generated_${Date.now()}_${index}`
        };
        persistPaper();
        render();
      } catch (error) {
        alert(`同类题生成失败：${error.message || error}`);
        btn.disabled = false;
        btn.textContent = 'AI 生成同类题';
      }
    });
  });
}

function loadPaper() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('wrongbook-paper') || '[]');
    paperQuestions = Array.isArray(saved) ? saved.filter(q => q && q.text) : [];
  } catch (error) {
    paperQuestions = [];
  }
  render();
}

$('#createPaperBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!paperQuestions.length || button.disabled) return;
  button.disabled = true;
  button.textContent = '正在生成试卷…';
  try {
    const response = await fetch('/api/paper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: paperQuestions })
    });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.paper) throw new Error(data.error || '生成失败');
    sessionStorage.removeItem('wrongbook-paper');
    window.location.href = 'admin.html';
  } catch (error) {
    alert(`试卷生成失败：${error.message || error}`);
    button.disabled = false;
    button.textContent = '生成试卷';
  }
});

window.addEventListener('load', loadPaper);
