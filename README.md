# 钉钉连接器

Regenic 的钉钉会话连接器。走 DingTalk Workspace CLI（`dws`），以当前登录用户读取群和单聊，和飞书连接器走 `lark-cli` 是同一类集成。

按 dws v1.0.64 的参数实现：

- 历史：`dws chat +chat-messages --group <cid>`（单聊用 `--user <userId>`），用 `--time` 加 `--direction older|newer` 按时间边界翻页，每页 50 条。
- 会话：最近活跃用 `+recent-conversations`，全部用 `+conversation-list --page-all`。
- 回复：`+messages-send --as user --text`，带 `--idempotency-key`，重试不会重复发送。
- 未读和已读：`+unread-chats`、`+conversation-mark-read --conversation-id --message-id`。

- 附件：图片、文件、语音先以 `[image]`、`[file] 文件名` 加附件指针入库，再在媒体通道里用 `+messages-resource-download` 下载，以 `revise` 把文件补回原消息。单个文件上限 8 MB，失败按 1s、4s、16s… 退避重试 5 次。待下载队列存在 `~/.regenic/dingtalk-media-jobs`（可用 `REGENIC_DINGTALK_MEDIA_JOBS_DIR` 改位置），重启后继续。

回复只支持文本，和飞书连接器一致。

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

- 选择“全部”会通过完整会话列表发现会话；“最近活跃”仍只使用最近会话。完整列表若只有 `openConversationId`、`conversationName`，不能据此判定群聊或单聊。
- 自选会话会结合最近会话元数据判定类型；单聊仅在 dws 发现结果提供接收方用户 ID 时，才能在重启后恢复读取和回复路由。已观察到的最近会话字段 `conversationId`、`latestMessageTime`、`name`、`nameKnown`、`type` 可通过 `type: "direct"` 判定单聊，但没有接收方 ID，不能恢复路由。
- 自选会话类型不明，或单聊缺少接收方 ID 时，会明确报不支持/缺路由，不读取历史、不发送，也不会猜 ID 或回退使用 `--group`。
- 会话发现或认证状态检查失败会明确报错，不会伪装成空会话列表或“未登录”。
