# FreeLLMAPI（修改版）

将多家 LLM 提供商的免费额度聚合到一个 OpenAI 兼容的 `/v1` 端点之后，提供智能路由、自动故障转移、密钥加密存储、可视化管理面板等功能。

本项目 fork 自 [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)（v0.4.1，MIT 协议），原作者保留所有版权。

---

## 功能特性

- **多提供商聚合**：支持 30+ LLM 提供商的免费额度，包括 Google Gemini、Groq、Cerebras、NVIDIA、Mistral、OpenRouter、GitHub Models、Cohere、Cloudflare、HuggingFace、Ollama Cloud、SiliconFlow 等，以及任意自定义 OpenAI 兼容端点（Ollama / vLLM / LM Studio / llama.cpp）
- **智能路由**：基于贝叶斯多臂老虎机的实时评分系统，按可靠性、速度、智能度三维加权自动选择最优模型；提供 balanced / smartest / fastest / reliable / custom 五种预设策略，也支持手动优先级链
- **自动故障转移**：请求失败时自动切换到下一个可用模型/密钥，支持速率限制冷却、支付墙检测、错误重试
- **多协议兼容**：
  - OpenAI Chat Completions API（`/v1/chat/completions`）
  - OpenAI Responses API（`/v1/responses`，Codex CLI 兼容）
  - Anthropic Messages API（`/v1/messages`，Claude Code 兼容）
  - OpenAI Embeddings API（`/v1/embeddings`，同族跨提供商故障转移）
  - 图片生成 & 语音合成（`/v1/images/generations`、`/v1/audio/speech`）
  - MCP 协议网关（`/mcp`，为 MCP 客户端提供路由查询、健康检查等工具）
- **Fusion 融合推理**：调用 `model: "fusion"` 时，一组模型并行作答，再由评审模型综合出更优答案
- **管理面板**：内置 React 单页应用，支持密钥管理、模型配置、路由策略调整、请求分析、内置 Playground
- **安全特性**：API 密钥 AES-256-GCM 加密存储、统一密钥认证、首次访问安全码、CORS 控制、可选 SSRF 防护
- **多语言界面**：支持中文、英语、法语、西班牙语、葡萄牙语、意大利语
- **声明式配置**：通过 JSON 文件在启动时自动配置密钥、模型、路由策略

---

## 本仓库所做的修改

以下改动均基于上游 v0.4.1，未向回上游提交 PR。

1. **移除每月令牌额度与配额追踪系统**
2. **模型 RPM / RPD 限额可在前端编辑**
3. **密钥页：为每个提供商增加已添加模型列表**
4. **去除付费高级版（Premium / Live Catalog）**：移除付费订阅与远程目录同步系统
5. **添加密钥后自动拉取模型列表**
6. **自定义端点无需手动输入模型 ID**：添加后通过模型发现对话框拉取
7. **修复 auto 路由忽略自定义端点模型**
8. **模型智能值可以在前端编辑**：原项目自定义端点模型智能值为 0，且所有模型不可编辑
9. **模型默认上下文长度改为 256K**：添加模型时默认上下文长度从 8K 提升到 256K，避免路由器因上下文估算过小而误判模型不可用

---

## 部署说明

### 方式一：Docker（推荐）

镜像发布在 GHCR，开箱即用：

```bash
# 1. 创建工作目录并生成 .env
mkdir freellmapi && cd freellmapi
#    Linux / macOS:
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
#    Windows PowerShell:
# $ENCRYPTION_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# "ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env

# 2. 下载 docker-compose.yml 并启动
#    Linux / macOS:
curl -fsSL https://raw.githubusercontent.com/haicker/freellmapi/main/docker-compose.yml -o docker-compose.yml
docker compose up -d

# 查看日志
docker compose logs -f
```

镜像地址：`ghcr.io/haicker/freellmapi:latest`

容器端口默认绑定到 `0.0.0.0:3001`，可通过 `http://<服务器IP>:3001` 访问。SQLite 数据持久化在 `freellmapi-data` volume 中。

> 如需限制仅本机访问，在 `.env` 中加 `HOST=127.0.0.1`，并将 `docker-compose.yml` 的端口映射改为 `127.0.0.1:3001:3001`。

#### 更新 Docker 部署

```bash
# 1. 拉取最新镜像
docker compose pull

# 2. 重启容器（数据不丢失）
docker compose up -d

# 3.（可选）清理旧镜像释放空间
docker image prune -f
```

- **数据安全**：SQLite 数据持久化在 `freellmapi-data` volume 中，更新镜像不会丢失数据。
- **镜像标签**：`docker-compose.yml` 默认使用 `latest`，`docker compose pull` 会自动拉取最新版本。
- **固定版本**：若不想自动跟随 `latest`，可将 `docker-compose.yml` 中的镜像标签改为具体版本号，例如 `ghcr.io/haicker/freellmapi:v0.1.1`。

<details>
<summary>自定义端口或其他环境变量</summary>

在 `.env` 中添加所需变量即可（compose 通过 `env_file` 自动注入），例如：

```env
ENCRYPTION_KEY=your-64-char-hex
PORT=8080
PROXY_RATE_LIMIT_RPM=60
REQUEST_ANALYTICS_RETENTION_DAYS=30
```

改端口后同步修改 `docker-compose.yml` 的 `ports` 映射。

</details>

### 方式二：直接运行（Node.js）

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

## 配置项

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

---

## 快速开始

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

**Fusion 融合推理**（多模型并行作答 + 评审综合）：

```python
resp = client.chat.completions.create(
    model="fusion",  # 一组模型并行作答，评审模型综合出更优答案
    messages=[{"role": "user", "content": "解释量子纠缠"}],
)
```

---

## 支持的提供商

| 提供商 | 说明 |
|--------|------|
| Google Gemini | 原生 Gemini API 格式 |
| Groq / Cerebras / NVIDIA NIM | 高速推理，OpenAI 兼容 |
| Mistral / OpenRouter / GitHub Models | OpenAI 兼容 |
| Cohere / Cloudflare Workers AI | 各自兼容端点 |
| Zhipu AI (智谱) / HuggingFace Router | OpenAI 兼容 |
| Ollama Cloud / LLM7 / Kilo / OVH | 免费/无密钥访问 |
| OpenCode Zen / Reka / SiliconFlow / Routeway 等 | 多家聚合器 |
| AI Horde | 社区驱动的免费推理 |
| Custom | 任意 OpenAI 兼容端点（Ollama / vLLM / LM Studio / llama.cpp） |

---

## 许可证

[MIT](./LICENSE)（继承自上游）
