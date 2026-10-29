const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
} = require("@regenic/connector-test-utils");
const {
  DwsCliClient,
  resetDwsClientsForTests,
  setDwsRunOptionsForTests,
} = require("../dist/dingtalk-client");
const {
  resolveDingTalkConversationTargets,
} = require("../dist/dingtalk-directory");
const { dingtalkChatDriver } = require("../dist/dingtalk-chat-driver");
const {
  createDingTalkRecentSyncSource,
  createDingTalkSyncSource,
} = require("../dist/dingtalk-sync-source");
const {
  probeDingTalkCatalog,
  resetDingTalkProbeForTests,
} = require("../dist/probe");

afterEach(() => {
  resetDingTalkProbeForTests();
  resetDwsClientsForTests();
});

describe("DingTalk conversation discovery", () => {
  it("propagates discovery failures instead of returning a partial known list", async () => {
    const discoveryError = new Error("conversation list unavailable");
    await assert.rejects(
      () => resolveDingTalkConversationTargets(
        { selection: "recent" },
        {
          describeConversation() {
            return undefined;
          },
          async listRecentConversations() {
            throw discoveryError;
          },
        },
        { known: [{ conversation_id: "known", chat_mode: "group" }] },
      ),
      (error) => error === discoveryError,
    );
  });

  it("propagates picker option discovery failures", async () => {
    const discoveryError = new Error("conversation picker unavailable");
    setDwsRunOptionsForTests({
      spawn: async () => {
        throw discoveryError;
      },
    });
    await assert.rejects(
      () => dingtalkChatDriver.listCatalogFieldOptions({ env: {} }),
      (error) => error === discoveryError,
    );
  });

  it("resolves picked direct-message routing after a cold start", async () => {
    const commands = [];
    const client = new DwsCliClient({
      spawn: async (input) => {
        commands.push(input.command);
        const command = input.command.join(" ");
        if (command.includes("+conversation-list")) {
          return json({
            conversations: [{
              openConversationId: "p2p-conversation",
              title: "小钉",
              conversationType: "p2p",
              userId: "peer-user",
            }],
          });
        }
        return json({ messages: [], hasMore: false });
      },
    });

    const picked = await resolveDingTalkConversationTargets(
      { selection: "pick", conversation_ids: ["p2p-conversation"] },
      client,
    );
    assert.deepEqual(picked, [{
      conversation_id: "p2p-conversation",
      name: "小钉",
      chat_mode: "p2p",
      peer_user_id: "peer-user",
    }]);

    await client.listMessages({
      conversation_id: picked[0].conversation_id,
      direction: "newer",
    });
    assert.deepEqual(commands[1].slice(3, 5), ["--user", "peer-user"]);
  });

  it("rebuilds picked direct-message egress routing on a cold thread open", async () => {
    const commands = [];
    setDwsRunOptionsForTests({
      spawn: async (input) => {
        commands.push(input.command);
        const command = input.command.join(" ");
        if (command.includes("+conversation-list")) {
          return json({
            conversations: [{
              openConversationId: "p2p-conversation",
              title: "小钉",
              conversationType: "p2p",
              userId: "peer-user",
            }],
          });
        }
        return json({ openTaskId: "sent-task" });
      },
    });
    const { host, facade } = await mountedHost();
    try {
      const installation = dingtalkChatDriver.install({
        id: "ding-1",
        org_id: "local-owner",
        config: { selection: "pick", conversation_ids: ["p2p-conversation"] },
        now: "2026-10-14T00:00:00.000Z",
      });
      const stream = await dingtalkChatDriver.resolveThreadStream(
        installation,
        { source: "dingtalk", target: "p2p-conversation" },
        facade,
        {},
      );
      assert.equal(stream.connector.describeConversation().peer_user_id, "peer-user");

      const egress = host.get("egress").get("ding-1", "chat:p2p-conversation");
      await egress.send({
        installation_id: "ding-1",
        content: [{ role: "body", media_type: "text/plain", text: "重启后回复" }],
      });
      assert.deepEqual(commands.at(-1).slice(5, 7), ["--user", "peer-user"]);
    } finally {
      await host.dispose();
    }
  });

  it("fails clearly when a picked conversation has no usable routing details", async () => {
    await assert.rejects(
      () => resolveDingTalkConversationTargets(
        { selection: "pick", conversation_ids: ["unknown"] },
        {
          describeConversation() {
            return undefined;
          },
          async listAllConversations() {
            return [{ conversation_id: "unknown" }];
          },
        },
      ),
      /Unable to resolve routing details.*unknown/,
    );
  });

  it("uses full discovery for the all-conversations sync source", async () => {
    const calls = [];
    const client = {
      async listRecentConversations() {
        calls.push("recent");
        return [{ conversation_id: "recent-chat", chat_mode: "group" }];
      },
      async listAllConversations() {
        calls.push("all");
        return [
          { conversation_id: "recent-chat", chat_mode: "group" },
          { conversation_id: "older-chat", chat_mode: "p2p", peer_user_id: "peer" },
        ];
      },
    };

    const all = await createDingTalkSyncSource(client, ["group", "p2p"]).listDirectory();
    assert.deepEqual(calls, ["all"]);
    assert.deepEqual(all.members.map((member) => member.stream_key), [
      "chat:recent-chat",
      "chat:older-chat",
    ]);

    calls.length = 0;
    const recent = await createDingTalkRecentSyncSource(client, ["group"]).listDirectory();
    assert.deepEqual(calls, ["recent"]);
    assert.deepEqual(recent.members.map((member) => member.stream_key), ["chat:recent-chat"]);
  });
});

describe("DingTalk probe cache", () => {
  it("isolates environment contexts and refreshes entries after the TTL", async () => {
    let calls = 0;
    const spawn = async ({ env }) => {
      calls += 1;
      return json({ authenticated: env.PROFILE === "signed-in" });
    };
    const probe = (profile, now) => probeDingTalkCatalog({
      env: { PROFILE: profile },
      spawn,
      now: () => now,
    });

    assert.equal((await probe("signed-in", 100)).services.dws.ready, true);
    assert.equal((await probe("signed-in", 101)).services.dws.ready, true);
    assert.equal(calls, 1);
    assert.equal((await probe("signed-out", 101)).services.dws.ready, false);
    assert.equal(calls, 2);

    assert.equal((await probe("signed-in", 20_100)).services.dws.ready, true);
    assert.equal(calls, 3);
  });

  it("does not reuse cached results across different command contexts", async () => {
    let calls = 0;
    const spawn = async ({ command }) => {
      calls += 1;
      return json({ authenticated: command[0] === "dws-ready" });
    };
    const input = (command) => ({
      env: {},
      command,
      spawn,
      now: () => 1,
    });

    assert.equal((await probeDingTalkCatalog(input("dws-ready"))).services.dws.ready, true);
    assert.equal((await probeDingTalkCatalog(input("dws-other"))).services.dws.ready, false);
    assert.equal(calls, 2);
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
