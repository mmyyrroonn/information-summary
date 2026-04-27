# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Twitter 信息聚合与自动日报生成平台。从 Twitter 抓取推文，经 AI 分类/评分/向量路由后，聚类生成日报并推送到 Telegram / GitHub Pages。

Monorepo 结构：`server/`（Express API + 后台 worker）和 `web/`（React 前端）。

## Development Commands

### Backend (server/)
```bash
npm run dev              # ts-node-dev 热重载开发服务器
npm run worker:dev       # 后台 worker 开发模式
npm run build            # TypeScript 编译到 dist/
npm run start            # 生产运行 (node dist/index.js)
npm run worker           # 生产运行 worker (node dist/worker.js)
npx prisma migrate dev --name <name>   # 创建新迁移
npx prisma migrate deploy              # 应用迁移
npx prisma generate                    # 重新生成 Prisma client
```

### Frontend (web/)
```bash
npm run dev       # Vite 开发服务器 (localhost:5173)
npm run build     # tsc -b && vite build
npm run lint      # ESLint
```

### Docker (全栈)
```bash
docker compose up --build    # 构建并启动 (db + server + worker×3 + web)
docker compose down -v       # 停止并清理数据卷
```

## Architecture

### 两个进程入口
- **API Server** (`server/src/index.ts`): Express HTTP 服务 + cron 调度器。启动时创建默认管理员账号并注册定时任务。
- **Background Worker** (`server/src/worker.ts`): 从 `BackgroundJob` 表轮询任务并执行。Docker Compose 中运行 3 个 worker 实例。

### 数据流水线
```
Twitter API → ingestService (抓取落库)
  → routing (向量路由: embedding + cosine similarity 初筛)
    → classification (LLM 分类/评分/摘要)
      → clusterService (余弦相似度聚类, threshold=0.86)
        → reportService (日报生成)
          → notificationService (Telegram) / githubPublishService (GitHub Pages)
```

### 核心服务层 (server/src/services/)
- **ai/routing.ts**: 向量路由，用 embedding cache 做快速正负样本匹配，决定推文是否需要 LLM 处理
- **ai/classification.ts**: LLM 批量分类，输出 verdict/importance/summary/tags
- **ai/reporting.ts**: 从聚类结果生成结构化日报（最大文件，~82KB）
- **clusterService.ts**: 基于 summary embedding 的余弦相似度聚类
- **embeddingService.ts**: DashScope text-embedding-v4 向量生成
- **jobService.ts / jobs/**: 数据库驱动的任务队列 + 分布式锁

### 任务调度
Cron 调度器 (`jobs/scheduler.ts`) 向 `BackgroundJob` 表插入任务，worker 实例竞争领取执行。`SystemLock` 表防止并发冲突。

### AI 多供应商
通过 `SOCIAL_DIGEST_PROVIDER` 切换 DeepSeek / DashScope / MiniMax。客户端封装在 `ai/openaiClient.ts`（OpenAI 兼容）和 `ai/minimaxClient.ts`。

### 认证与权限
JWT 认证，角色分 admin/user/guest。admin 可管理订阅和配置，guest 只能浏览报告和推文。中间件在 `middleware/auth.ts`。

### 前端
React 19 + Vite，无路由库，用 tab 切换页面。`web/src/api.ts` 封装所有 API 调用，`web/src/types.ts` 定义共享类型。Nginx 反向代理 `/api/` 到后端。

## Tech Stack
- **Backend**: Express 5, TypeScript, Prisma (PostgreSQL), Zod (config validation), node-cron
- **Frontend**: React 19, Vite, marked + dompurify (Markdown 渲染)
- **AI**: OpenAI SDK (DeepSeek/DashScope 兼容), MiniMax API, DashScope embedding
- **Infra**: Docker Compose, Nginx, PostgreSQL 16

## Key Conventions
- 环境变量统一在 `server/src/config.ts` 通过 Zod schema 验证，所有配置从 `config` 对象读取
- 后端 CommonJS (`"type": "commonjs"`)，前端 ESM (`"type": "module"`)
- Prisma schema 在 `server/prisma/schema.prisma`，迁移文件在 `server/prisma/migrations/`
- 路由聚合在 `server/src/routes/index.ts`，按资源拆分文件
- 没有测试框架，AI 服务有手动测试文件 (`*.test.ts`)
- Docker 构建目标包含 `linux-arm64-openssl-3.0.x`（ARM 部署支持）
