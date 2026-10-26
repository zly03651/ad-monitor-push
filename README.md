# ad-monitor 企微定时推送

让**企微重点计划提醒**不再依赖任何人的电脑开机。

## 为什么需要它

原先的推送跑在 WorkBuddy 云沙箱里，而那个沙箱是"访问唤醒"型——没人访问时会被回收，
所以定时推送不可靠；跑在本机又要求电脑一直开着。这个仓库用一个与电脑无关的定时任务
（GitHub Actions）来补这条通路。

## 它做什么

**周一至周日全天（00:00-24:00）**，每 30 分钟执行一次：

1. 拉线上看板的 `/api/snapshot`（**口径就是主系统算好的那份**，这里不重算 AP）
2. 筛出 `在投 + AP>60 + 付费用户>0 + 有负责人` 的计划
3. 内容与上次不同才推送到企微群（同一天同一内容不重复打扰）

AP 的定义与主系统一致：`当日充值 ÷ 当日付费用户数`，付费用户为 0 时不推。

### 想改推送时段（不用改代码）

在仓库 Settings → Secrets and variables → Actions → **Variables** 里加三个变量即可：

| 变量 | 含义 | 例子 |
| --- | --- | --- |
| `PUSH_DAYS` | 哪几天（1=周一 … 7=周日，可写区间/列表） | `1-5`、`1,3,5`、`1-7` |
| `PUSH_START` | 起始（北京时间，`HH:MM`） | `9`、`09:30` |
| `PUSH_END` | 结束（`24` 表示当日 24:00） | `20:30`、`24` |

不写即默认 `1-7` / `0` / `24`（全天）。

## 需要的密钥（Repository secrets）

| 名称 | 说明 |
| --- | --- |
| `APP_PASSWORD` | 线上看板的访问口令（用于过口令闸） |
| `WECOM_WEBHOOK` | 企微群机器人 webhook 地址 |

## 本地试跑

```bash
APP_PASSWORD=xxx WECOM_WEBHOOK=xxx DRY_RUN=1 node push.js
```

`DRY_RUN=1` 只打印消息内容，不真的发到群里。

## 说明

- 仓库里**不含任何业务数据与凭据**，凭据只存在仓库的加密 Secrets 里；
- 推送判据改口径时，优先改主系统（`server/lib/metrics.js`），本仓库只跟着取数；
- 手动触发：Actions 页面 → 选 `ad-monitor 企微推送` → Run workflow。

## 注意事项

- **仓库连续 60 天没有任何活动时，GitHub 会自动暂停定时任务**（平台策略，不是本仓库的 bug）。
  发现不推了：进 Actions 页面点一次 `Run workflow` 即恢复，或随便提交一次改动。
- 免费额度：本任务每次约 20 秒、每天 48 次 ≈ 每月 480 分钟，远低于 2000 分钟免费额度。
- 换口令后：Settings → Secrets and variables → Actions → 更新 `APP_PASSWORD` 即可，代码不用动。
- 若要停掉推送：Actions 页面点 `...` → Disable workflow（或直接停用仓库的 Actions）。
