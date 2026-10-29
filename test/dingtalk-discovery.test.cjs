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
const recentRows = require("./fixtures/recent-conversation-rows.json");
const fullRows = require("./fixtures/full-conversation-rows.json");
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

  it("resolves picked direct-message routing when full discovery supplies a peer", async () => {
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
    assert.deepEqual(commands.at(-1).slice(3, 5), ["--user", "peer-user"]);
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
          async listRecentConversations() {
            return [];
          },
          async listAllConversations() {
            return [{ conversation_id: "unknown" }];
          },
        },
      ),
      /Unable to resolve routing details.*did not establish direct\/group mode/,
    );
  });

  it("parses observed recent direct metadata without inventing a peer", async () => {
    const client = fixtureClient([]);
    const recent = await client.listRecentConversations();
    assert.equal(recent.filter((row) => row.chat_mode === "group").length, 5);
    assert.deepEqual(recent.find((row) => row.conversation_id === "fixture-direct"), {
      conversation_id: "fixture-direct",
      name: "Fixture direct",
      chat_mode: "p2p",
    });
    const full = await client.listAllConversations();
    assert.deepEqual(full, fullRows.map((row) => ({
      conversation_id: row.openConversationId,
      name: row.conversationName,
    })));
    assert.equal(client.describeConversation("fixture-direct").chat_mode, "p2p");
    assert.equal(client.describeConversation("fixture-direct").peer_user_id, undefined);
  });

  it("rejects a cold picked direct route from observed discovery rows without reading or sending", async () => {
    const commands = [];
    const client = fixtureClient(commands);
    await assert.rejects(
      () => resolveDingTalkConversationTargets(
        { selection: "pick", conversation_ids: ["fixture-direct"] },
        client,
      ),
      /Unsupported selected DingTalk direct conversation:.*peer user ID/,
    );
    assert.deepEqual(commands.map((args) => args[2]), [
      "+recent-conversations", "+conversation-list",
    ]);
  });

  it("does not classify a picked conversation from full-list ID and name alone", async () => {
    const commands = [];
    const client = fixtureClient(commands, []);
    await assert.rejects(
      () => resolveDingTalkConversationTargets(
        { selection: "pick", conversation_ids: ["fixture-direct"] },
        client,
      ),
      /did not establish direct\/group mode/,
    );
    assert.equal(commands.length, 2);
  });

  it("recovers routing when recent direct metadata supplies a parsed peerUserId", async () => {
    const commands = [];
    const client = new DwsCliClient({
      spawn: async ({ command }) => {
        commands.push(command);
        if (command[2] === "+recent-conversations") {
          return json({ conversations: [{
            ...recentRows.at(-1),
            peerUserId: "fixture-peer",
          }] });
        }
        assert.ok(["+chat-messages", "+messages-send"].includes(command[2]));
        assert.equal(command.includes("--group"), false);
        assert.equal(command[command.indexOf("--user") + 1], "fixture-peer");
        return json(command[2] === "+chat-messages"
          ? { messages: [], hasMore: false }
          : { openTaskId: "fixture-task" });
      },
    });
    const picked = await resolveDingTalkConversationTargets(
      { selection: "pick", conversation_ids: ["fixture-direct"] },
      client,
    );
    assert.equal(picked[0].peer_user_id, "fixture-peer");
    await client.listMessages({ conversation_id: "fixture-direct", direction: "older" });
    await client.sendText({ conversation_id: "fixture-direct", text: "fixture" });
    assert.deepEqual(commands.map((args) => args[2]), [
      "+recent-conversations", "+chat-messages", "+messages-send",
    ]);
  });

  for (const operation of ["listMessages", "sendText"]) {
    for (const routeSource of ["explicit", "cached"]) {
      it(`rejects ${operation} with ${routeSource} direct mode and no peer before invoking dws`, async () => {
        const commands = [];
        const client = fixtureClient(commands);
        if (routeSource === "cached") {
          await client.listRecentConversations();
          commands.length = 0;
        }
        for (const peer of [undefined, "", "   "]) {
          await assert.rejects(
            () => client[operation]({
              conversation_id: "fixture-direct",
              ...(routeSource === "explicit" ? { chat_mode: "p2p" } : {}),
              peer_user_id: peer,
              direction: "older",
              text: "fixture",
            }),
            /Unsupported DingTalk direct conversation: missing recipient routing/,
          );
        }
        assert.deepEqual(commands, []);
      });
    }
  }

  it("keeps explicit group history and send routing", async () => {
    const commands = [];
    const client = new DwsCliClient({
      spawn: async ({ command }) => {
        commands.push(command);
        return json({ messages: [], hasMore: false, openTaskId: "fixture-task" });
      },
    });
    await client.listMessages({
      conversation_id: "fixture-group", chat_mode: "group", direction: "older",
    });
    await client.sendText({
      conversation_id: "fixture-group", chat_mode: "group", text: "fixture",
    });
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.equal(command[command.indexOf("--group") + 1], "fixture-group");
      assert.equal(command.includes("--user"), false);
    }
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

function fixtureClient(commands, recent = recentRows) {
  return new DwsCliClient({
    spawn: async ({ command }) => {
      commands.push(command);
      if (command[2] === "+recent-conversations") {
        return json({ conversations: recent });
      }
      assert.equal(command[2], "+conversation-list", "only discovery is allowed");
      assert.ok(command.includes("--page-all"));
      return json({ conversations: fullRows });
    },
  });
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
