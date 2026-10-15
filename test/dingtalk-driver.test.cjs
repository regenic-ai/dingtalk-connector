const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
  verifyChannelDriverConformance,
} = require("@regenic/connector-test-utils");
const { ChannelDriverError } = require("@regenic/connector-contract");
const { DwsCliClient } = require("../dist/dingtalk-client");
const { DingTalkCliError } = require("../dist/dingtalk-cli");
const {
  DingTalkChatEgress,
  dingtalkChatDriver,
  dingtalkChatPlugin,
  resetDwsClientsForTests,
} = require("../dist/index.js");

describe("dingtalkChatPlugin", () => {
  it("registers one stream and one egress adapter per conversation", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const mounted = await host.plugin(dingtalkChatPlugin, {
      installation_id: "ding-1",
      org_id: "local-owner",
      client: idleClient(),
      conversations: [
        { conversation_id: "cid-1", name: "工程群", chat_mode: "group" },
        { conversation_id: "cid-2", name: "小钉", chat_mode: "p2p", peer_user_id: "staff-2" },
      ],
    });
    assert.deepEqual(
      connectors.listStreams("ding-1").map((stream) => stream.thread_id),
      ["dingtalk:cid-1", "dingtalk:cid-2"],
    );
    assert.equal(egress.get("ding-1", "chat:cid-2")?.source, "dingtalk");
    await mounted.dispose();
    assert.equal(connectors.listStreams("ding-1").length, 0);
    await host.dispose();
  });
});

describe("DingTalkChatEgress", () => {
  it("sends text and refuses an attachment", async () => {
    const calls = [];
    const egress = new DingTalkChatEgress({
      ...idleClient(),
      async sendText(input) {
        calls.push(input);
        return { message_id: "sent-1" };
      },
    }, {
      installation_id: "ding-1",
      conversation_id: "cid-1",
      chat_mode: "group",
    });
    const receipt = await egress.send({
      installation_id: "ding-1",
      content: [{ role: "body", media_type: "text/plain", text: "收到" }],
    });
    assert.equal(receipt.rpc_id, "sent-1");
    assert.equal(calls[0].text, "收到");
    await assert.rejects(
      () => egress.send({
        installation_id: "ding-1",
        content: [{
          role: "attachment",
          media_type: "image/png",
          bytes: new Uint8Array([1]),
        }],
      }),
      (error) => error instanceof DingTalkCliError,
    );
  });
});

describe("dingtalkChatDriver", () => {
  afterEach(() => {
    resetDwsClientsForTests();
  });

  it("installs from a dws login without storing an app secret", () => {
    const installed = dingtalkChatDriver.install({
      id: "ding-1",
      org_id: "local-owner",
      config: { selection: "recent", kinds: ["group"] },
      now: "2026-10-14T00:00:00.000Z",
    });
    assert.equal(installed.config.client_secret, undefined);
    assert.equal(installed.config.selection, "recent");
    assert.equal(installed.credentials_ref, "keychain:dingtalk-chat");
    verifyChannelDriverConformance({
      driver: dingtalkChatDriver,
      enabled: installed,
      disabled: { ...installed, status: "disabled" },
    });
    assert.equal(dingtalkChatDriver.capabilities(installed).attention, true);
    assert.equal(dingtalkChatDriver.capabilities(installed).sync, true);
    assert.equal(dingtalkChatDriver.capabilities(installed).reply, true);
  });

  it("requires a conversation when the install picks conversations", () => {
    assert.throws(
      () => dingtalkChatDriver.install({
        id: "ding-1",
        org_id: "local-owner",
        config: { selection: "pick" },
        now: "2026-10-14T00:00:00.000Z",
      }),
      (error) => error instanceof ChannelDriverError && error.code === "invalid_config",
    );
  });

  it("mounts recently active conversations from dws", async () => {
    const { setDwsRunOptionsForTests } = require("../dist/dingtalk-client");
    setDwsRunOptionsForTests({
      spawn: async (input) => {
        const command = input.command.join(" ");
        if (command.includes("+recent-conversations")) {
          return json({
            conversations: [
              { openConversationId: "cid-1", title: "工程群", conversationType: "group" },
            ],
          });
        }
        return json({});
      },
    });
    const { host, connectors, facade } = await mountedHost();
    const installed = dingtalkChatDriver.install({
      id: "ding-1",
      org_id: "local-owner",
      config: { selection: "recent" },
      now: "2026-10-14T00:00:00.000Z",
    });
    const streams = await dingtalkChatDriver.resolveStreams(
      installed,
      facade,
      {},
      { discover: true },
    );
    assert.deepEqual(streams.map((stream) => stream.thread_id), ["dingtalk:cid-1"]);
    assert.equal(connectors.getStream("ding-1", "chat:cid-1")?.label, "工程群");
    await host.dispose();
  });
});

