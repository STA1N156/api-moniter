// ============================================================
// 管理后台逻辑
// ============================================================

let authToken = localStorage.getItem('admin_token') || null;

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

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };
}

async function apiRequest(url, options = {}) {
  if (!options.headers) options.headers = apiHeaders();
  const res = await fetch(url, options);
  if (res.status === 401) {
    authToken = null;
    localStorage.removeItem('admin_token');
    showLoginView();
    showToast('登录已过期，请重新登录', 'error');
    throw new Error('Unauthorized');
  }
  return res;
}

// ============================================================
// 视图切换
// ============================================================
function showLoginView() {
  document.getElementById('login-view').style.display = 'flex';
  document.getElementById('admin-view').style.display = 'none';
}

function showAdminView() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('admin-view').style.display = 'block';
  loadConfig();
  loadOverview();
}

// ============================================================
// 登录
// ============================================================
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  
  if (!password) {
    showToast('请输入密码', 'error');
    return;
  }

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 登录中...';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();
    
    if (!res.ok) {
      showToast(data.error || '登录失败', 'error');
      return;
    }

    authToken = data.token;
    localStorage.setItem('admin_token', authToken);
    showToast('登录成功', 'success');
    showAdminView();
  } catch (err) {
    showToast('网络错误', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg> 登录';
  }
});

// ============================================================
// 退出
// ============================================================
document.getElementById('logout-btn').addEventListener('click', () => {
  authToken = null;
  localStorage.removeItem('admin_token');
  showLoginView();
  showToast('已退出', 'info');
});

// ============================================================
// 侧边栏导航
// ============================================================
document.querySelectorAll('.sidebar-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const section = item.dataset.section;
    
    // 切换活动状态
    document.querySelectorAll('.sidebar-nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${section}`).classList.add('active');

    // 切换到日志时加载
    if (section === 'logs') loadLogs();
    if (section === 'models') loadDiscoveredModels();
  });
});

// ============================================================
// 加载配置
// ============================================================
async function loadConfig() {
  try {
    const res = await apiRequest('/api/admin/config');
    const config = await res.json();

    document.getElementById('cfg-api-base-url').value = config.api_base_url || '';
    document.getElementById('cfg-api-key').value = config.api_key || '';
    document.getElementById('cfg-check-interval').value = config.check_interval || '5';
    document.getElementById('cfg-check-timeout').value = config.check_timeout || '30';
    document.getElementById('cfg-test-message').value = config.test_message || 'Hi';
    document.getElementById('cfg-max-history').value = config.max_history || '20';
    document.getElementById('cfg-site-title').value = config.site_title || '';
    document.getElementById('cfg-site-announcement').value = config.site_announcement || '';

    // 重试配置
    try {
      const codes = JSON.parse(config.retry_status_codes || '[]');
      document.getElementById('cfg-retry-status-codes').value = codes.join(',');
    } catch { document.getElementById('cfg-retry-status-codes').value = ''; }
    document.getElementById('cfg-retry-count').value = config.retry_count || '1';

    // 模型管理
    try {
      const hidden = JSON.parse(config.hidden_models || '[]');
      document.getElementById('cfg-hidden-models').value = hidden.join('\n');
    } catch { document.getElementById('cfg-hidden-models').value = ''; }

    try {
      const disabled = JSON.parse(config.disabled_models || '[]');
      document.getElementById('cfg-disabled-models').value = disabled.join('\n');
    } catch { document.getElementById('cfg-disabled-models').value = ''; }

    document.getElementById('cfg-model-aliases').value = config.model_aliases || '{}';
    document.getElementById('cfg-model-groups').value = config.model_groups || '{}';
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      showToast('加载配置失败', 'error');
    }
  }
}

// ============================================================
// 加载概览 + 倒计时
// ============================================================
let countdownTimer = null;
let countdownData = { nextCheckIn: null, isChecking: false, checkInterval: 5 };

async function loadOverview() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('admin-stat-models').textContent = data.totalModels || 0;
    
    // 更新倒计时数据
    countdownData.nextCheckIn = data.nextCheckIn;
    countdownData.isChecking = data.isChecking;
    countdownData.checkInterval = data.checkInterval || 5;
    countdownData.fetchedAt = Date.now();

    updateCountdownUI();
    startCountdownTimer();
    
    const logsRes = await apiRequest('/api/admin/logs?limit=1000');
    const logs = await logsRes.json();
    document.getElementById('admin-stat-checks').textContent = logs.length;
  } catch (err) {
    // ignore
  }
}

