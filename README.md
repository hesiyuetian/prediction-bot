# 5 分钟 BTC 市场定时脚本

`pnpm start` 启动后**立即购买当前 5 分钟区间的下一个市场**，之后每个 5 分钟区间开始时买下一区间。后续每小时的下单时点是 00、05、10、15、20、25、30、35、40、45、50、55 分。

| 脚本启动时间（北京时间） | 首次下单时间 | 对应市场区间 |
| --- | --- | --- |
| 16:19 | 立即下单 | 16:20–16:25 |
| 16:22 | 立即下单 | 16:25–16:30 |
| 16:24 | 立即下单 | 16:25–16:30 |
| 16:25 | 立即下单 | 16:30–16:35 |

例如 16:22 启动立即买 16:25–16:30 的市场，16:25 再买 16:30–16:35 的市场；16:25:00 启动也只买 16:30–16:35 的市场一次，下一轮在 16:30 执行。目标 slug 的 Unix 秒时间戳为 **`floor(当前 Unix 秒时间戳 / 300) * 300 + 300`**。

推荐只提供市场前缀，启动及每轮自动根据当前时间补全时间戳：

```dotenv
PREDICTION_SLUG=btc-updown-5m-
```

也支持完整起始 slug，例如 `btc-updown-5m-1791798900`。此时它的时间戳 +300 秒仍是最早允许下单的市场。旧的起始 slug 会自动跳过已错过的区间；若指定的是未来起始市场，则等待到该起始区间开始，再买它的下一个市场。

## 运行

这是独立 Node.js / TypeScript 项目，不依赖 mm-mobile。需要 Node.js 22.17+ 和 pnpm。

```bash
cd /Users/april/workspace/work/dex/meme-hand/prediction-bot
pnpm install
cp .env.example .env
# 编辑 .env，填写接口地址、邮箱、密码、钱包、数量和止损价；slug 可只保留 btc-updown-5m- 前缀。
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
  --slug 'btc-updown-5m-'
```

只提供 slug 前缀时立即买当前区间的下一个市场；完整 slug 还会限制最早目标市场。后续市场按当前时间对齐。token 只用于请求头，脚本不会保存到文件或输出到日志。

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
| `--slug` | `PREDICTION_SLUG` | 必填；推荐 `btc-updown-5m-` 自动计算；完整 slug 的时间戳须对齐 300 秒，目标市场不得早于它的下一个区间 |
| `--project-id` | `PREDICTION_PROJECT_ID` | 默认 `816d6686-3c64-4a98-bf41-9e781b77270e`，用于查询可领取市场 |
| `--once` | — | 通常启动后立即执行一轮；未来起始市场需等待，失败时退出码为 1 |
| `--dry-run` | — | 真实 GET 查询并打印计划，不发送下单或领取 POST |
| `--help` | — | 显示帮助，无需其他参数 |

命令行参数优先于环境变量。`--base-url https://host/api` 会请求 `https://host/api/prediction/...`；没有 `/api` 前缀的服务则传 `https://host`。

只读取接口、预览一轮的下单及领取参数：

```bash
pnpm start \
  --wallet-id '1b7a77e7-3a71-4a76-ad28-b9c0bd9b9e2d' \
  --amount 10 --stop-price 0.1 \
  --slug 'btc-updown-5m-' \
  --once --dry-run
```

## 每轮流程与失败处理

1. GET `prediction/getMarketDetail?slug=...`，读取市场 `id`，解析两个字符串形式的 `clobTokenIds`，保留长 ID 精度。
2. POST `prediction/createSplitOrders`：`{ marketId: id, walletIds: [walletId], amount, createStopOrder: true, stopPrice }`。接口参数没有 `clobTokenIds` 字段，所以它们仅用于校验及日志。
3. GET `prediction/getClaimableMarkets?projectId=...&page=1&limit=200`，读完所有页，去重市场 ID。
4. 有可领取市场时 POST `prediction/createWalletClaimOrders`：`{ marketIds, walletId }`。领取范围为接口返回的所有可领取市场；没有市场则跳过。

两个 POST 都必须返回 `success: true`；`false` 或缺失均报错。创建成功表示服务端已接受订单，不代表链上已经成交或领取完成。

- 拆分订单创建失败会打印当前 slug、下单序号和错误原因，立即输出累计统计；普通失败后仍尝试领取历史市场，并在下一时点买下一个市场。当前市场不自动补单。
- 失败提示和 `报错日志` 带 `[ERROR]` 标记，输出到 stderr。报错日志包含接口路径、HTTP 状态、接口返回的错误内容、网络错误原因和错误堆栈；凭证会脱敏，过长的响应在 10000 字符处截断并提示。使用 PM2 时可通过 `pm2 logs prediction-bot` 查看。
- HTTP 401 或响应体的 `statusCode: 401` / `code: 401` 会触发 POST `auth/login`，提交 `{ email, password, code: "", faCode: "" }`，并携带 `X-Platform: mobile`。读取返回的 `accessToken` 后更新内存中的 token，原请求使用新 token 重试一次，后续请求也使用新 token。
- 并发 401 共用一次登录。登录失败或重试仍为 401 时，本轮记录错误；定时器继续，后续轮次尝试登录。失败后冷却 30 秒，避免同一轮反复登录。`--once` 模式仍会在本轮失败时以退出码 1 结束。
- 只配置 token、没有配置邮箱密码时，401 仍会停止任务。403 表示权限不足，仍停止任务，不尝试续登。
- 每个请求超时 30 秒。只有明确的 401 会触发一次重试；订单超时、网络中断或其他失败不自动重试，结果可能未知，需查看服务端订单状态。
- 登录接口若返回 `requiresVerifyList`，表示需要验证码或二次验证；仅账号密码无法完成这类登录，脚本会记录错误并保持定时任务运行。
- 首轮通常立即执行，之后各轮对齐每个 5 分钟区间的起点，购买下一区间的市场；接口耗时不会累积到下一次间隔。耗时较长时跳过错过的时点，避免重叠执行或连续补单。查询市场后若目标区间已开始，则跳过该笔下单，仍检查领取。
- 等待日志会显示北京时间、目标 slug 和等待秒数。发送下单请求前打印 `正在下单：当前 slug=...`，成功或失败日志也包含该 slug。
- 下单日志标注第几次实际下单；累计下单笔数只统计返回 `success: true` 的拆分请求。领取成功或下单失败后打印累计统计，包含累计下单、领取市场和下单失败笔数。失败笔数按下单请求返回失败或发生异常统计；网络异常或超时的订单实际结果可能未知。市场查询失败或错过下单窗口未发起拆分请求时不增加失败笔数。领取市场按 ID 去重。统计从本次启动开始，重启归零；失败请求和 dry-run 不计入成功数量，401 续登重试算同一次下单。
- Ctrl+C / SIGTERM 停止等待和后续请求。脚本不持久化进度；重新启动会立即买当前区间的下一个市场，同一区间内重启可能再次下单。

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
