# 5 分钟 BTC 市场定时脚本

`pnpm start` 等到**下一个 5 分钟市场区间开始后 1 分钟**下单，之后始终按区间时间执行。每小时的下单时点是 01、06、11、16、21、26、31、36、41、46、51、56 分。

| 脚本启动时间（北京时间） | 首次下单时间 | 对应市场区间 |
| --- | --- | --- |
| 16:19 | 16:21 | 16:20–16:25 |
| 16:22 | 16:26 | 16:25–16:30 |
| 16:24 | 16:26 | 16:25–16:30 |
| 16:25 | 16:26 | 16:25–16:30 |

例如 16:25:59 启动仍在 16:26 下单；若已到 16:26:00，则从下一个 16:31 时点开始。目标 slug 的 Unix 时间戳是**计划下单时点减去 60 秒**，因此 16:21 使用 16:20 区间的市场，16:26 使用 16:25 区间的市场。

起始 slug 的时间戳 +300 秒仍是最早允许下单的市场。旧的起始 slug 会自动跳过已错过的区间；若指定的是未来市场，则等待到它的下一个区间开始后 1 分钟下单。

## 运行

这是独立 Node.js / TypeScript 项目，不依赖 mm-mobile。需要 Node.js 22.17+ 和 pnpm。

```bash
cd /Users/april/workspace/work/dex/meme-hand/prediction-bot
pnpm install
cp .env.example .env
# 编辑 .env，填写接口地址、邮箱、密码、钱包、数量、止损价和实际起始 slug。
pnpm start
```

`pnpm start` 自动读取当前目录 `.env`，命令行参数可覆盖配置。配置邮箱和密码后，Authorization 可以留空，脚本会先登录；也可提供初始 token，过期后自动续登。

```dotenv
PREDICTION_EMAIL=your-account@example.com
PREDICTION_PASSWORD="你的密码"
PREDICTION_AUTHORIZATION=
```

邮箱对应登录接口的 `email` 字段，密码会保留首尾空格。账号密码只发送至配置的后端登录接口，不输出到日志。

也可以使用环境变量和命令行参数：

```bash
# 用实际接口根地址替换占位地址。示例接口根地址包含 /api 前缀。
export PREDICTION_BASE_URL='https://your-host/api'
export PREDICTION_AUTHORIZATION='Bearer <你的 token>'
export PREDICTION_EMAIL='your-account@example.com'
export PREDICTION_PASSWORD='<你的密码>'

pnpm start \
  --wallet-id '1b7a77e7-3a71-4a76-ad28-b9c0bd9b9e2d' \
  --amount 10 \
  --stop-price 0.1 \
  --slug 'btc-updown-5m-1791787500'
```

给定 slug 决定最早允许下单的市场；过去的区间会自动跳过，后续市场按当前时间对齐。token 只用于请求头，脚本不会保存到文件或输出到日志。

也支持 `--authorization 'Bearer <token>'`、`--email` 和 `--password`；建议使用 `.env` 或环境变量，避免凭证出现在进程参数中。

## 参数

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--base-url` | `PREDICTION_BASE_URL` | 必填，完整接口根地址；有 `/api` 前缀时需包含它 |
| `--authorization` | `PREDICTION_AUTHORIZATION` | 裸 token 或 `Bearer <token>`；配置邮箱和密码后可省略 |
| `--email` | `PREDICTION_EMAIL` | 登录账号（邮箱），与 password 一起配置，启用 401 自动续登 |
| `--password` | `PREDICTION_PASSWORD` | 登录密码，不去除首尾空格，与 email 一起配置 |
| `--wallet-id` | `PREDICTION_WALLET_ID` | 必填，每轮下单及领取的钱包 |
| `--amount` | `PREDICTION_AMOUNT` | 必填，大于 0 的下单数量，每轮相同 |
| `--stop-price` | `PREDICTION_STOP_PRICE` | 必填，0 到 1 之间的止损价格，以字符串提交 |
| `--slug` | `PREDICTION_SLUG` | 必填，时间戳须对齐 300 秒；至少从其下一个区间开始，过期区间自动跳过 |
| `--project-id` | `PREDICTION_PROJECT_ID` | 默认 `816d6686-3c64-4a98-bf41-9e781b77270e`，用于查询可领取市场 |
| `--once` | — | 等到首次计划时点后执行一轮，失败时退出码为 1 |
| `--dry-run` | — | 真实 GET 查询并打印计划，不发送下单或领取 POST |
| `--help` | — | 显示帮助，无需其他参数 |

命令行参数优先于环境变量。`--base-url https://host/api` 会请求 `https://host/api/prediction/...`；没有 `/api` 前缀的服务则传 `https://host`。

