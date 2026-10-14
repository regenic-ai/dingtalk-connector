const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
  verifyChannelDriverConformance,
} = require("@regenic/connector-test-utils");
const { ChannelDriverError } = require("@regenic/connector-contract");
const {
  DingTalkApiError,
  DingTalkChatEgress,
  dingtalkChatDriver,
  dingtalkChatPlugin,
  resetDingTalkClientsForTests,
  setDingTalkClientForTests,
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
      client: fakeClient(),
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
    assert.equal(egress.get("ding-1", "chat:cid-2"), undefined);
    await host.dispose();
  });
});

describe("DingTalkChatEgress", () => {
  it("sends text and refuses an attachment", async () => {
    const calls = [];
    const egress = new DingTalkChatEgress(fakeClient(calls), {
      installation_id: "ding-1",
      conversation_id: "cid-1",
      chat_mode: "group",
    });
    const receipt = await egress.send({
      installation_id: "ding-1",
      content: [{ role: "body", media_type: "text/plain", text: "收到" }],
    });
    assert.equal(receipt.rpc_id, "pqk-1");
    assert.deepEqual(calls, [{ conversation_id: "cid-1", chat_mode: "group", text: "收到" }]);
    await assert.rejects(
      () => egress.send({
        installation_id: "ding-1",
        content: [{
          role: "attachment",
          media_type: "image/png",
          bytes: new Uint8Array([1]),
        }],
      }),
      (error) => error instanceof DingTalkApiError,
    );
  });
});

describe("dingtalkChatDriver", () => {
  afterEach(() => {
    resetDingTalkClientsForTests();
  });

  it("keeps the client secret out of stored config", () => {
    const installed = dingtalkChatDriver.install({
      id: "ding-1",
      org_id: "local-owner",
      config: {
        client_id: "ding-app",
        client_secret: "secret-value",
        selection: "recent",
        kinds: ["group"],
      },
      now: "2026-10-14T00:00:00.000Z",
    });
    assert.equal(installed.config.client_secret, undefined);
    assert.equal(installed.config.client_id, "ding-app");
    assert.equal(installed.config.robot_code, "ding-app");
    assert.equal(installed.config.selection, "recent");
    assert.equal(installed.credentials_ref, "keychain:dingtalk-chat");
    assert.equal(JSON.stringify(installed).includes("secret-value"), false);
    verifyChannelDriverConformance({
      driver: dingtalkChatDriver,
      enabled: installed,
      disabled: { ...installed, status: "disabled" },
    });
    assert.deepEqual(dingtalkChatDriver.capabilities(installed), {
      sync: true,
      reply: true,
      create: false,
      list_title: "conversation",
      hydrate_on_open: true,
      receipts: true,
    });
  });

  it("requires a conversation id when the install picks conversations", () => {
    assert.throws(
      () => dingtalkChatDriver.install({
        id: "ding-1",
        org_id: "local-owner",
        config: { client_id: "ding-app", selection: "pick" },
        now: "2026-10-14T00:00:00.000Z",
      }),
      (error) => error instanceof ChannelDriverError && error.code === "invalid_config",
    );
  });

  it("mounts discovered conversations and reads a send receipt", async () => {
    setDingTalkClientForTests({
      async ensureConnected() {},
      describeConversation(conversationId) {
        return { conversation_id: conversationId, name: "工程群", chat_mode: "group" };
      },
      async listRecentConversations() {
        return [{ conversation_id: "cid-1", name: "工程群", chat_mode: "group" }];
      },
      async listMessages() {
        return [];
      },
      async sendText() {
        return { message_id: "pqk-1" };
      },
      async readReceipt() {
        return { read_user_ids: ["staff-9"] };
      },
    });
    const { host, connectors, facade } = await mountedHost();
    const installed = dingtalkChatDriver.install({
      id: "ding-1",
      org_id: "local-owner",
      config: { client_id: "ding-app", selection: "recent" },
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
    const receipts = await dingtalkChatDriver.readReceipts(
      installed,
      [{
        source: "dingtalk",
        target: "cid-1",
        outbound: [{
          external_id: "cid-1:out:pqk-1",
          occurred_at: "2026-10-14T00:00:00.000Z",
        }],
      }],
      facade,
      {},
    );
    assert.deepEqual(receipts.get("cid-1:out:pqk-1"), {
      state: "read",
      read_count: 1,
    });
    assert.deepEqual(dingtalkChatDriver.writeBackLabels("同意"), [
      "同意",
      "通过",
      "批准",
      "Approve",
      "approve",
      "Yes",
      "yes",
    ]);
    await host.dispose();
  });
});

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
    egress,
    facade: {
      get: (name) => host.get(name),
      plugin: (plugin, config) => host.plugin(plugin, config),
      now: () => "2026-10-14T00:00:00.000Z",
      secrets: {
        async read(_type, _id, field) {
          return field === "client_secret" ? "secret-value" : undefined;
        },
        write() {},
      },
    },
  };
}

function fakeClient(calls = []) {
  return {
    async ensureConnected() {},
    describeConversation() {
      return undefined;
    },
    async listRecentConversations() {
      return [];
    },
    async listMessages() {
      return [];
    },
    async sendText(input) {
      calls.push({
        conversation_id: input.conversation_id,
        chat_mode: input.chat_mode,
        text: input.text,
      });
      return { message_id: "pqk-1" };
    },
    async readReceipt() {
      return undefined;
    },
  };
}
