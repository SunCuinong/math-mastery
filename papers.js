'use strict';

const archiveStatus = document.querySelector('#archiveStatus');
const archiveList = document.querySelector('#archiveList');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function paperCard(paper) {
  const completed = paper.status === 'completed';
  const card = document.createElement('article');
  card.className = 'paper-record archive-record';
  card.innerHTML = `
    <div>
      <div class="paper-record-title">练习卷 · ${paper.items.length} 题 <span class="paper-record-status ${completed ? 'completed' : ''}">${completed ? '已批改' : '待批改'}</span></div>
      <div class="paper-record-time">生成于 ${escapeHtml((paper.createdAt || '').replace('T', ' '))}${completed ? ` · 批改于 ${escapeHtml((paper.completedAt || '').replace('T', ' '))}` : ''}</div>
    </div>
    <div class="paper-record-actions">
      <a class="btn btn-ghost" href="paper-view.html?id=${encodeURIComponent(paper.id)}&download=1" target="_blank">下载 PDF</a>
      ${completed ? '<span class="paper-done">结果已计入题库</span>' : `<a class="btn btn-primary" href="mark.html?id=${encodeURIComponent(paper.id)}">去批改</a>`}
      <details class="more-menu"><summary aria-label="更多操作">•••</summary><div class="more-menu-popover"><button class="del delete-paper-record" data-id="${escapeHtml(paper.id)}" type="button">删除</button></div></details>
    </div>`;
  return card;
}

async function loadArchive() {
  try {
    const response = await fetch('/api/papers', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载失败');
    const papers = Array.isArray(data.papers) ? data.papers : [];
    archiveStatus.className = 'status-bar ok';
    archiveStatus.textContent = `共保存 ${papers.length} 份生成试卷`;
    archiveList.innerHTML = '';
    if (!papers.length) archiveList.innerHTML = '<div class="empty">还没有生成过试卷。</div>';
    papers.forEach(paper => archiveList.appendChild(paperCard(paper)));
    archiveList.querySelectorAll('.delete-paper-record').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('确定删除这份试卷记录？题库中的答题记录不会被删除。')) return;
        const response = await fetch('/api/paper/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: button.dataset.id })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          alert(`删除试卷失败：${data.error || '未知错误'}`);
          return;
        }
        loadArchive();
      });
    });
  } catch (error) {
    archiveStatus.className = 'status-bar warn';
    archiveStatus.textContent = `试卷档案加载失败：${error.message || error}`;
  }
}

loadArchive();