function startCountdownTimer() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    updateCountdownUI();
  }, 1000);

  // 每30秒重新拉取服务端数据以保持同步
  setInterval(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(data => {
        countdownData.nextCheckIn = data.nextCheckIn;
        countdownData.isChecking = data.isChecking;
        countdownData.checkInterval = data.checkInterval || 5;
        countdownData.fetchedAt = Date.now();
      })
      .catch(() => {});
  }, 30000);

  // 每2秒轮询检查进度
  setInterval(() => {
    pollCheckProgress();
  }, 2000);
}

function pollCheckProgress() {
  fetch('/api/check-progress')
    .then(r => r.json())
    .then(data => {
      const card = document.getElementById('check-progress-card');
      if (!card) return;

      if (data.isChecking && data.currentModel) {
        card.style.display = 'block';
        document.getElementById('check-progress-model').textContent = data.currentModel;
        document.getElementById('check-progress-count').textContent = `${data.current}/${data.total}`;
        const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
        document.getElementById('check-progress-bar').style.width = `${pct}%`;
      } else {
        card.style.display = 'none';
      }
    })
    .catch(() => {});
}

function updateCountdownUI() {
  const card = document.getElementById('countdown-card');
  const label = document.getElementById('countdown-label');
  const timeEl = document.getElementById('countdown-time');
  const barFill = document.getElementById('countdown-bar-fill');
  
  if (!card) return;

  if (countdownData.isChecking) {
    card.classList.add('checking');
    label.textContent = '正在检查中';
    timeEl.textContent = '...';
    barFill.style.width = '100%';
    return;
  }

  card.classList.remove('checking');

  if (countdownData.nextCheckIn === null || countdownData.nextCheckIn === undefined) {
    label.textContent = '等待首次检查';
    timeEl.textContent = '--:--';
    barFill.style.width = '0%';
    return;
  }

  // 根据获取时间差实时计算剩余时间
  const elapsed = Date.now() - (countdownData.fetchedAt || Date.now());
  const remaining = Math.max(0, countdownData.nextCheckIn - elapsed);
  const totalMs = countdownData.checkInterval * 60 * 1000;
  const progress = Math.min(100, ((totalMs - remaining) / totalMs) * 100);

  const totalSec = Math.ceil(remaining / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  
  label.textContent = '距离下次检查';
  timeEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  barFill.style.width = `${progress}%`;
}

// ============================================================
// 保存 API 配置
// ============================================================
document.getElementById('form-api').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // 解析重试状态码
    const retryCodesStr = document.getElementById('cfg-retry-status-codes').value.trim();
    const retryCodes = retryCodesStr ? retryCodesStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];

    await apiRequest('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({
        api_base_url: document.getElementById('cfg-api-base-url').value,
        api_key: document.getElementById('cfg-api-key').value,
        check_interval: document.getElementById('cfg-check-interval').value,
        check_timeout: document.getElementById('cfg-check-timeout').value,
        test_message: document.getElementById('cfg-test-message').value,
        max_history: document.getElementById('cfg-max-history').value,
        retry_status_codes: JSON.stringify(retryCodes),
        retry_count: document.getElementById('cfg-retry-count').value,
      }),
    });
    showToast('API 配置已保存', 'success');
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('保存失败', 'error');
  }
});

// ============================================================
// 保存模型配置
// ============================================================
document.getElementById('btn-save-models').addEventListener('click', async () => {
  const hiddenText = document.getElementById('cfg-hidden-models').value.trim();
  const hiddenArr = hiddenText ? hiddenText.split('\n').map(s => s.trim()).filter(Boolean) : [];

  const disabledText = document.getElementById('cfg-disabled-models').value.trim();
  const disabledArr = disabledText ? disabledText.split('\n').map(s => s.trim()).filter(Boolean) : [];

  const aliasesStr = document.getElementById('cfg-model-aliases').value.trim() || '{}';
  const groupsStr = document.getElementById('cfg-model-groups').value.trim() || '{}';

  // 验证 JSON
  try { JSON.parse(aliasesStr); } catch { showToast('模型别名 JSON 格式错误', 'error'); return; }
  try { JSON.parse(groupsStr); } catch { showToast('模型分组 JSON 格式错误', 'error'); return; }

  try {
    await apiRequest('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({
        hidden_models: JSON.stringify(hiddenArr),
        disabled_models: JSON.stringify(disabledArr),
        model_aliases: aliasesStr,
        model_groups: groupsStr,
      }),
    });
    showToast('模型配置已保存', 'success');
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('保存失败', 'error');
  }
});

