# GEOInflow · Vercel 版部署指南

这是 GEOInflow（liekan v1.2.0）的 Vercel 改造版，位于 `vercel` 分支。官方 Docker 版的 5 个常驻服务被拆成 Vercel 能承载的形态，其余业务代码与上游保持一致。

## 架构对应关系

| Docker 版 | Vercel 版 |
| --- | --- |
| `app` 容器（Next.js standalone） | Vercel Next.js 部署（`vercel.json` 已配好构建命令） |
| PostgreSQL 16 容器 | Supabase Postgres（**Session pooler**，5432 端口） |
| Redis 容器（auth）+ analytics-cache | Upstash Redis（`REDIS_URL` + `LIEKAN_ANALYTICS_REDIS_URL` 可共用一个库） |
| `log-worker` 常驻进程 | `/api/cron/log-worker`：每次调用注册相同的 pg-boss 队列处理器，限时排空队列 |
| `analytics-worker` 常驻进程 | `/api/cron/analytics-worker`：同上，外加一轮 pump |
| Docker 启动时自动迁移 + 导入示例 | 部署前在本机跑一次 `pnpm vercel:bootstrap`（幂等，可重跑） |
| 官方 `src/proxy.ts` 精简版 | 已换成 Docker 生产版全量 proxy（CSP、采集端点改写等与生产一致） |

worker 唤醒方式（二选一）：

- **GitHub Actions（已内置，任意 Vercel 套餐可用）**：`.github/workflows/vercel-cron.yml` 每 5 分钟 curl 两个端点。需要在仓库 Secrets 里配 `APP_URL` 和 `CRON_SECRET`。GitHub 的定时任务可能延迟几分钟。
- **Vercel Cron（Pro 套餐）**：在 `vercel.json` 里加 `crons` 配置指向同样两个路径即可，Vercel 会自动带上 `CRON_SECRET` 鉴权头。

## 部署步骤

### 1. 建数据库（Supabase）

新建一个 Supabase 项目，在 Settings → Database 里拿两条连接串：

- **Session pooler**（5432）→ Vercel 的 `DATABASE_URL`
- **Direct connection**（db.xxx.supabase.co:5432）→ 本地 bootstrap 用的 `DIRECT_DATABASE_URL`

注意：pg-boss 依赖会话级特性，运行时**不要**用 Transaction pooler（6543）。

### 2. 建 Redis（Upstash）

新建一个 Upstash Redis，拿 `rediss://` 连接串，填 `REDIS_URL` 和 `LIEKAN_ANALYTICS_REDIS_URL`（可共用）。

### 3. 初始化数据库（执行一次，二选一）

**方式 A：GitHub Actions（推荐，不用装本地环境）**
在仓库 Settings → Secrets and variables → Actions 里新增 secret `DATABASE_URL`（填 Session pooler 连接串），然后到 Actions 页手动运行 **Bootstrap database (one-time)** 工作流。

**方式 B：本机执行**

```sh
pnpm install --frozen-lockfile
DATABASE_URL=<session-pooler-url> pnpm vercel:bootstrap
```

两种方式都依次执行：上游 Prisma 迁移（27 个）→ Liekan SQL 迁移（63 个）→ 导入官方示例「猎看官网（示例数据）」→ pg-boss 队列初始化。与 Docker 首次启动做的事情完全一致，幂等可重跑。

### 4. 导入 Vercel

把本仓库（`vercel` 分支）导入 Vercel，按 `env.vercel.example` 填环境变量。关键项：

- `DATABASE_URL` / `APP_SECRET` / `TWO_FACTOR_ENCRYPTION_KEY`
- `REDIS_URL` / `LIEKAN_ANALYTICS_REDIS_URL`
- `CRON_SECRET`（随机 32 字节 hex）
- `WORKER_BURST_SECONDS=50`（Hobby 套餐函数上限 60s；Pro 可调到 240）
- `LIEKAN_PUBLIC_URL`（绑定域名后填正式地址）

构建命令和函数时长已写在 `vercel.json` 里，无需手动设置。Node 版本选 22。

### 5. 唤醒 worker

在 GitHub 仓库 Settings → Secrets 里加 `APP_URL`（部署地址）和 `CRON_SECRET`（与 Vercel 同值）。到 Actions 页手动跑一次 `Vercel worker bursts` 验证返回 200。

### 6. 登录

初始账号 `admin / liekan`，登录后立刻改密码，并确认国家与统计时区。

## 与 Docker 版的已知差异

- **处理延迟**：日志导入、统计预计算等后台任务按唤醒节奏成批处理（默认约 5 分钟一批），不是实时。浏览器采集 `/api/send` 本身是同步入库，不受影响；看板读已发布结果的逻辑不变。
- **地理库**：Vercel 构建时自动跳过 DB-IP 地理库下载（代码里已有 `VERCEL` 判断），IP 地理位置显示为缺失，不影响采集。如需地理数据，把授权的 `GeoLite2-City.mmdb` 放到 `geo/` 后设 `BUILD_GEO=1` 并提交入库再部署。
- **函数时长**：单次 worker 排空时长受套餐限制（Hobby 60s / Pro 300s），靠 `WORKER_BURST_SECONDS` 控制；队列是持久化的，没排完的任务下一轮继续。
- **文件系统**：地理库自动更新等写本地磁盘的功能在 Vercel 上无效（已做容错，不会让 worker 报错退出）。
- **多实例一致性**：`APP_SECRET` 等密钥只通过环境变量下发，改密钥的流程与 Docker 版相同（见 docs/deployment.md）。