describe("DwsCliClient", () => {
  it("uses the dws v1 flags for history, send and mark-read", async () => {
    const commands = [];
    const client = new DwsCliClient({
      spawn: async (input) => {
        commands.push(input.command);
        const joined = input.command.join(" ");
        if (joined.includes("+chat-messages")) {
          return json({
            contractVersion: "im.message-list.v1",
            messages: [{
              messageId: "m1",
              conversationId: "cid-1",
              senderId: "staff-1",
              sender: "小钉",
              messageType: "text",
              text: "历史",
              createTime: "2026-08-01T00:00:00.000Z",
            }],
            hasMore: true,
            nextPage: { time: "2026-08-01T00:00:00Z" },
          });
        }
        if (joined.includes("+messages-send")) {
          return json({ result: { openTaskId: "task-1" } });
        }
        return json({ success: true });
      },
    });
    const page = await client.listMessages({
      conversation_id: "cid-1",
      direction: "older",
      time: "2026-08-02T00:00:00Z",
    });
    assert.equal(page.items[0].text, "历史");
    assert.equal(page.has_more, true);
    assert.equal(page.next_time, "2026-08-01T00:00:00Z");
    assert.deepEqual(commands[0], [
      "dws", "chat", "+chat-messages", "--group", "cid-1", "--no-reactions",
      "--direction", "older", "--limit", "50", "--time", "2026-08-02T00:00:00Z",
      "--format", "json",
    ]);

    const sent = await client.sendText({ conversation_id: "cid-1", text: "回复", idempotency_key: "k-1" });
    assert.equal(sent.message_id, "task-1");
    assert.equal(sent.channel_message_id, undefined);
    assert.deepEqual(commands[1], [
      "dws", "chat", "+messages-send", "--as", "user", "--group", "cid-1",
      "--text", "回复", "--idempotency-key", "k-1", "--yes", "--format", "json",
    ]);

    await client.sendText({ conversation_id: "cid-2", chat_mode: "p2p", peer_user_id: "staff-9", text: "单聊" });
    assert.deepEqual(commands[2].slice(5, 7), ["--user", "staff-9"]);

    await client.markRead({ conversation_id: "cid-1", message_id: "m1" });
    assert.deepEqual(commands[3], [
      "dws", "chat", "+conversation-mark-read", "--conversation-id", "cid-1",
      "--message-id", "m1", "--yes", "--format", "json",
    ]);
  });

  it("reads a direct chat by the peer userId", async () => {
    const commands = [];
    const client = new DwsCliClient({
      spawn: async (input) => {
        commands.push(input.command);
        return json({ messages: [], hasMore: false });
      },
    });
    await client.listMessages({
      conversation_id: "cid-p2p",
      chat_mode: "p2p",
      peer_user_id: "staff-2",
      direction: "newer",
      time: "2026-08-01T00:00:00Z",
    });
    assert.deepEqual(commands[0].slice(3, 5), ["--user", "staff-2"]);
  });

  it("kills dws when the host aborts", async () => {
    const controller = new AbortController();
    const client = new DwsCliClient({
      spawn: (input) => new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    const pending = client.listMessages({
      conversation_id: "cid-1",
      direction: "older",
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /aborted/);
  });
});

function json(body) {
  return { stdout: JSON.stringify(body), stderr: "", exit_code: 0 };
}

async function mountedHost() {
  const host = await createHost();
  const connectors = new MemoryConnectorRegistry();
  const egress = new MemoryEgressRegistry();
  await host.plugin(definePlugin({
    name: "registries",
    apply(ctx) {
      ctx.provide("connectors", connectors);
      ctx.provide("egress", egress);
    },
  }));
  return {
    host,
    connectors,
    facade: {
      get: (name) => host.get(name),
      plugin: (plugin, config) => host.plugin(plugin, config),
      now: () => "2026-10-14T00:00:00.000Z",
      secrets: {
        async read() {
          return undefined;
        },
        write() {},
      },
    },
  };
}

function idleClient() {
  return {
    async listMessages() {
      return { items: [], has_more: false };
    },
    async listRecentConversations() {
      return [];
    },
    async listAllConversations() {
      return [];
    },
    describeConversation() {
      return undefined;
    },
    async sendText() {
      return { message_id: "sent-1" };
    },
    async selfUserId() {
      return "me";
    },
    async listUnread() {
      return [];
    },
    async markRead() {},
  };
}
