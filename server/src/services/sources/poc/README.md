# 多信息源 PoC 脚本

本目录验证 YouTube / Bilibili / 微信公众号 三个新信息源能否在当前条件下取到可用数据。**不接入主流水线**，跑通后再做 SourceAdapter 抽象和数据库迁移。

## 运行方式

每个脚本独立可跑，需要在 `server/` 目录下，提前在 `.env` 或临时变量里设置好密钥。

```bash
cd server

# YouTube — 需要 Google Cloud YouTube Data API v3 key
YOUTUBE_API_KEY=AIza... \
YOUTUBE_TEST_CHANNEL=@veritasium \
YOUTUBE_TEST_MAX=3 \
npx ts-node-dev --transpile-only src/services/sources/poc/youtube.poc.ts

# Bilibili — 默认拉「影视飓风」(mid=1629347259)，可换成任意 UP 主 mid
BILIBILI_TEST_MID=1629347259 \
npx ts-node-dev --transpile-only src/services/sources/poc/bilibili.poc.ts

# 可选：带 SESSDATA cookie，访问需登录的内容（如某些动态）
BILIBILI_TEST_MID=1629347259 \
BILIBILI_SESSDATA=your_sessdata_here \
npx ts-node-dev --transpile-only src/services/sources/poc/bilibili.poc.ts

# 微信 — 需要先在 https://wechat2rss.xlab.app 订阅一个公众号拿到 feed URL
WECHAT_RSS_FEED_URL=https://wechat2rss.xlab.app/feed/<id>.xml \
npx ts-node-dev --transpile-only src/services/sources/poc/wechat-rss.poc.ts
```

## 各平台关键设计点

### YouTube
- **元数据走官方 API**（`googleapis`）：每次抓一个频道大约消耗 3 units（channels.list 1 + playlistItems.list 1 + videos.list 1，与视频数量基本无关），免费配额 10K/天，可监控数百个频道。
- **字幕走 `youtube-transcript`**：完全免费，不消耗官方配额。它通过 YouTube INNERTUBE API 模拟 Android 客户端拉字幕。
- 字段映射：`title + description + transcript` → `NormalizedPost.text`；`videoId` → `externalId`；`https://www.youtube.com/watch?v=<id>` → `url`。
- 风险：`youtube-transcript` 是反编译实现，YouTube 改内部协议可能失效；但社区维护较好。

### Bilibili
- **WBI 签名是必须的**（视频列表接口）：脚本内置 `getMixinKey` + `signWbiParams` 实现，参考 `bilibili-API-collect` 文档。
- 视频详情接口（`/x/web-interface/view`）公开，不需要签名。
- 动态接口（`/x/polymer/web-dynamic/v1/feed/space`）通常需要 SESSDATA。
- 风险：风控（412 Precondition Failed）；带 UA + Referer 通常能绕过；高频访问需要 cookie。

### 微信公众号
- **完全依赖 Wechat2RSS 第三方服务**（开源 + 公益运营，6h 延迟）。
- 文章正文在 `content:encoded` 字段，通常是完整 HTML，需要 strip tags。
- 用户订阅一个公众号 = 在 wechat2rss.xlab.app 上搜索后拿到一个 feed URL。
- 风险：服务停摆 / 限流 / 公众号被屏蔽。备选：付费 API（新榜/西瓜数据）。

---

## 结论记录（每次跑完更新）

### YouTube
- [x] 跑通日期：2026-04-27
- [x] 测试频道：@veritasium
- [x] 字段验证：
  - `videoId` ✅
  - `title` ✅
  - `description` ✅（300+ 字符）
  - `publishedAt` ✅（ISO 8601）
  - `duration` ✅（ISO 8601 like `PT1M33S`）
  - `viewCount/likeCount/commentCount` ✅
  - `tags / thumbnailUrl / channelTitle` ✅
  - `transcript` ✅（auto 模式，30~42 段，1k~1.6k 字符；YouTube 自动给视频原始语言字幕，不强制中文）
- [x] 配额消耗（实测）：**3 units/频道**，与视频数量无关
  - channels.list 1 + playlistItems.list 1 + videos.list 1
  - 10K 免费配额 → 可监控 ~3333 个频道/天
- [x] 异常情况处理：库错误信息清晰；脚本 try/catch 包裹
- [x] **结论**：✅ 完全可用
  - YouTube 路径在沙箱 IP + Anthropic 网络上 100% 工作
  - 字幕通过 `youtube-transcript` 免费拉取，不消耗 API 配额
  - 字段映射设计（进 adapter 时直接用）：
    - `videoId` → `Tweet.tweetId`
    - `https://www.youtube.com/watch?v=<id>` → `tweetUrl`
    - `publishedAt` → `tweetedAt`
    - `channelId` → `authorScreen`，`channelTitle` → `authorName`
    - `title + description + transcript_text` 拼接 → `text`
    - `thumbnailUrl` → `mediaUrls[0]`
    - `duration` (ISO 8601) parse → `durationSec`

### Bilibili
- [x] 跑通日期：2026-04-27（部分跑通；UP 视频列表受 IP 风控）
- [x] 测试 UP（mid）：508452265
- [x] 字段验证（基于 curl 直测公开接口）：
  - 视频详情 `desc/owner/stat` ✅
  - UP 计数 `/x/space/navnum` ✅
  - **UP 视频列表 wbi/legacy** ❌ — 在沙箱 IP 上被风控（-352/-412）
  - 动态 feed ❌ — 同样被风控
- [x] WBI 签名实现：✅ 正确（早期签名错时返 -412，签名对后变 -352）
- [x] 是否带 SESSDATA：未测；推测带上后可解决大部分问题
- [x] 异常情况处理：脚本能优雅捕获 -352/-412/-799 并打印
- [x] **结论**：
  - **架构可行**，PoC 脚本实现完整（WBI 签名 + bili_ticket + 反爬指纹 + buvid bootstrap）
  - **生产必须配 SESSDATA**——匿名访问 UP 空间接口在服务器 IP 上极不稳定
  - 部署时 B 站 adapter 设计要求：
    1. `Subscription` 级别支持配 SESSDATA cookie
    2. 必须实现 `-799 请求过于频繁`、`-352 风控` 的指数退避重试
    3. 国内 IP 部署（docker-compose 已经是国内场景应该 OK）
    4. 监控 cookie 有效期（SESSDATA 通常 30 天过期，需要刷新策略）

### 微信公众号
- [ ] 跑通日期：
- [ ] 测试公众号 / feed URL：
- [ ] 字段验证：
  - `title` ✅/❌
  - `link` ✅/❌
  - `pubDate/isoDate` ✅/❌
  - `content:encoded`（完整正文）✅/❌
  - `creator/author` ✅/❌
- [ ] 实测延迟：
- [ ] 服务稳定性观察：
- [ ] 结论：

---

## 跑通后的下一步

1. 把每个 PoC 脚本里实际验证过的字段沉淀到 `NormalizedPost` 接口设计
2. 启动新一轮实施计划：Prisma `Platform` enum、`SourceAdapter` 抽象、`ingestService` 改造、前端订阅 UI 扩展
3. 把 PoC 脚本里的取数逻辑包进各 adapter（`twitterAdapter` / `youtubeAdapter` / `bilibiliAdapter` / `wechatAdapter`）
