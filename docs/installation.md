# 安装与本人扫码（供 dot 或维护者执行）

用户请先复制 README 的单段指令给自己的 dot；下文命令由具备权限的 dot 或维护者执行。本文面向 macOS/Linux 上的单人本地实验。要求 Node.js `>=22.13`、npm，以及可访问腾讯固定 HTTPS 原点的网络。本独立仓库使用 Node 22.22.3 通过了本地测试；真实微信绑定、服务资格和 dot 接入仍需按账号分别核验。

源码仓库：[Ericwong5021/dots-wechat](https://github.com/Ericwong5021/dots-wechat)。在新机器上取得源码：

```sh
mkdir -p ~/project
git clone https://github.com/Ericwong5021/dots-wechat.git ~/project/dots-wechat
```

已有 `~/project/dots-wechat` 时不要重复克隆或覆盖，直接进入现有仓库。公开原型当前只有合成/loopback 回归证据，不能据此承诺新账号的真实微信或 dot 链路成功。

## 1. 安装依赖并检查本地代码

```sh
cd ~/project/dots-wechat
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run doctor
```

`npm ci` 要求仓库包含对应锁文件。根目录 `npm test` 运行 `node --test src/*/*.test.mjs`。测试使用临时目录和合成请求，不需要扫码、不读取你的运行时目录。测试通过仍不能证明腾讯收发、ChatGPT 接入或用户可见送达。

## 2. 启动默认禁用服务

```sh
cd ~/project/dots-wechat
npm start
```

保留这个前台终端。在另一个终端查看无聊天内容的健康状态：

```sh
curl --fail --silent --show-error http://127.0.0.1:8890/healthz
```

默认服务只做本机 MCP 目录发现和非敏感状态读取，不读取微信凭据。受保护操作被拒绝是预期结果。按 **Ctrl-C** 停止；端口被占用时不要结束不明进程，见 [故障排查](troubleshooting.md)。

## 3. 为此次新绑定准备私有位置

关闭上一步服务后，为凭据目录准备其父目录：

```sh
cd ~/project/dots-wechat
umask 077
mkdir -p .runtime
chmod 700 .runtime
```

下面使用一个**尚不存在**的 `.runtime/weixin-local` 子目录。登录助手应在本人确认后新建该目录并写 `credentials.json`；不要预先创建子目录或手工写 token。已有目录和凭据不能覆盖。请勿指定旧 OpenClaw/Hermes 配置目录，不导入它们的凭据。

## 4. 本人扫码登录

以下命令对应独立 CLI；本地合成测试覆盖其行为。真实登录仍须本人扫码并核对官方回执。

```sh
cd ~/project/dots-wechat
node src/weixin/cli.mjs login --state-dir "$(pwd -P)/.runtime/weixin-local"
```

`login` 要求交互终端。先阅读终端说明，本人精确键入 `BIND MY WECHAT` 才申请此次新 bot 的二维码。二维码 PNG 仅写在系统临时目录的 `dots-wechat-qr-*` 子目录中，目录 `0700`、PNG `0600`；CLI 输出本机 `file://` 路径，由本人手动打开，不自动打开浏览器。不要公开分享该路径或图片。登录结束时 CLI 清理临时二维码文件。

本人用微信扫描该次二维码，在微信显示的官方页面确认；不要把二维码、验证数字或登录回执发送给别人。申请二维码使用空 `local_token_list`，不复用旧 token。只有本人确认后的此次新凭据会写入所选本机目录。

如需要额外验证，按 CLI 支持的官方流程完成；如出现新原点、旧绑定导入或 CLI 未支持的验证步骤，停止并排查，不绕过。agent-first 的授权、非 TTY 接口与私有图片交付见 [首次安装流程](onboarding.md)。只有 `confirmed` 后安全保存完成才算本机登录成功；`scaned` 仅表示扫描过。二维码过期后重新执行登录需要新的本人操作。

## 5. 检查状态并核验一条文字

状态命令只检查本机绑定与安全文件，不输出 token、bot ID、owner ID，也不联系腾讯验证 token 有效性。`networkChecked: false` 表示未做远端检查。

```sh
cd ~/project/dots-wechat
node src/weixin/cli.mjs status --state-dir "$(pwd -P)/.runtime/weixin-local"
node src/weixin/cli.mjs verify --state-dir "$(pwd -P)/.runtime/weixin-local" --expect 'dots-wechat-check-001' --reply-text 'dots-wechat 微信网关确认；dot 自动回复尚未接通。'
```

只用无私人信息的随机测试标记；这些参数可能留在 shell 历史中。每次测试换一个新标记。验证进程启动后，由扫码本人在该 bot 私聊发送与 `--expect` **完全一致**的纯文字。它持久化最小上下文，只对匹配消息尝试一次指定固定回复，随后退出；同一批出现多条匹配消息时拒绝发送。

默认最多 3 次轮询、60 秒总期限，每次轮询最多 10 秒。可显式降低或调整 `--max-polls`（1–10）与 `--timeout-seconds`（1–120）。省略 `--reply-text` 仅收件核验，不发送回复，但仍保存恢复状态。轮询错误时停止，不自动重试。

本人在同一微信私聊实际看到完整回复，才记录“微信网关双向收发确认”。`API_ACCEPTED`、HTTP 200、测试通过都不能代替这一步。这一步没有把消息送到现有 dot。

测试完成后立即按 [停止与撤销](revocation.md)处理。
