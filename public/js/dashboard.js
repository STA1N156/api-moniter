// ============================================================
// 前台仪表盘逻辑
// ============================================================

const REFRESH_INTERVAL = 30000;
let refreshTimer = null;
let isFetching = false;
let cachedModels = []; // 缓存模型数据供搜索用
let lastDataHash = ''; // 上次数据哈希，避免重复刷新 DOM
let currentMaxHistory = 25; // 从后端读取的最大历史记录数

// ============================================================
// 工具函数
// ============================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function formatTime(isoStr) {
  if (!isoStr) return '未知';
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  return `${Math.floor(diffHour / 24)} 天前`;
}

function getAvailabilityColor(pct) {
  if (pct >= 70) return 'var(--success)';
  if (pct >= 40) return 'var(--warning)';
  return 'var(--danger)';
}

function getCardStatusClass(pct) {
  if (pct >= 70) return 'status-good';
  if (pct >= 40) return 'status-warn';
  return 'status-bad';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// SVG 环形进度图
// ============================================================
function createRingSVG(percentage) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  const color = getAvailabilityColor(percentage);

  return `
    <div class="ring-container">
      <svg class="ring-svg" viewBox="0 0 64 64">
        <circle class="ring-bg" cx="32" cy="32" r="${radius}" />
        <circle class="ring-progress" cx="32" cy="32" r="${radius}"
          stroke="${color}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"
          style="transition: stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1)" />
      </svg>
      <div class="ring-text" style="color: ${color}">
        ${percentage}<span class="percent">%</span>
      </div>
    </div>
  `;
}

// ============================================================
// 历史记录点阵
// ============================================================
function createHistoryDots(history, maxHistory = 25) {
  const dots = [];
  const sorted = [...history].reverse();
  for (let i = sorted.length; i < maxHistory; i++) {
    dots.push('<div class="history-dot empty"></div>');
  }
  for (const record of sorted) {
    const cls = record.success ? 'success' : 'fail';
    const label = record.success ? `${record.latency}ms` : '失败';
    dots.push(`
      <div class="history-dot ${cls}">
        <div class="tooltip">${label}</div>
      </div>
    `);
  }
  return `<div class="history-dots">${dots.join('')}</div>`;
}

// ============================================================
// 模型卡片（移除底部 meta，精简设计）
// ============================================================
function createModelCard(model) {
  const statusClass = getCardStatusClass(model.availability);

  return `
    <div class="model-card ${statusClass}" data-model-id="${escapeHtml(model.id)}" data-model-name="${escapeHtml(model.name)}">
      <div class="model-card-header">
        <div class="model-info">
          <div class="model-name">${escapeHtml(model.name)}</div>
        </div>
        ${createRingSVG(model.availability)}
      </div>
      ${createHistoryDots(model.history, currentMaxHistory)}
    </div>
  `;
}

// ============================================================
// 搜索
// ============================================================
function setupSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    filterModels(query);
  });
}

function filterModels(query) {
  const cards = document.querySelectorAll('.model-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const name = (card.dataset.modelName || '').toLowerCase();
    const id = (card.dataset.modelId || '').toLowerCase();
    const match = !query || name.includes(query) || id.includes(query);
    card.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });

  const countEl = document.getElementById('search-count');
  if (query) {
    countEl.textContent = `${visibleCount} / ${cards.length}`;
  } else {
    countEl.textContent = `${cards.length} 个模型`;
  }
}

// ============================================================
// 渲染主逻辑
// ============================================================
// 简单的数据指纹生成，用于判断数据是否变化
function computeDataHash(data) {
  const models = data.models || [];
  // 用模型 ID + 可用率 + 最后检查时间 生成指纹
  return models.map(m => `${m.id}:${m.availability}:${m.lastCheck ? m.lastCheck.time : ''}`).join('|');
}

async function fetchAndRender() {
  if (isFetching) return;
  isFetching = true;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // 计算数据指纹
    const newHash = computeDataHash(data);
    const dataChanged = (newHash !== lastDataHash);
    lastDataHash = newHash;

    // 更新标题（轻量操作，始终执行）
    const titleEl = document.getElementById('site-title');
    const newTitle = data.title || 'API 模型监控面板';
    if (titleEl.textContent !== newTitle) {
      titleEl.textContent = newTitle;
      document.title = newTitle;
    }

    // 状态始终显示“运行中”，不再显示“检测中”
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    if (statusDot.className !== 'status-dot') statusDot.className = 'status-dot';
    if (statusText.textContent !== '运行中') statusText.textContent = '运行中';

    // 更新公告
    const announcementEl = document.getElementById('announcement');
    if (data.announcement) {
      document.getElementById('announcement-text').textContent = data.announcement;
      announcementEl.style.display = 'flex';
    } else {
      announcementEl.style.display = 'none';
    }

    const models = data.models || [];
    cachedModels = models;
    currentMaxHistory = data.maxHistory || 25;

    // 如果数据没有变化，跳过 DOM 重建
    if (!dataChanged && !document.querySelector('#models-container .empty-state') && !document.querySelector('#models-container .loading-spinner')) {
      return;
    }

    // 渲染模型卡片
    const container = document.getElementById('models-container');
    
    if (models.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
          <h3>暂无可用模型</h3>
          <p>系统正在初始化，请稍候...</p>
        </div>
      `;
      document.getElementById('search-count').textContent = '';
      return;
    }

    // 按分组渲染
    const groups = data.groups || {};
    let html = '';
    const groupNames = Object.keys(groups).sort();
    
    for (const groupName of groupNames) {
      const groupModels = groups[groupName];
      if (groupModels.length === 0) continue;
      
      if (groupNames.length > 1) {
        html += `<div class="group-title">${escapeHtml(groupName)} (${groupModels.length})</div>`;
      }
      
      html += '<div class="model-grid">';
      groupModels.sort((a, b) => b.availability - a.availability);
      for (const model of groupModels) {
        html += createModelCard(model);
      }
      html += '</div>';
    }

    container.innerHTML = html;

    // 更新搜索计数
    const searchInput = document.getElementById('search-input');
    const currentQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (currentQuery) {
      filterModels(currentQuery);
    } else {
      document.getElementById('search-count').textContent = `${models.length} 个模型`;
    }

  } catch (err) {
    console.error('获取数据失败:', err);
    const container = document.getElementById('models-container');
    if (container.querySelector('.empty-state') || container.querySelector('.loading-state')) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          <h3>连接失败</h3>
          <p>无法获取服务器数据，将在30秒后重试...</p>
        </div>
      `;
    }
  } finally {
    isFetching = false;
  }
}

// ============================================================
// 启动
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  fetchAndRender();
  setupSearch();
  refreshTimer = setInterval(fetchAndRender, REFRESH_INTERVAL);
});
