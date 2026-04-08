const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 9292;
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.NODE_ENV === 'production'
  ? path.join(DATA_DIR, 'monitor.db')
  : path.join(__dirname, 'monitor.db');

// ============================================================
// 中间件
// ============================================================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// /admin 路由别名
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============================================================
// 数据库初始化
// ============================================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS check_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    success INTEGER NOT NULL,
    latency INTEGER DEFAULT 0,
    error_msg TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_check_model ON check_results(model);
  CREATE INDEX IF NOT EXISTS idx_check_time ON check_results(checked_at);
`);

// 默认配置
const DEFAULT_CONFIG = {
  api_base_url: process.env.API_BASE_URL || 'https://sta1n.zeabur.app/v1',
  api_key: process.env.API_KEY || '',
  admin_password: process.env.ADMIN_PASSWORD || '156456aa',
  check_interval: '5',        // 分钟
  check_timeout: '30',        // 秒
  test_message: 'Hi',
  site_title: 'API 模型监控面板',
  site_announcement: '',
  hidden_models: '[]',        // JSON 数组，隐藏不展示的模型
  model_aliases: '{}',        // JSON 对象，模型别名映射
  model_groups: '{}',         // JSON 对象，模型分组
  max_history: '25',          // 保留的最大历史记录数
};

// 初始化默认配置
const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
  insertConfig.run(key, value);
}

// 配置读写辅助
function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_CONFIG[key] || '';
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

// ============================================================
// Token 认证
// ============================================================
const activeSessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未授权' });
  }
  const token = authHeader.slice(7);
  const session = activeSessions.get(token);
  if (!session || session.expires < Date.now()) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'Token 过期' });
  }
  next();
}

// ============================================================
// HTTP 请求工具（兼容 CommonJS，不依赖 node-fetch）
// ============================================================
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const timeout = (options.timeout || 30) * 1000;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: timeout,
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => {
            try { return JSON.parse(data); }
            catch { return null; }
          },
          text: () => data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ============================================================
// 健康检查核心逻辑
// ============================================================
let isChecking = false;
let lastCheckTime = null;
let lastCheckEndTime = null; // 上次检查完成的精确时间戳
let lastKnownModels = [];    // 最近一次从 API 获取到的模型 ID 列表

async function performHealthCheck() {
  if (isChecking) {
    console.log('[健康检查] 上一次检查仍在进行中，跳过');
    return;
  }

  isChecking = true;
  const apiBaseUrl = getConfig('api_base_url');
  const apiKey = getConfig('api_key');
  const checkTimeout = parseInt(getConfig('check_timeout')) || 30;
  const testMessage = getConfig('test_message') || 'Hi';
  const maxHistory = parseInt(getConfig('max_history')) || 20;

  console.log(`[健康检查] 开始 - ${new Date().toISOString()}`);
  console.log(`[健康检查] 端点: ${apiBaseUrl}`);

  try {
    // 1. 获取模型列表
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const modelsRes = await httpRequest(`${apiBaseUrl}/models`, {
      headers,
      timeout: checkTimeout,
    });

    if (!modelsRes.ok) {
      console.log(`[健康检查] 获取模型列表失败: HTTP ${modelsRes.status}`);
      isChecking = false;
      lastCheckTime = new Date().toISOString();
      return;
    }

    const modelsData = modelsRes.json();
    if (!modelsData || !modelsData.data) {
      console.log('[健康检查] 模型列表格式异常');
      isChecking = false;
      lastCheckTime = new Date().toISOString();
      return;
    }

    const models = modelsData.data.map(m => m.id);
    const hiddenModels = JSON.parse(getConfig('hidden_models') || '[]');
    const visibleModels = models.filter(m => !hiddenModels.includes(m));
    lastKnownModels = [...models]; // 记录本次获取到的模型列表

    console.log(`[健康检查] 发现 ${models.length} 个模型, ${visibleModels.length} 个可见`);

    // 2. 逐个模型测试
    const insertResult = db.prepare(
      'INSERT INTO check_results (model, success, latency, error_msg, checked_at) VALUES (?, ?, ?, ?, datetime(\'now\'))'
    );

    for (const modelId of models) {
      const startTime = Date.now();
      try {
        const chatRes = await httpRequest(`${apiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          timeout: checkTimeout,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: testMessage }],
            max_tokens: 10,
          }),
        });

        const latency = Date.now() - startTime;

        if (chatRes.ok) {
          insertResult.run(modelId, 1, latency, null);
          console.log(`  [OK] ${modelId} - ${latency}ms`);
        } else {
          const errText = chatRes.text();
          insertResult.run(modelId, 0, latency, `HTTP ${chatRes.status}: ${errText.substring(0, 200)}`);
          console.log(`  [FAIL] ${modelId} - HTTP ${chatRes.status} - ${latency}ms`);
        }
      } catch (err) {
        const latency = Date.now() - startTime;
        insertResult.run(modelId, 0, latency, err.message);
        console.log(`  [ERROR] ${modelId} - ${err.message} - ${latency}ms`);
      }
    }

    // 3. 清理旧记录：每个模型只保留最近 maxHistory 条
    const allModels = db.prepare('SELECT DISTINCT model FROM check_results').all();
    const deleteOld = db.prepare(`
      DELETE FROM check_results WHERE model = ? AND id NOT IN (
        SELECT id FROM check_results WHERE model = ? ORDER BY checked_at DESC LIMIT ?
      )
    `);
    for (const { model } of allModels) {
      deleteOld.run(model, model, maxHistory);
    }

    lastCheckTime = new Date().toISOString();
    lastCheckEndTime = Date.now();
    console.log(`[健康检查] 完成 - ${lastCheckTime}`);
  } catch (err) {
    console.error('[健康检查] 异常:', err.message);
    lastCheckTime = new Date().toISOString();
  } finally {
    isChecking = false;
  }
}

