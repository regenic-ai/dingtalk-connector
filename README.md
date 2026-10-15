# 钉钉连接器

Regenic 的钉钉会话连接器。走 DingTalk Workspace CLI（`dws`），以当前登录用户读取群和单聊，和飞书连接器走 `lark-cli` 是同一类集成。

按 dws v1.0.64 的参数实现：

- 历史：`dws chat +chat-messages --group <cid>`（单聊用 `--user <userId>`），用 `--time` 加 `--direction older|newer` 按时间边界翻页，每页 50 条。
- 会话：最近活跃用 `+recent-conversations`，全部用 `+conversation-list --page-all`。
- 回复：`+messages-send --as user --text`，带 `--idempotency-key`，重试不会重复发送。
- 未读和已读：`+unread-chats`、`+conversation-mark-read --conversation-id --message-id`。

图片、文件、语音只同步成 `[image]`、`[file] 文件名` 这样的占位文本，不下载内容。回复只支持文本。

## 准备

组织管理员需要在开发者后台打开「CLI 访问管理」。

```bash
npm install -g dingtalk-workspace-cli
dws auth login
```

Token 留在系统钥匙串。

## 在 Regenic 里加载

```bash
export REGENIC_ROOT=/path/to/regenic
pnpm install
pnpm build
export REGENIC_CHANNEL_PLUGIN="$PWD"
```

安装卡片里选最近活跃、全部群和单聊，或自选会话。`dws` 可执行文件不在 `PATH` 上时，设置 `REGENIC_DWS_CLI`。