只读取接口、预览一轮的下单及领取参数：

```bash
pnpm start \
  --wallet-id '1b7a77e7-3a71-4a76-ad28-b9c0bd9b9e2d' \
  --amount 10 --stop-price 0.1 \
  --slug 'btc-updown-5m-1791787500' \
  --once --dry-run
```

## 每轮流程与失败处理

1. GET `prediction/getMarketDetail?slug=...`，读取市场 `id`，解析两个字符串形式的 `clobTokenIds`，保留长 ID 精度。
2. POST `prediction/createSplitOrders`：`{ marketId: id, walletIds: [walletId], amount, createStopOrder: true, stopPrice }`。接口参数没有 `clobTokenIds` 字段，所以它们仅用于校验及日志。
3. GET `prediction/getClaimableMarkets?projectId=...&page=1&limit=200`，读完所有页，去重市场 ID。
4. 有可领取市场时 POST `prediction/createWalletClaimOrders`：`{ marketIds, walletId }`。领取范围为接口返回的所有可领取市场；没有市场则跳过。

两个 POST 都必须返回 `success: true`；`false` 或缺失均报错。创建成功表示服务端已接受订单，不代表链上已经成交或领取完成。

- 普通下单失败后仍尝试领取历史市场，记录错误，并在下一时点推进到下一个 slug。
- HTTP 401 或响应体的 `statusCode: 401` / `code: 401` 会触发 POST `auth/login`，提交 `{ email, password, code: "", faCode: "" }`，并携带 `X-Platform: mobile`。读取返回的 `accessToken` 后更新内存中的 token，原请求使用新 token 重试一次，后续请求也使用新 token。
- 并发 401 共用一次登录。登录失败或重试仍为 401 时，本轮记录错误；定时器继续，后续轮次尝试登录。失败后冷却 30 秒，避免同一轮反复登录。`--once` 模式仍会在本轮失败时以退出码 1 结束。
- 只配置 token、没有配置邮箱密码时，401 仍会停止任务。403 表示权限不足，仍停止任务，不尝试续登。
- 每个请求超时 30 秒。只有明确的 401 会触发一次重试；订单超时、网络中断或其他失败不自动重试，结果可能未知，需查看服务端订单状态。
- 登录接口若返回 `requiresVerifyList`，表示需要验证码或二次验证；仅账号密码无法完成这类登录，脚本会记录错误并保持定时任务运行。
- 各轮串行执行，始终对齐市场区间开始后 1 分钟；接口耗时不会累积到下一次间隔。某轮超过 5 分钟时跳过错过的时点，避免重叠执行或连续补单。
- 等待日志会显示北京时间、目标 slug 和等待秒数。发送下单请求前打印 `正在下单：当前 slug=...`，成功或失败日志也包含该 slug。
- 下单日志标注第几次实际下单；累计下单笔数只统计返回 `success: true` 的拆分请求。领取成功日志后打印累计统计，领取市场按 ID 去重。统计从本次启动开始，重启归零；失败请求和 dry-run 不计入成功数量，401 续登重试算同一次下单。
- Ctrl+C / SIGTERM 停止等待和后续请求。脚本不持久化进度；重新启动将重新计算下一个计划时点，跳过已经错过的区间。

验证用模拟接口，不使用真实 token 或创建真实订单：

```bash
pnpm typecheck
pnpm test
```


## 文件

- `src/index.ts`：运行入口、停止信号和日志。
- `src/config.ts`：参数及环境变量校验。
- `src/api.ts`：鉴权、市场查询、下单、分页查询与领取。
- `src/auth.ts`：登录、401 续登、请求重试和凭证脱敏。
- `src/runner.ts`：每轮流程与 5 分钟调度。
- `tests/bot.test.ts`：模拟接口及调度验证。
- `tests/auth.test.ts`：登录配置、401 恢复、并发续登和失败后继续调度验证。