// ============================================================
// 定时任务
// ============================================================
let cronJob = null;

function setupCronJob() {
  if (cronJob) cronJob.stop();
  const interval = parseInt(getConfig('check_interval')) || 5;
  cronJob = cron.schedule(`*/${interval} * * * *`, () => {
    performHealthCheck();
  });
  console.log(`[定时任务] 已设置: 每 ${interval} 分钟执行一次`);
}

// ============================================================
// 公共 API
// ============================================================

// 获取所有模型状态概览
app.get('/api/status', (req, res) => {
  const hiddenModels = JSON.parse(getConfig('hidden_models') || '[]');
  const aliases = JSON.parse(getConfig('model_aliases') || '{}');
  const groups = JSON.parse(getConfig('model_groups') || '{}');
  const maxHistory = parseInt(getConfig('max_history')) || 20;

  // 只显示最近一次健康检查获取到的模型（排除隐藏的）
  const allModels = lastKnownModels.length > 0
    ? lastKnownModels
    : db.prepare('SELECT DISTINCT model FROM check_results').all().map(r => r.model);
  const visibleModels = allModels.filter(m => !hiddenModels.includes(m));

  const models = [];
  for (const modelId of visibleModels) {
    const records = db.prepare(
      'SELECT success, latency, error_msg, checked_at FROM check_results WHERE model = ? ORDER BY checked_at DESC LIMIT ?'
    ).all(modelId, maxHistory);

    const total = records.length;
    const successCount = records.filter(r => r.success).length;
    const availability = total > 0 ? Math.round((successCount / total) * 100) : 0;
    const avgLatency = total > 0
      ? Math.round(records.reduce((sum, r) => sum + (r.latency || 0), 0) / total)
      : 0;
    const lastCheck = records.length > 0 ? records[0] : null;

    models.push({
      id: modelId,
      name: aliases[modelId] || modelId,
      group: groups[modelId] || '默认',
      availability,
      avgLatency,
      totalChecks: total,
      successCount,
      lastCheck: lastCheck ? {
        success: !!lastCheck.success,
        latency: lastCheck.latency,
        error: lastCheck.error_msg,
        time: lastCheck.checked_at,
      } : null,
      history: records.map(r => ({
        success: !!r.success,
        latency: r.latency,
        time: r.checked_at,
      })),
    });
  }

  // 按分组整理
  const grouped = {};
  for (const model of models) {
    if (!grouped[model.group]) grouped[model.group] = [];
    grouped[model.group].push(model);
  }

  // 计算下次检查倒计时
  const checkIntervalMs = (parseInt(getConfig('check_interval')) || 5) * 60 * 1000;
  let nextCheckIn = null;
  let nextCheckProgress = 0;
  if (lastCheckEndTime && !isChecking) {
    const elapsed = Date.now() - lastCheckEndTime;
    nextCheckIn = Math.max(0, checkIntervalMs - elapsed);
    nextCheckProgress = Math.min(100, (elapsed / checkIntervalMs) * 100);
  }

  res.json({
    title: getConfig('site_title'),
    announcement: getConfig('site_announcement'),
    lastCheckTime,
    isChecking,
    totalModels: models.length,
    checkInterval: parseInt(getConfig('check_interval')) || 5,
    nextCheckIn,
    nextCheckProgress,
    groups: grouped,
    models,
    maxHistory,
  });
});

