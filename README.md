# FreeLLMAPI（修改版）

## 项目来源

本项目 fork 自 [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)（v0.4.1），原项目以 MIT 协议开源。原作者保留所有版权。

原项目将多家 LLM 提供商的免费额度聚合到一个 OpenAI 兼容的 `/v1` API 端点之后，提供路由、故障转移、密钥加密存储、管理面板等功能。完整的原始文档请见上游仓库。

---

## 本仓库所做的修改

以下改动均基于上游 v0.4.1，未向回上游提交 PR。

### 1. 移除每月令牌额度与配额追踪系统

### 2. 模型 RPM / RPD 限额可在前端编辑

### 3. 密钥页：为每个提供商增加已添加模型列表

### 4. 去除付费高级版（Premium / Live Catalog）

移除了原项目的付费订阅与远程目录同步系统。

### 5. 添加密钥后自动拉取模型列表

### 6. 自定义端点无需手动输入模型 ID

### 7. 修复 auto 路由忽略自定义端点模型

---

## 部署说明


```bash
# 1. 安装依赖并构建
npm install
npm run build          # 编译 server (tsc) + client (vite build)

# 2. 配置 .env（至少需要 ENCRYPTION_KEY）
#    参照 .env.example，必填项：
#      ENCRYPTION_KEY=<64位十六进制>
#      PORT=3001

# 3. 启动（服务端 + 内置面板均服务在 :3001）
node server/dist/index.js
```

打开 http://ip:3001 即可访问管理面板。

### 配置项

所有配置通过项目根目录 `.env` 文件设置，完整说明见 `.env.example`。关键项：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENCRYPTION_KEY` | — | **必填**（生产环境）。用于加密存储的 API 密钥（AES-256-GCM） |
| `PORT` | `3001` | 服务监听端口 |
| `HOST` | `::` | 监听地址；设 `127.0.0.1` 仅限本机，`0.0.0.0` 仅 IPv4 |
| `FREEAPI_DB_PATH` | `server/data/freeapi.db` | SQLite 数据库文件路径 |
| `PROXY_RATE_LIMIT_RPM` | `120` | 每客户端 IP 每分钟请求上限；`0` 关闭 |
| `REQUEST_ANALYTICS_RETENTION_DAYS` | `90` | 分析数据保留天数 |
| `FREELLMAPI_CONTEXT_HANDOFF` | 关闭 | 设为 `on_model_switch` 在模型切换时注入上下文交接消息 |

<details>
<summary>可选配置（点击展开）</summary>

| 变量 | 说明 |
|------|------|
| `RESPONSE_CACHE` | 响应缓存，默认 `false`；设 `true` 开启 LRU 内存缓存 |
| `RESPONSE_CACHE_TTL_SECONDS` | 缓存有效期，默认 `3600` |
| `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS` | 阻止自定义端点指向内网/本地地址 |
| `FREEAPI_DB_BACKUP_PATH` | 加密 SQLite 备份路径 |
| `FREEAPI_CONFIG_PATH` | 声明式启动配置 JSON 文件路径 |
| `DASHBOARD_ORIGINS` | 额外允许的 CORS 来源 |

</details>

### 首次启动

1. 服务器启动后，在浏览器打开 `http://localhost:3001`
2. 首次访问会要求创建管理员账号（邮箱 + 密码）
   - 若从本机浏览器访问，直接创建即可
   - 若从其他设备远程访问，需先查看服务端启动日志中的一次性 setup code
3. 进入 **Keys** 页面，添加各 LLM 提供商的 API 密钥
   - 添加密钥后会自动从提供商拉取可用模型列表
   - 自定义 OpenAI 兼容端点可不填模型 ID，添加后通过模型发现对话框拉取
4. 在 **Models** 页面调整 fallback chain 顺序与路由策略
5. 从 **Keys** 页面顶部复制 unified API key（`freellmapi-…`），用于客户端配置

### 客户端接入

将任何 OpenAI 兼容客户端的 `base_url` 指向 `http://localhost:3001/v1`，使用 unified key 认证：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # 让路由器自动选择；也可指定具体模型
    messages=[{"role": "user", "content": "你好"}],
)
```

**Claude Code** 接入（Anthropic Messages API）：

```bash
export ANTHROPIC_BASE_URL=http://localhost:3001
export ANTHROPIC_AUTH_TOKEN=freellmapi-your-unified-key   # 注意不是 ANTHROPIC_API_KEY
claude
```

### 进程管理（推荐）

使用 PM2 或 systemd 保持服务持续运行：

```bash
# PM2
npm run build
pm2 start "node server/dist/index.js" --name freellmapi
pm2 save
pm2 startup        # 开机自启
```

---

## 许可证

[MIT](./LICENSE)（继承自上游）
