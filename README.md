# API 模型监控面板

实时监控 OpenAI 兼容 API 端点的模型可用性状态。

## 功能

- 每5分钟自动检查所有模型的可用性
- 前台仪表盘展示模型可用率（环形图 + 历史点阵）
- 支持搜索过滤模型
- 管理后台：API 密钥配置、模型管理、站点设置、检查日志
- 深色主题 + 响应式设计

## Zeabur 一键部署

### 步骤

1. 将项目推送到 GitHub
2. 在 [Zeabur](https://zeabur.com) 创建项目
3. 添加 GitHub 仓库服务（Zeabur 会自动检测 Dockerfile）
4. **配置持久化磁盘**（重要！）：
   - 进入服务设置 → 磁盘(Disk)
   - 添加磁盘，挂载路径设为 `/data`
   - 这样重启服务后检查数据不会丢失
5. 配置环境变量：
   - `ADMIN_PASSWORD` — 管理员密码（默认 `admin123`）
   - `API_KEY` — API 密钥（如需要）
   - `API_BASE_URL` — API 端点（默认 `https://sta1n.zeabur.app/v1`）
6. 绑定域名即可访问

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `9292` | 服务端口 |
| `ADMIN_PASSWORD` | `admin123` | 管理员密码 |
| `API_BASE_URL` | `https://sta1n.zeabur.app/v1` | API 端点 |
| `API_KEY` | 空 | API 密钥 |
| `DATA_DIR` | `/data` | 数据存储目录 |

### 数据持久化

SQLite 数据库文件存储在 `/data/monitor.db`。

在 Zeabur 上必须为 `/data` 目录添加持久化磁盘，否则每次重启容器数据会丢失。

## 访问地址

- 前台仪表盘：`/`
- 管理后台：`/admin`

## 本地开发

```bash
npm install
node server.js
# 访问 http://localhost:9292
```