// ============================================================
// 保存站点设置
// ============================================================
document.getElementById('form-site').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiRequest('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({
        site_title: document.getElementById('cfg-site-title').value,
        site_announcement: document.getElementById('cfg-site-announcement').value,
      }),
    });
    showToast('站点设置已保存', 'success');
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('保存失败', 'error');
  }
});

// ============================================================
// 修改密码
// ============================================================
document.getElementById('form-security').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPwd = document.getElementById('cfg-new-password').value;
  const confirmPwd = document.getElementById('cfg-confirm-password').value;

  if (!newPwd) { showToast('请输入新密码', 'error'); return; }
  if (newPwd !== confirmPwd) { showToast('两次密码不一致', 'error'); return; }
  if (newPwd.length < 4) { showToast('密码至少4位', 'error'); return; }

  try {
    await apiRequest('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({ admin_password: newPwd }),
    });
    showToast('密码已修改', 'success');
    document.getElementById('cfg-new-password').value = '';
    document.getElementById('cfg-confirm-password').value = '';
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('修改失败', 'error');
  }
});

// ============================================================
// 立即检查
// ============================================================
document.getElementById('btn-check-now').addEventListener('click', async () => {
  try {
    const res = await apiRequest('/api/admin/check-now', { method: 'POST' });
    const data = await res.json();
    showToast(data.message, 'success');
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('触发失败', 'error');
  }
});

// ============================================================
// 清除数据
// ============================================================
document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm('确定要清除所有检查数据吗？此操作不可恢复。')) return;
  try {
    await apiRequest('/api/admin/data', { method: 'DELETE' });
    showToast('数据已清除', 'success');
    loadOverview();
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('清除失败', 'error');
  }
});

// ============================================================
// 加载日志
// ============================================================
async function loadLogs() {
  try {
    const res = await apiRequest('/api/admin/logs?limit=200');
    const logs = await res.json();
    const tbody = document.getElementById('logs-tbody');

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);">暂无日志记录</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map(log => `
      <tr>
        <td style="white-space:nowrap;">${log.checked_at || '--'}</td>
        <td style="font-family:monospace;font-size:0.78rem;">${escapeHtml(log.model)}</td>
        <td>${log.success ? '<span class="badge badge-success">成功</span>' : '<span class="badge badge-danger">失败</span>'}</td>
        <td>${log.latency}ms</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.78rem;color:var(--text-secondary);">${log.error_msg ? escapeHtml(log.error_msg) : '-'}</td>
      </tr>
    `).join('');
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('加载日志失败', 'error');
  }
}

document.getElementById('btn-refresh-logs').addEventListener('click', loadLogs);

// ============================================================
// 加载已发现的模型
// ============================================================
async function loadDiscoveredModels() {
  try {
    const res = await apiRequest('/api/admin/all-models');
    const models = await res.json();
    const container = document.getElementById('discovered-models-list');

    if (models.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;">暂未发现任何模型，请先执行健康检查。</p>';
      return;
    }

    container.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${models.map(m => `
          <span style="padding:4px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:99px;font-size:0.78rem;font-family:monospace;">
            ${escapeHtml(m)}
          </span>
        `).join('')}
      </div>
    `;
  } catch (err) {
    // ignore
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  if (authToken) {
    // 验证 token 是否有效
    fetch('/api/admin/config', {
      headers: { 'Authorization': `Bearer ${authToken}` },
    }).then(res => {
      if (res.ok) {
        showAdminView();
      } else {
        authToken = null;
        localStorage.removeItem('admin_token');
        showLoginView();
      }
    }).catch(() => showLoginView());
  } else {
    showLoginView();
  }
});
