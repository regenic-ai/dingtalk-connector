# 钉钉连接器

Regenic 的钉钉会话连接器。形态对齐飞书连接器：一个 `ChannelDriver` 负责安装、会话目录和回复，每条会话一个 poll stream，回复走同一个安装上的 egress。

钉钉机器人没有飞书 `lark-cli` 那种用户态历史拉取。这个连接器用企业内部应用的 **Stream 模式**接收消息，用 **OpenAPI** 把回复发回群或单聊。连接建立之前的历史不会补拉。

## 在钉钉后台

1. 打开 [钉钉开发者后台](https://open-dev.dingtalk.com/) ，创建企业内部应用，记下 Client ID（AppKey）和 Client Secret。
2. 添加机器人能力，消息接收方式选 **Stream 模式**，开通「企业内机器人发送消息」，然后发布。
3. 机器人编码默认就是 Client ID。不一致时在安装表单里填写 Robot code。

## 在 Regenic 里加载

本包是 extra plugin。它依赖本机的 Regenic 仓库（`@regenic/connector-contract` 和 `@regenic/plugin-host`）。

```bash
export REGENIC_ROOT=/path/to/regenic
pnpm install
pnpm build
```

把构建好的目录放到插件目录下，目录名任意，里面要有 `package.json`：

```bash
mkdir -p ~/.regenic/plugins
ln -s "$PWD" ~/.regenic/plugins/dingtalk-connector
```

也可以不复制目录，直接指定这一个包：

```bash
export REGENIC_CHANNEL_PLUGIN=/path/to/dingtalk-connector
```

安装卡片里填写 Client ID。Client Secret 会进系统钥匙串，不会写进安装配置。也可以用环境变量 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET` 作为无界面安装的后备。

同步范围：

- **最近活跃**：跟进最近发到机器人的会话。
- **全部**：跟进所有会发到机器人的群和单聊。
- **自选**：粘贴 `openConversationId`（`cid...`），多个用逗号分隔。

群回复调用 `POST /v1.0/robot/groupMessages/send`。单聊在收到对端 staff id 之后调用 `POST /v1.0/robot/oToMessages/batchSend`。

## 开发

`REGENIC_ROOT` 指向 Regenic 仓库，或把该仓库放在本目录的上一级。测试会链接其中已经构建的 contract 包。

```bash
pnpm --dir "$REGENIC_ROOT" --filter @regenic/plugin-host --filter @regenic/connector-contract --filter @regenic/connector-test-utils build
pnpm test
```
