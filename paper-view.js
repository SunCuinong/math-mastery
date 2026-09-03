'use strict';

const $ = sel => document.querySelector(sel);
const viewStatus = $('#viewStatus');
const viewPages = $('#viewPages');
const viewActionBar = $('#viewActionBar');
const MATH_TOKEN = '\u0000MATH\u0000';

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderMath(raw) {
  if (!raw) return '';
  if (typeof katex === 'undefined') return escapeHtml(String(raw)).replace(/\n/g, '<br>');
  const parts = [];
  let text = String(raw).replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, d, i) => {
    parts.push({ expr: d !== undefined ? d : i, displayMode: d !== undefined }); return MATH_TOKEN + (parts.length - 1) + MATH_TOKEN;
  });
  text = escapeHtml(text).replace(new RegExp(MATH_TOKEN + '(\\d+)' + MATH_TOKEN, 'g'), (m, index) => {
    const part = parts[Number(index)]; return katex.renderToString(part.expr, { throwOnError: false, displayMode: part.displayMode, output: 'html' });
  });
  return text.replace(/\n/g, '<br>');
}
function svgDataUrl(svg) {
  if (!svg) return '';
  try { return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`; } catch (e) { return ''; }
}
function renderPaper(paper) {
  viewPages.innerHTML = '';
  paper.items.forEach((item, index) => {
    if (index % 6 === 0) {
      const page = document.createElement('section');
      page.className = 'paper-sheet';
      page.innerHTML = `<div class="paper-title-row"><div><h2>数学错题巩固练习</h2><p>姓名：____________　日期：____________</p></div><span class="paper-total">第 ${Math.floor(index / 6) + 1} 页 · 共 ${paper.items.length} 题</span></div><div class="paper-list"></div>`;
      viewPages.appendChild(page);
    }
    const question = document.createElement('article');
    question.className = 'paper-question';
    question.innerHTML = `<div class="paper-question-head"><span class="paper-number">${index + 1}.</span><span class="paper-topic">${escapeHtml(item.topic || '综合练习')}</span></div><div class="paper-question-text">${renderMath(item.text)}</div>${item.cleanOriginalImage ? `<img class="paper-clean-figure" src="${item.cleanOriginalImage}" alt="清洁后的原题图" />` : (item.cleanFigureSvg ? `<img class="paper-clean-figure" src="${svgDataUrl(item.cleanFigureSvg)}" alt="题目清洁图" />` : '')}`;
    viewPages.lastElementChild.querySelector('.paper-list').appendChild(question);
  });
}
async function loadPaper() {
  const id = new URLSearchParams(location.search).get('id');
  try {
    const response = await fetch(`/api/paper?id=${encodeURIComponent(id || '')}`);
    const data = await response.json();
    if (!response.ok || !data.paper) throw new Error(data.error || '加载失败');
    viewStatus.hidden = true; viewPages.hidden = false; viewActionBar.hidden = false; renderPaper(data.paper);
    if (new URLSearchParams(location.search).get('download') === '1') setTimeout(() => window.print(), 350);
  } catch (error) { viewStatus.className = 'status-bar warn'; viewStatus.textContent = `试卷加载失败：${error.message || error}`; }
}
$('#downloadPdfBtn').addEventListener('click', () => window.print());
window.addEventListener('load', loadPaper);
