# 家中物品来历册

给家里的旧家具、纪念品、票据和手稿建一份**来历档案**：记下获得时间、来源人物、地点和背后的故事，配上照片、录音和扫描件，再按家庭成员分配权限。

纯 Node.js + PostgreSQL，直接跑在你自己机器上，不需要容器；数据只存在本地，可整体导出成离线 ZIP 和数据库备份。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能一览](#功能一览)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [本地开发](#本地开发)
- [怎么验证它真的能用](#怎么验证它真的能用)
- [生产部署](#生产部署)
- [备份、恢复与升级](#备份恢复与升级)
- [配置项](#配置项)
- [目录结构](#目录结构)
- [权限模型](#权限模型)
- [安全与隐私](#安全与隐私)
- [当前实现范围](#当前实现范围)

---

## 它解决什么问题

老物件的信息通常是散的：照片在手机相册、故事在长辈嘴里、票据在抽屉里。等人走了、东西丢了，来历就断了。

这个系统把「一件东西」当成一条档案来记：

- **时间不精确也能记**：长辈常常只记得「大概 1978 年」或「我上小学那年」。系统用「时间 + 精度 + 原话」三个字段承载，时间轴上对存疑的条目明确标注，而不是假装精确。
- **来源人物是独立档案**：可以反查「外公送过、留下的所有东西」。
- **音频是一等公民**：长辈口述比打字容易。录音保留原始文件，并可附听写稿。
- **权限是真实的**：家庭成员分五级角色，条目还有四档可见范围；被移出的成员立刻失去访问。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 账号 | 注册（首个用户成为系统管理员）/ 登录 / 刷新会话 / 改密码；access token 内存持有，refresh token 走 httpOnly Cookie 并可撤销 |
| 家庭 | 多家庭空间、邀请码加入、成员角色管理、移出成员即时失效 |
| 条目 | 五分类（家具/纪念品/票据/手稿/其他）、草稿→发布→归档→回收站状态机、版本历史与回滚 |
| 时间 | 精度（日/月/年/十年/说不清）+ 用户原话 + 推断依据；时间轴按年或年代分组 |
| 地理 | 自由文本地点 + 可选省市与国家 |
| 人物 | 人物档案（关系、生卒年、小传），与条目多对多并标注来源/赠送/继承等角色，支持合并重复人物 |
| 媒体 | 图片（EXIF 纠正 + 剥离元数据 + 多尺寸 WebP）、音频（转 mp3 + 波形 + 听写稿 + Range 播放）、PDF；按 sha256 内容寻址去重 |
| 协作 | 家人补充故事/留言/更正，需被采纳才并入正文；完整审计日志 |
| 检索 | 关键词（标题/故事/地点/标签/人物/听写稿）、分类、人物、时间范围、状态筛选，游标分页 |
| 分享 | 生成带有效期与可选密码的只读链接，可随时撤销，访问计数 |
| 导出 | 单条 Markdown、打印视图（存 PDF）、全量 ZIP（`manifest.json` + `items.csv` + 每人条目 Markdown + 原始媒体 + sha256 清单） |
| 运维 | 单进程同时提供前端与 API、健康检查、每日维护任务（回收站清理/孤儿文件回收）、备份 + 恢复脚本 + 恢复演练报告 |

## 技术栈

- **前端**：React 18 + TypeScript + Vite + React Router + TanStack Query，CSS 设计令牌，无重型 UI 框架
- **后端**：Node.js 20+ / TypeScript / Express 4 / Prisma 5 / PostgreSQL 16 / Zod
- **媒体**：sharp（图片）、ffmpeg（音频，本机安装，缺失时自动降级）
- **部署**：单个 Node 进程（构建后由 API 直接托管 `apps/web/dist`），可选 systemd / pm2 / Nginx
- **包管理**：pnpm workspaces（monorepo）

## 快速开始

### 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 20 | 建议 20 LTS 或 22 LTS |
| PostgreSQL 16 | 需要客户端工具（`psql`/`pg_dump`/`pg_restore`）与服务端；macOS：`brew install postgresql@16`，Debian/Ubuntu：`apt install postgresql-16 postgresql-client-16` |
| ffmpeg | **可选**。装了才有音频转码与波形；没装时录音仍会完整保存并能播放原始文件。macOS：`brew install ffmpeg`，Debian/Ubuntu：`apt install ffmpeg` |
| pnpm | `corepack enable` 即可（仓库已声明 `packageManager`） |

### 四步跑起来

```bash
# 1. 安装依赖
corepack enable
pnpm install

# 2. 配置（生成会话密钥，改掉数据库密码）
cp .env.example .env
sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env   # macOS
sed -i '' "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
# Linux 把 -i '' 换成 -i

# 3. 起数据库并建表
pnpm db:start        # 首次会自动 initdb，在 data/pgdata 建一个只监听 127.0.0.1 的本地集群
pnpm db:deploy       # 应用数据库迁移

# 4. 构建并启动（前端与 API 在同一个端口）
pnpm build
pnpm start
```

打开 <http://localhost:4000>：**第一个注册的账号自动成为系统管理员**，登录后先创建家庭空间。

> `pnpm db:start` 只是把 PostgreSQL 跑在项目目录里，方便不想动系统服务的人。如果你已经有自己的 PostgreSQL（本机服务、另一台机器或云数据库），跳过这一步，直接把 `.env` 里的 `DATABASE_URL` 指过去即可。

### 界面

下面几张图由 `pnpm test:ui` 在真实浏览器里自动生成（见 `docs/screenshots/`）：

| 家庭首页 | 建档表单 |
| --- | --- |
| ![家庭首页](docs/screenshots/01-家庭首页.png) | ![建档表单](docs/screenshots/02-建档表单.png) |

| 条目详情 | 时间轴 | 移动端 |
| --- | --- | --- |
| ![条目详情](docs/screenshots/03-条目详情.png) | ![时间轴](docs/screenshots/04-时间轴.png) | ![移动端](docs/screenshots/05-移动端.png) |

## 本地开发

```bash
pnpm db:start                   # 数据库
pnpm db:migrate                 # 开发期改 schema 时用（会生成迁移文件）
pnpm dev                        # api:4000 + web:5173（Vite 代理 /api 到 4000）
```

开发时直接访问 <http://localhost:5173> 有热更新；`pnpm start` 跑的是构建产物，用于验证生产形态。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 并行启动前后端（开发模式） |
| `pnpm build` / `pnpm start` | 构建 / 以生产形态启动（单进程同时提供前端与 API） |
| `pnpm typecheck` | 全量类型检查 |
| `pnpm test` | 单元测试（权限矩阵、时间精度、文件嗅探、波形、CSRF 白名单、分页） |
| `pnpm verify:loop` | **端到端闭环验证**（真实 HTTP 跑完整流程） |
| `pnpm test:ui` | **浏览器冒烟测试**（用本机 Chrome 真实点一遍） |
| `pnpm db:init` / `db:start` / `db:stop` / `db:status` / `db:psql` | 管理项目自带的 PostgreSQL 集群 |
| `pnpm db:studio` | Prisma Studio 可视化查库 |
| `pnpm backup` / `pnpm restore <目录>` / `pnpm backup:drill` / `pnpm gc` | 备份 / 恢复 / 恢复演练 / 维护任务 |

## 怎么验证它真的能用

这个项目自带三条可执行的验证路径，不需要人工点。

### 1. 后端闭环（63 项断言）

```bash
# 先确保服务在跑：pnpm start
# 全新实例（没有用户）下，脚本会自己注册第一个账号
pnpm verify:loop

# 库已经初始化过时，复用一个既有账号
OWNER_EMAIL=you@example.com OWNER_PASSWORD=yourpass pnpm verify:loop
```

覆盖：健康检查 → 注册/登录/刷新/CSRF → 建家庭 → 建人物 → 四类条目 → 时间精度展示 → 上传图片/音频 + 内容寻址去重 → 后台生成缩略图 → Range 播放 → 发布 → 补充故事采纳 → 版本记录 → 邀请成员 → 权限边界（错误密码/越权/私密条目）→ 检索与时间轴 → 带密码分享链接 → 全量导出 ZIP 并检查内容 → 审计日志 → 回收站与恢复。

### 2. 浏览器冒烟（13 项断言）

```bash
pnpm test:ui                    # 打 http://localhost:5173
WEB=http://localhost:4000 pnpm test:ui   # 验证生产形态
HEADLESS=false pnpm test:ui     # 想看着它点
```

覆盖：登录页渲染 → 注册（或回退到既有账号登录）→ 创建家庭 → 填写物品表单 → 保存为草稿 → 发布 → 详情页时间与故事展示 → 时间轴分组 → 360px 移动端无横向溢出 → 无异常接口报错。截图默认落在 `/tmp/heirloom-shots`。

### 3. 恢复演练

```bash
pnpm backup         # 生成一份带 DONE 标记的备份
pnpm backup:drill   # 还原到临时库并比对条数与媒体 sha256，输出报告
```

报告写在 `docs/恢复演练报告-<时间>.md`，包含条数比对表、媒体抽样校验结果和备份文件清单。**只有演练通过，备份才算数。**

> 演练会用 `createdb` 建一个临时库，因此数据库账号需要有 `CREATEDB` 权限。项目自带的本地集群默认满足；用托管数据库时如果没有该权限，可以手动指定一个演练库后跳过建库步骤，或改用 `pnpm restore` 做一次真实恢复验证。

## 生产部署

整套应用就是一个 Node 进程：它同时提供 API、媒体流和前端静态文件。最小部署方式：

```bash
pnpm install --frozen-lockfile
pnpm build
NODE_ENV=production pnpm start     # 监听 API_PORT（默认 4000）
```

### 用 systemd 托管（Linux）

`/etc/systemd/system/heirloom.service`：

```ini
[Unit]
Description=家中物品来历册
After=network-online.target postgresql.service

[Service]
Type=simple
User=heirloom
WorkingDirectory=/srv/heirloom
EnvironmentFile=/srv/heirloom/.env
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now heirloom
journalctl -u heirloom -f          # 看日志
```

### 用 Nginx / Caddy 加 HTTPS（可选）

想上公网就需要 TLS。让反向代理只做一件事——把请求转给 4000 端口，并把 `.env` 里的 `APP_URL` 改成真实域名、`COOKIE_SECURE=true`：

```nginx
server {
  listen 443 ssl http2;
  server_name heirloom.example.com;
  # ssl_certificate / ssl_certificate_key 略

  client_max_body_size 210m;        # 需 ≥ MAX_AUDIO_MB，否则大音频在代理层就被拒

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;            # 音频拖动进度条依赖流式响应
    proxy_read_timeout 600s;
  }
}
```

如果你更愿意让 Nginx 直接托管静态文件，把 `.env` 里的 `SERVE_WEB=false`，静态根指向 `apps/web/dist`，只把 `/api/`、`/healthz`、`/readyz` 反代到 4000 即可。

### 健康检查

```bash
curl -fsS http://127.0.0.1:4000/healthz   # 进程存活
curl -fsS http://127.0.0.1:4000/readyz    # 数据库 / 存储 / worker 就绪
```

监控告警建议：`/readyz` 连续失败、磁盘剩余 < 15%、备份目录超过 24 小时没有出现新的 `DONE` 标记。

### 后台任务可靠性

缩略图、音频转码、导出 ZIP 都是数据库队列表（`jobs`）里的异步任务，保证：

- **中断自愈**：进程被 `kill -9`、OOM 或断电后，任务不会永久停在「执行中」。worker 启动时及每 `WORKER_HEARTBEAT_MS` 巡检一次，把心跳超过 `WORKER_STALE_MS` 的 `running` 任务重新置回 `queued` 并清空 `started_at`，随后自动重跑。
- **重复执行无副作用**：所有产物按内容寻址（sha256），重跑只是覆盖写同一份字节；图片/音频写入走「临时文件 + 原子 rename」，导出 ZIP 先写 `<jobId>.zip.part-<pid>` 再改名，任何时刻都不会读到半成品；同一家庭已有排队/执行中的导出任务时，重复点「开始导出」直接复用原任务。
- **失败可重试**：任务失败按 1 分钟起、5 倍指数退避（上限 30 分钟）自动重试，超过 `maxAttempts` 才标记 `failed`；媒体处理失败时前端会显示「重试处理」按钮（`POST /api/v1/families/:fid/media/:id/reprocess`），导出失败可一键「重新导出」。

## 备份、恢复与升级

### 备份

```bash
pnpm backup                      # 输出到 data/backups/<时间戳>/
```

一次完整备份包含：

```
data/backups/2026-10-05-023000/
├── db.dump           # pg_dump -Fc
├── uploads.tar.gz    # 全部原始图片/音频/文档
├── manifest.json     # 条数、迁移版本、两个文件的 sha256
└── DONE              # 完成标记：没有它说明备份不完整，恢复脚本会拒绝
```

保留份数由 `BACKUP_RETENTION_DAYS`（默认 30）控制。生产环境建议再加一条 cron：

```cron
30 2 * * * cd /srv/heirloom && /bin/bash scripts/backup.sh >> /var/log/heirloom-backup.log 2>&1
```

用托管数据库时，把 `DATABASE_URL` 指向该库即可，脚本走的是标准 `pg_dump`；媒体目录仍需自己纳入备份（脚本已包含）。

### 恢复

```bash
sudo systemctl stop heirloom                    # 先停写入
pnpm restore data/backups/2026-10-05-023000
sudo systemctl start heirloom
```

脚本会：还原数据库 → 还原上传目录（旧的改名保留）→ 校验条数与媒体 sha256 → 健康检查。检测到 API 还在运行时会先提示确认。

### 升级

```bash
pnpm backup                      # 升级前先备份
git pull
pnpm install --frozen-lockfile
pnpm build
pnpm db:deploy                   # 只应用迁移，不丢数据
sudo systemctl restart heirloom
curl -fsS http://127.0.0.1:4000/readyz
```

迁移只前进、不回滚破坏数据；遇到破坏性变更时应拆成「新增列 → 回填 → 切换 → 删除旧列」多次发布。

### 日常维护

```bash
pnpm gc   # 手动触发：清理过期回收站、回收孤儿文件、删除过期导出包
```

API 进程每天也会自动跑一次同样的维护任务。

## 配置项

完整清单见 `.env.example`，常用的几项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 无（必填） | 会话签名密钥，`openssl rand -hex 32` |
| `APP_URL` | `http://localhost:4000` | 生成邀请/分享链接用，必须与真实访问地址一致 |
| `DATABASE_URL` | 本地 5432 | 应用连接串；用托管数据库时记得带 `sslmode=require` |
| `POSTGRES_USER/PASSWORD/DB` | heirloom | 仅 `scripts/pg.sh` 初始化本地集群时使用，需与 `DATABASE_URL` 一致 |
| `SERVE_WEB` | `true` | 由 API 托管前端构建产物；改用 Nginx 托管时设为 `false` |
| `COOKIE_SECURE` | `false` | 走 HTTPS 时改为 `true` |
| `PUBLIC_SIGNUP` | `false` | 关闭时只能凭邀请加入；首个注册账号不受限制 |
| `MAX_IMAGE_MB` / `MAX_AUDIO_MB` / `MAX_DOC_MB` | 25 / 200 / 50 | 单文件上限；用反向代理时同步调整它的请求体上限 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | ffmpeg 不在 PATH 里时给绝对路径 |
| `TRASH_RETENTION_DAYS` | 30 | 回收站保留天数，到期由维护任务彻底删除 |
| `WORKER_ENABLED` | `true` | 多实例部署时只让一个实例开启 |
| `WORKER_STALE_MS` | `600000` | 执行中任务超过该时长无心跳即视为进程中断，自动重新入队 |
| `WORKER_HEARTBEAT_MS` | `30000` | 心跳与僵尸任务巡检间隔，须明显小于 `WORKER_STALE_MS` |

## 目录结构

```
.
├── scripts/                     # 本地数据库 / 备份 / 恢复 / 演练 / 清理 / 闭环验证
├── e2e/ui-smoke.mjs             # 浏览器冒烟测试
├── packages/shared/             # 前后端共用的权限矩阵、时间精度、Zod 校验
├── apps/api/
│   ├── prisma/schema.prisma     # 数据模型（含全部枚举与索引）
│   └── src/
│       ├── middleware/          # 认证 / 家庭权限 / CSRF / 限流 / 上传 / 错误处理
│       ├── routes/              # HTTP 路由（不含业务规则）
│       ├── services/            # 业务规则、事务边界、审计
│       ├── media/               # 文件嗅探、图片转码、音频波形、PDF 校验
│       ├── storage/             # 内容寻址存储（本地磁盘实现）
│       ├── scripts/             # 恢复校验等运维脚本（会一起编译）
│       └── queue/worker.ts      # 数据库表队列 + 后台任务
└── apps/web/src/
    ├── app/                     # 路由与守卫
    ├── api/                     # 请求封装与类型
    ├── features/                # 按业务域组织的页面（auth/families/items/media/people/members/audit/settings/share）
    └── styles/                  # 设计令牌与样式
```

运行时数据（都已在 `.gitignore` 中）：

```
data/
├── pgdata/      # scripts/pg.sh 的本地 PostgreSQL 数据目录
├── uploads/     # 图片 / 音频 / 文档（内容寻址）
├── exports/     # 导出 ZIP
└── backups/     # 备份
```

## 权限模型

家庭内五级角色：

| 角色 | 能做什么 |
| --- | --- |
| `owner` 创建者 | 全部权限，包括删除家庭、移交管理员 |
| `admin` 管理员 | 管理成员、导出、编辑任何条目、看审计 |
| `editor` 编辑 | 建立条目、管理人物、分享；编辑自己的条目 |
| `contributor` 贡献者 | 建立条目、补充故事；编辑自己的条目 |
| `viewer` 只读 | 只能看（可由管理员开启「允许留言」） |

条目四档可见范围：`private`（仅自己，管理员可见）/ `family`（全家）/ `selected`（指定成员，可选可编辑）/ `link`（可生成对外只读链接）。

判定顺序固定为：**是否登录 → 是否属于该家庭 → 角色是否允许该动作 → 条目状态 → 可见性 → 资源级授权**，统一收敛在 `packages/shared/src/permissions.ts` 与 `apps/api/src/services/permissionService.ts`，路由层不允许自己写角色判断。无权访问一律返回 404，避免通过状态码枚举出资源是否存在。

## 安全与隐私

- 密码用 argon2id（19 MiB / 2 轮）哈希；登录失败不区分「用户不存在」与「密码错误」。
- access token 15 分钟、只存在内存；refresh token 14 天、httpOnly Cookie、轮换 + 复用检测（发现复用即撤销该用户全部会话）。
- 写请求校验 `Origin`，`/auth/refresh` 与 `/auth/logout` 额外要求双提交 CSRF token。
- 上传只信文件内容（魔数嗅探），图片重新编码以剥离 EXIF/GPS；上传目录不在 Web 根下，读取一律走鉴权接口。
- 富文本按白名单净化（`p/strong/em/ul/ol/li/blockquote/a`），杜绝脚本注入。
- 所有写操作在同一事务里写审计日志；删除是软删除 + 回收站保留期 + 备份三重保险。
- 数据默认只存在你自己的机器上；只有你主动创建分享链接，内容才会对外可见，且可随时撤销。
- `scripts/pg.sh` 建出来的集群只监听 `127.0.0.1`，不会暴露到局域网。

已知取舍：媒体读取允许通过 `?t=<access token>` 传令牌（因为 `<img>`/`<audio>` 无法设置请求头），因此令牌可能出现在访问日志里；只对 GET + `/media/` 路径放行，并且令牌 15 分钟过期。

## 当前实现范围

已经实现并且有测试覆盖：上面「功能一览」里的全部条目。

**尚未实现**（有意留到下一轮，避免半成品混进主流程）：

- 大文件分片上传：目前单次请求上传，受后端上限约束（音频 200MB 以内够用）。
- PDF 首页缩略图：预编译的 sharp 不含 PDF 渲染能力，PDF 在界面上以文件卡片呈现，音频/图片的缩略图正常。
- 音频听写稿自动转写：目前由用户手工填写或粘贴。
- 邮件发送：密码重置需要管理员介入（自托管环境常没有 SMTP）。
- 端到端加密：服务端在处理媒体时会短暂持有明文。

## 许可

私有项目，未附许可协议；如需开源请先补充 LICENSE。
