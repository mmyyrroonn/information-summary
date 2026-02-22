# Information Summary 项目技术架构报告

## 1. 项目概述

### 1.1 项目定位

这是一个 **Twitter 信息聚合与日报生成系统**，主要用于：
- 自动采集 Twitter 上的技术/开发相关信息
- 通过 AI 对推文进行分类和重要性评估
- 生成定制化的每日信息摘要报告
- 支持多订阅源管理和自动化分流

### 1.2 技术栈

| 层级 | 技术选型 |
|------|----------|
| 后端 | Node.js + Express + TypeScript |
| 前端 | React + TypeScript + Vite |
| 数据库 | PostgreSQL + Prisma ORM |
| AI | DeepSeek API / 阿里 DashScope (通义千问) |
| Embedding | 阿里 DashScope Text Embedding |
| 部署 | Docker + Docker Compose |

---

## 2. 系统架构

### 2.1 服务架构 (Docker Compose)

```
┌─────────────────────────────────────────────────────────────┐
│                      Docker Network                         │
├─────────────┬─────────────┬─────────────┬─────────────────┤
│    db       │   server    │   worker    │      web        │
│  (PostgreSQL) │  (API)    │  (后台任务)  │   (React UI)    │
│   :5432     │   :4000     │   x3        │    :4173        │
└─────────────┴─────────────┴─────────────┴─────────────────┘
```

**服务说明：**
- **db**: PostgreSQL 16-alpine 数据库
- **server**: Express API 服务器 (端口 4000)
- **worker/worker2/worker3**: 后台任务处理器 (3个实例)
- **web**: Nginx + React 前端 (端口 4173)

### 2.2 数据流架构

```
Twitter API ──▶ ingestService ──▶ Tweet (DB)
                                    │
                                    ▼
                           embeddingService (向量化)
                                    │
                                    ▼
                           ai/classification (AI分类)
                                    │
                                    ▼
                           TweetInsight (AI分析结果)
                                    │
                                    ▼
                           clusterService (聚类)
                                    │
                                    ▼
                           ai/reporting (生成报告)
                                    │
                                    ▼
                           Report ──▶ GitHub Pages / Telegram
```

---

## 3. 数据库设计

### 3.1 核心数据模型

#### User (用户)
```prisma
model User {
  id        String   @id @default(uuid())
  username  String   @unique
  password  String
  role      String   @default("user")  // "admin" | "user"
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  subscriptions      Subscription[]
  reports           Report[]
  notificationConfig NotificationConfig?
}
```

**说明：**
- 支持 admin/user 两种角色
- admin 可访问管理功能 (订阅管理、Embedding缓存、DEV工具)
- 每个用户可拥有独立的订阅源和通知配置

#### Subscription (订阅源)
```prisma
model Subscription {
  id            String   @id @default(uuid())
  screenName    String   @unique      // Twitter screen name
  displayName   String?
  avatarUrl     String?
  tags          String[] @default([]) // 标签分组
  status        SubscriptionStatus @default(SUBSCRIBED)
  unsubscribedAt DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastFetchedAt DateTime?

  // User relation (null = default subscription shared by all)
  userId        String?
  user          User?    @relation(fields: [userId], references: [id])

  tweets        Tweet[]

  @@index([status, lastFetchedAt])
  @@index([userId])
}
```

**说明：**
- 记录 Twitter 账户信息
- 支持用户私有订阅和全局共享订阅 (userId=null)
- 按标签分组管理

#### Tweet (推文)
```prisma
model Tweet {
  id             String   @id @default(uuid())
  tweetId        String   @unique           // Twitter 原生 ID
  subscription   Subscription @relation(fields: [subscriptionId], references: [id])
  subscriptionId String
  authorName     String
  authorScreen   String
  text           String
  lang           String?
  raw            Json                     // 原始 API 响应
  tweetedAt      DateTime
  createdAt      DateTime @default(now())
  tweetUrl       String?
  processedAt    DateTime?               // 何时被分类
  abandonedAt    DateTime?               // 何时被放弃
  abandonReason  String?
  routingStatus  RoutingStatus @default(PENDING)
  routingTag     String?                 // 分流标签
  routingScore   Float?                  // 相似度分数
  routingMargin  Float?                  // 分类边界
  routingReason  String?                 // 分类原因
  routedAt       DateTime?
  llmQueuedAt    DateTime?
  insights       TweetInsight?
  embedding      TweetEmbedding?

  @@index([routingStatus, routingTag])
  @@index([routingStatus, llmQueuedAt])
}
```