// ============================================================
// 管理 API
// ============================================================

// 登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = getConfig('admin_password');

  if (password !== adminPassword) {
    return res.status(401).json({ error: '密码错误' });
  }

  const token = generateToken();
  activeSessions.set(token, {
    expires: Date.now() + 24 * 60 * 60 * 1000, // 24小时
  });

  res.json({ token });
});

// 获取配置
app.get('/api/admin/config', authMiddleware, (req, res) => {
  const config = getAllConfig();
  // 不返回密码原文
  delete config.admin_password;
  res.json(config);
});

// 更新配置
app.put('/api/admin/config', authMiddleware, (req, res) => {
  const updates = req.body;
  const allowedKeys = [
    'api_base_url', 'api_key', 'admin_password', 'check_interval',
    'check_timeout', 'test_message', 'site_title', 'site_announcement',
    'hidden_models', 'model_aliases', 'model_groups', 'max_history'
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedKeys.includes(key)) {
      setConfig(key, value);
    }
  }

  // 如果修改了检查间隔，重新设置定时任务
  if (updates.check_interval) {
    setupCronJob();
  }

  res.json({ success: true });
});

// 手动触发检查
app.post('/api/admin/check-now', authMiddleware, async (req, res) => {
  if (isChecking) {
    return res.json({ message: '检查正在进行中...' });
  }
  res.json({ message: '已触发健康检查' });
  performHealthCheck();
});

// 获取检查日志
app.get('/api/admin/logs', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = db.prepare(
    'SELECT * FROM check_results ORDER BY checked_at DESC LIMIT ?'
  ).all(limit);
  res.json(logs);
});

// 清除数据
app.delete('/api/admin/data', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM check_results').run();
  res.json({ success: true, message: '所有检查数据已清除' });
});

// 获取所有发现的模型（含隐藏的）
app.get('/api/admin/all-models', authMiddleware, (req, res) => {
  const allModels = db.prepare('SELECT DISTINCT model FROM check_results').all().map(r => r.model);
  res.json(allModels);
});

// ============================================================
// 启动服务
// ============================================================
app.listen(PORT, () => {
  console.log(`====================================`);
  console.log(`  API 模型监控面板`);
  console.log(`  运行端口: ${PORT}`);
  console.log(`  数据库: ${DB_PATH}`);
  console.log(`====================================`);

  setupCronJob();

  // 启动后延迟10秒执行一次检查
  setTimeout(() => {
    console.log('[启动] 执行首次健康检查...');
    performHealthCheck();
  }, 10000);
});
