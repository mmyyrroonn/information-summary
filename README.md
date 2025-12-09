# 信息自动周报平台

统一服务负责推特订阅管理、推文抓取、DeepSeek AI 评估、报告生成以及 Telegram 推送。前端提供一个 React 控制台来管理订阅和配置，后端用 Node.js + Express 暴露 REST API，并用 Prisma + PostgreSQL 保持所有数据。

## 技术栈
- **API**：Node.js / Express 5、Prisma ORM、node-cron 调度
- **AI**：DeepSeek（OpenAI 兼容 SDK）按批次处理推文并生成周报模板
- **订阅/推文**：RapidAPI `twitter-api45` 时间线接口，扩展数据源时只需实现新的 service
- **通知**：Telegram Bot API，可在 UI 中配置 bot token 和 chat id
- **前端**：Vite + React 19 + TypeScript，自带简单 UI/状态管理

## 目录结构
```
.
├── server/           # Express + Prisma 服务
│   ├── prisma/       # 数据模型
│   └── src/
│       ├── routes/   # REST API（订阅、任务、报告、配置）
│       ├── services/ # Twitter 拉取、AI 调度、推送
│       └── jobs/     # 每日定时任务
└── web/              # React 控制台
```

## 环境变量
在 `server/.env` 中配置：

| 变量 | 说明 |
| --- | --- |
| `PORT` | API 端口，默认 4000 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `RAPIDAPI_HOST` / `RAPIDAPI_KEY` | RapidAPI 推特接口配置 |
| `DEEPSEEK_API_KEY` | DeepSeek API key（OpenAI 兼容） |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | Telegram 推送默认配置，可在 UI 中覆盖 |
| `CRON_SCHEDULE` | `node-cron` 表达式，默认每天 03:00 |
| `REPORT_TIMEZONE` | 统计/展示使用的时区 |
| `BASE_WEB_URL` | 生成报告时引用的 Web 端地址 |

前端 `.env` 只需要 `VITE_API_BASE_URL` 指向后端 `/api`。

## 本地运行
1. 安装依赖
   ```bash
   cd server && npm install
   cd ../web && npm install
   ```
2. 初始化数据库
   ```bash
   # 复制 env
   cp server/.env.example server/.env
   # 根据需要修改 DATABASE_URL、API Key 等
   # 生成 Prisma Client
   cd server && npx prisma generate
   # 创建表（需要 Postgres 可用）
   npx prisma migrate dev --name init
   ```
3. 启动服务
   ```bash
   # 后端（需要正确的 env）
   cd server && npm run dev
   # 前端
   cd web && npm run dev
   ```
   前端默认运行在 `http://localhost:5173`，后端 `http://localhost:4000`。

## Docker Compose 一键启动
1. 准备环境变量  
   复制根目录的 `.env.compose.example` 为 `.env` 并填入真实的 RapidAPI / DeepSeek / Telegram 等 Key：
   ```bash
   cp .env.compose.example .env
   # 按需编辑 `.env`
   ```
2. 构建并启动所有服务（Postgres + API + Web）：
   ```bash
   docker compose up --build
   ```
   - Web 控制台：`http://localhost:4173`
   - API：`http://localhost:4000`
   - Postgres：暴露在 `localhost:5432`（默认账号/库见 `.env`）
   首次启动或 schema 变更后，容器会在启动时自动执行 `prisma migrate deploy`，也可以手动运行 `docker compose exec server npx prisma migrate deploy`。
3. 停止并清理：
   ```bash
   docker compose down
   # 如需连同数据卷一起清理
   docker compose down -v
   ```

## 功能流程
1. **订阅管理**：UI 可添加/删除查看订阅，也可单独对某个账号抓取当日推文。
2. **抓取任务**：`/api/tasks/fetch` 会遍历订阅账号，通过 RapidAPI 拉取当日新推文并落库。
3. **AI 筛选**：`/api/tasks/analyze` 读取未分析推文，调用 DeepSeek 批量打分，结构化写入 `TweetInsight`。
4. **报告生成**：`/api/tasks/report` 根据当日洞察生成 Markdown 周报，可选择是否立刻推送 Telegram。
5. **定时器**：`node-cron` 根据 `CRON_SCHEDULE` 串联以上 3 步并尝试推送。
6. **前端面板**：
   - 手动触发「抓取/AI/报告」
   - 配置 Telegram token/chat id
   - 查看历史周报并再次推送

## API 一览
- `GET /health`：存活检测
- `GET/POST/DELETE /api/subscriptions`：订阅 CRUD；`POST /api/subscriptions/:id/fetch` 手动抓取
- `POST /api/tasks/fetch|analyze|report`：手动触发工作流（report 支持 `{ notify: boolean }`）
- `GET /api/reports`、`GET /api/reports/:id`、`POST /api/reports/:id/send`
- `GET/PUT /api/config/notification`：管理 Telegram 配置

## 构建与发布
- 后端：`cd server && npm run build`（需要提供 `DATABASE_URL` 等 env）
- 前端：`cd web && npm run build`
- 生产运行建议：先执行 `prisma migrate deploy`，然后用 `npm run start` 启动编译后的服务；前端可由任意静态服务器托管。

## 后续扩展建议
- 数据源接口抽象已经写在 `twitterService` 中，可以按相同签名再接其它平台。
- 可以为 `AiRun`/`Report` 增加更细粒度状态展示或重试逻辑。
- 如果需要多租户或登录，可在前端增加鉴权并在后端加 session/token middleware。