**RoutingStatus 枚举：**
- `PENDING`: 待处理
- `IGNORED`: 已忽略
- `AUTO_HIGH`: 向量相似度高，自动保留
- `ROUTED`: 已分流
- `LLM_QUEUED`: 待 AI 处理
- `COMPLETED`: AI 处理完成

#### TweetInsight (AI 分析结果)
```prisma
model TweetInsight {
  id          String   @id @default(uuid())
  tweet       Tweet    @relation(fields: [tweetId], references: [tweetId])
  tweetId     String   @unique
  verdict     String          // 分类判断
  summary     String?         // 摘要
  importance  Int?            // 重要性 1-5
  tags        String[]        // AI 生成的标签
  suggestions String?         // 建议
  embedding           Float[] @default([])        // 摘要向量化
  embeddingModel     String?
  embeddingDimensions Int?
  embeddingTextHash  String?
  embeddedAt         DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  aiRun       AiRun?   @relation(fields: [aiRunId], references: [id])
  aiRunId     String?
}
```

#### TweetEmbedding (推文向量)
```prisma
model TweetEmbedding {
  id                 String   @id @default(uuid())
  tweet              Tweet    @relation(fields: [tweetId], references: [tweetId])
  tweetId            String   @unique
  embedding          Float[]  @default([])   // 推文内容向量
  model              String
  dimensions         Int
  textHash           String
  embeddedAt         DateTime
  summaryEmbedding   Float[]  @default([])  // 摘要向量
  summaryModel       String?
  summaryDimensions  Int?
  summaryTextHash    String?
  summaryEmbeddedAt  DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

#### AiRun (AI 任务执行记录)
```prisma
model AiRun {
  id          String      @id @default(uuid())
  kind        AiRunKind               // TWEET_CLASSIFY | REPORT_SUMMARY
  status      AiRunStatus @default(PENDING)
  prompt      String?
  response    String?
  error       String?
  createdAt   DateTime    @default(now())
  completedAt DateTime?
  insights    TweetInsight[]
  report      Report?
}
```

#### Report (生成的报告)
```prisma
model Report {
  id             String   @id @default(uuid())
  periodStart    DateTime
  periodEnd      DateTime
  headline       String
  content        String
  outline        Json?
  createdAt      DateTime @default(now())
  publishedAt    DateTime?
  aiRun          AiRun?   @relation(fields: [aiRunId], references: [id])
  aiRunId        String?  @unique
  profile        ReportProfile? @relation(fields: [profileId], references: [id])
  profileId      String?
  deliveredAt    DateTime?
  deliveryTarget String?   // "github" | "telegram"

  // User relation
  userId         String?
  user           User?    @relation(fields: [userId], references: [id])

  @@index([userId])
}
```

#### ReportProfile (报告配置)
```prisma
model ReportProfile {
  id                     String   @id @default(uuid())
  name                   String
  enabled                Boolean  @default(true)
  scheduleCron           String   // Cron 表达式
  windowHours            Int      // 时间窗口小时数
  timezone               String   // 时区
  includeTweetTags       String[] @default([])
  excludeTweetTags       String[] @default([])
  includeAuthorTags      String[] @default([])
  excludeAuthorTags      String[] @default([])
  minImportance          Int      @default(2)
  verdicts               String[] @default([])
  groupBy                String   @default("cluster")  // "cluster" | "tag"
  aiFilterEnabled        Boolean  @default(true)
  aiFilterPrompt         String?
  aiFilterMaxKeepPerChunk Int?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  reports                Report[]

  @@index([enabled, scheduleCron])
}
```

#### BackgroundJob (后台任务)
```prisma
model BackgroundJob {
  id           String              @id @default(uuid())
  type         String              // 任务类型
  payload      Json?               // 任务参数
  status       BackgroundJobStatus @default(PENDING)
  attempts     Int                 @default(0)
  maxAttempts  Int                 @default(3)
  scheduledAt  DateTime            @default(now())
  lockedAt     DateTime?
  lockedBy     String?
  completedAt  DateTime?
  lastError    String?
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt

  @@index([status, scheduledAt])
  @@index([type, status])
}
```

#### SystemLock (分布式锁)
```prisma
model SystemLock {
  key       String   @id
  lockedBy  String?
  lockedAt  DateTime?
  expiresAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

#### 缓存模型
- **RoutingEmbeddingCache**: 向量分类缓存 (正负样本)
- **RoutingTagEmbeddingCache**: 标签向量化缓存
- **NotificationConfig**: 用户通知配置 (Telegram)

---

## 4. 后端服务层架构

### 4.1 目录结构

```
server/src/
├── config.ts           # 环境配置 (Zod 验证)
├── db.ts               # Prisma 客户端
├── errors.ts           # 自定义错误类
├── logger.ts           # 日志工具
├── server.ts           # Express 应用工厂
├── worker.ts           # Worker 入口
├── middleware/
│   └── auth.ts         # JWT 认证中间件
├── routes/             # API 路由
│   ├── index.ts        # 路由汇总
│   ├── auth.ts         # 认证
│   ├── subscriptions.ts
│   ├── tweets.ts
│   ├── reports.ts
│   ├── reportProfiles.ts
│   ├── tasks.ts
│   ├── tasksDev.ts
│   ├── config.ts
│   └── tags.ts
└── services/           # 业务逻辑
    ├── authService.ts
    ├── tweetService.ts
    ├── subscriptionService.ts
    ├── reportService.ts
    ├── clusterService.ts
    ├── embeddingService.ts
    ├── notificationService.ts
    ├── jobService.ts
    ├── lockService.ts
    ├── aiService.ts
    ├── ai/             # AI 子模块
    │   ├── classification.ts
    │   ├── embeddingText.ts
    │   ├── routing.ts
    │   ├── reporting.ts
    │   ├── openaiClient.ts
    │   └── shared.ts
    └── ...
```

### 4.2 核心服务详解

#### 4.2.1 twitterService.ts / ingestService.ts
- **职责**: 从 Twitter API 拉取推文数据
- **依赖**: RapidAPI (Twitter API)
- **功能**:
  - 批量获取订阅用户的最近推文
  - 增量更新 (12小时冷却期)

#### 4.2.2 embeddingService.ts
- **职责**: 向量化处理
- **依赖**: 阿里 DashScope Text Embedding API
- **配置**:
  - `EMBEDDING_MODEL`: text-embedding-v4
  - `EMBEDDING_DIMENSIONS`: 512

#### 4.2.3 ai/classification.ts
- **职责**: AI 推文分类
- **依赖**: DeepSeek API / 阿里 DashScope
- **功能**:
  - 判断推文相关性 (verdict)
  - 生成摘要 (summary)
  - 评估重要性 (importance 1-5)
  - 生成标签 (tags)

#### 4.2.4 ai/routing.ts
- **职责**: 智能分流
- **功能**:
  - 基于向量相似度自动分类
  - 正负样本学习
  - 缓存管理

#### 4.2.5 ai/reporting.ts
- **职责**: 报告生成
- **功能**:
  - 按时间窗口聚合推文
  - 聚类分析
  - 生成结构化报告

#### 4.2.6 clusterService.ts
- **职责**: 推文聚类
- **算法**: 基于向量余弦相似度
- **配置**:
  - `REPORT_CLUSTER_THRESHOLD`: 0.86 (相似度阈值)
  - `REPORT_CLUSTER_CROSS_TAG_BUMP`: 0.04 (跨标签增益)

#### 4.2.7 notificationService.ts
- **职责**: 通知发送
- **支持**: Telegram Bot
- **功能**:
  - 推送新报告
  - 高分推文提醒

#### 4.2.8 githubPublishService.ts
- **职责**: GitHub Pages 发布
- **功能**:
  - 提交报告到 GitHub 仓库
  - 自动更新索引

#### 4.2.9 jobService.ts / lockService.ts
- **职责**: 后台任务调度与分布式锁
- **功能**:
  - BackgroundJob 表驱动任务队列
  - SystemLock 表实现分布式锁
  - 支持多 Worker 并发

---

## 5. API 路由设计

### 5.1 路由汇总

| 前缀 | 路由文件 | 功能 |
|------|----------|------|
| `/api/auth` | auth.ts | 登录/登出/JWT |
| `/api/subscriptions` | subscriptions.ts | 订阅源管理 |
| `/api/tweets` | tweets.ts | 推文查询/分析 |
| `/api/reports` | reports.ts | 报告查看 |
| `/api/report-profiles` | reportProfiles.ts | 报告配置 |
| `/api/config` | config.ts | 系统配置 |
| `/api/tags` | tags.ts | 标签管理 |
| `/api/tasks` | tasks.ts | 任务状态 |
| `/api/dev` | tasksDev.ts | 开发工具 |

### 5.2 认证机制

```typescript
// 中间件
authMiddleware     // 强制认证
adminOnly         // 仅管理员
optionalAuthMiddleware  // 可选认证
```

**JWT Payload:**
```typescript
interface JWTPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  iat: number;
  exp: number;
}
```

### 5.3 核心 API 端点

#### Tweets API
```
GET  /api/tweets?page=1&pageSize=20&sort=newest
     参数:
       - page, pageSize
       - sort: newest | oldest | priority
       - routing: default | ignored | all
       - routingCategory: embedding-high | embedding-low | llm | ignored-other | pending
       - routingTag, routingScoreMin, routingScoreMax
       - subscriptionId
       - startTime, endTime
       - q: 搜索关键词
       - embeddingQ: 向量搜索
       - importanceMin, importanceMax

POST /api/tweets/analyze  { tweetIds: string[] }
     手动触发 AI 分析

GET  /api/tweets/stats
     获取推文统计

GET  /api/tweets/routing-stats
     获取分流统计
```

---

## 6. 前端架构

### 6.1 目录结构

```
web/src/
├── api.ts              # API 调用封装 (15885 bytes)
├── apiBase.ts          # API 基类
├── auth.ts             # 认证工具
├── types.ts            # 类型定义 (9952 bytes)
├── App.tsx             # 主应用
├── App.css             # 全局样式
├── index.css           # 入口样式
├── main.tsx            # React 入口
├── assets/             # 静态资源
└── pages/              # 页面组件
    ├── Dashboard.tsx       # 日报浏览
    ├── Tweets.tsx          # 推文浏览
    ├── Analytics.tsx       # 数据分析
    ├── RoutingAnalytics.tsx # 分流分析
    ├── Subscriptions.tsx  # 订阅管理
    ├── EmbeddingCache.tsx # Embedding 缓存
    ├── DevJobs.tsx        # DEV 工具
    └── Login.tsx          # 登录页
```

### 6.2 页面功能

| 页面 | 路径键 | 功能 | 权限 |
|------|--------|------|------|
| Dashboard | dashboard | 浏览生成的日报 | 全部用户 |
| Tweets | tweets | 搜索/筛选推文 | 全部用户 |
| Analytics | analytics | 数据统计分析 | 全部用户 |
| RoutingAnalytics | routing-analytics | 分流效果分析 | 仅 admin |
| Subscriptions | subscriptions | 订阅源管理 | 仅 admin |
| EmbeddingCache | embedding-cache | 向量缓存管理 | 仅 admin |
| DevJobs | dev | 开发工具/任务管理 | 仅 admin |
| Login | - | 登录页面 | 全部 |

### 6.3 API 调用封装

```typescript
// api.ts 核心结构
class ApiClient {
  // 认证
  login(username, password): Promise<AuthToken>

  // 推文
  getTweets(params): Promise<Paginated<Tweet>>
  analyzeTweets(tweetIds): Promise<AnalysisResult>

  // 订阅
  getSubscriptions(): Promise<Subscription[]>
  createSubscription(data): Promise<Subscription>

  // 报告
  getReports(): Promise<Report[]>
  getReportProfiles(): Promise<ReportProfile[]>

  // 统计
  getTweetStats(params): Promise<TweetStats>
  getRoutingStats(params): Promise<RoutingStats>
}
```

### 6.4 认证流程

1. 用户登录 → `/api/auth/login`
2. 服务端返回 JWT Token
3. 前端存储到 localStorage
4. 后续请求自动携带 `Authorization: Bearer <token>`
5. Token 过期或无效 → 跳转登录页

---

## 7. 配置系统

### 7.1 环境配置 (config.ts)

```typescript
// 数据库
DATABASE_URL: string

// Twitter API
RAPIDAPI_HOST: string
RAPIDAPI_KEY: string

// AI
DEEPSEEK_API_KEY: string
DASHSCOPE_API_KEY: string
SOCIAL_DIGEST_PROVIDER: 'deepseek' | 'dashscope'
SOCIAL_DIGEST_DEEPSEEK_MODEL: string
SOCIAL_DIGEST_DASHSCOPE_MODEL: string

// Embedding
EMBEDDING_MODEL: string
EMBEDDING_DIMENSIONS: number

// 报告
REPORT_CLUSTER_THRESHOLD: number
REPORT_CLUSTER_CROSS_TAG_BUMP: number
REPORT_MIN_IMPORTANCE: number

// Telegram 通知
TG_BOT_TOKEN: string
TG_CHAT_ID: string
TG_MESSAGE_THREAD_ID: string
TG_HIGH_SCORE_MESSAGE_THREAD_ID: string

// 定时任务
FETCH_CRON_SCHEDULE: string        // */1 * * * *
CLASSIFY_CRON_SCHEDULE: string     // */5 * * * *
REPORT_TIMEZONE: string            // Asia/Shanghai

// GitHub Pages
GITHUB_PAGES_REPO_PATH: string
GITHUB_PAGES_BRANCH: string
GITHUB_PAGES_REPORT_DIR: string
GITHUB_PAGES_AUTO_PUBLISH: boolean
```

---

## 8. 部署架构

### 8.1 Docker 服务配置

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    volumes: /Users/qiufan/Fan/docker-data/postgres:/var/lib/postgresql/data

  server:
    build: ./server
    ports: [4000:4000]
    depends_on: [db]

  worker:
    build: ./server
    command: npx prisma migrate deploy && node dist/worker.js

  worker2:
    <<: *worker-base

  worker3:
    <<: *worker-base

  web:
    build: ./web
    ports: [4173:80]
    depends_on: [server]
```

### 8.2 Worker 任务类型

- **tweet_fetch**: 拉取新推文
- **tweet_classify**: AI 分类推文
- **tweet_embedding**: 向量化推文
- **report_generate**: 生成报告
- **report_deliver**: 发送报告
- **subscription_import**: 导入订阅

---

## 9. 核心业务流程

### 9.1 推文采集流程

```
1. Worker 定时触发 (FETCH_CRON_SCHEDULE)
   ↓
2. ingestService.fetchAllSubscriptions()
   ↓
3. 遍历所有订阅，调用 Twitter API
   ↓
4. 增量保存到 Tweet 表
   ↓
5. 更新 Subscription.lastFetchedAt
```

### 9.2 AI 分类流程

```
1. Worker 定时触发 (CLASSIFY_CRON_SCHEDULE)
   ↓
2. 从 Tweet 表筛选 PENDING 状态的推文
   ↓
3. 批量调用 embeddingService 创建向量
   ↓
4. ai/routing.ts 进行初步分类
   ↓
5. 高相似度 → AUTO_HIGH
   ↓
6. 低相似度 → IGNORED
   ↓
7. 不确定 → LLM_QUEUED
   ↓
8. ai/classification.ts 调用 LLM 深度分析
   ↓
9. 保存结果到 TweetInsight
   ↓
10. 更新 Tweet.routingStatus = COMPLETED
```

### 9.3 报告生成流程

```
1. Cron 定时触发 (ReportProfile.scheduleCron)
   ↓
2. ai/reporting.ts 获取时间窗口内的推文
   ↓
3. 应用 ReportProfile 过滤条件
   ↓
4. clusterService 聚类分析
   ↓
5. 构建报告 prompt
   ↓
6. 调用 LLM 生成报告内容
   ↓
7. 保存 Report 记录
   ↓
8. notificationService 发送通知
   ↓
9. 可选: githubPublishService 发布到 GitHub Pages
```

---

## 10. 技术亮点

### 10.1 向量相似度分类
- 使用 Embedding 向量计算推文相似度
- 正负样本学习机制
- 缓存机制优化性能

### 10.2 分布式任务处理
- BackgroundJob 表驱动任务队列
- SystemLock 实现分布式锁
- 多 Worker 并发处理

### 10.3 灵活的报告配置
- 多 ReportProfile 支持
- Cron 定时调度
- 多渠道推送 (Telegram / GitHub Pages)

### 10.4 向量搜索
- 支持语义搜索推文
- 实时创建查询向量
- 余弦相似度排序

---

## 11. 安全性

- **认证**: JWT Token
- **权限**: admin/user 角色分离
- **密码**: 加密存储
- **API**: Bearer Token 验证
- **中间件**: authMiddleware 统一拦截

---

## 12. 扩展性

- **多订阅源**: 支持用户私有订阅
- **多报告配置**: 支持多个 ReportProfile
- **多通知渠道**: Telegram + GitHub Pages
- **多 AI 提供商**: DeepSeek / 阿里 DashScope

---

*报告生成时间: 2026-02-22*
