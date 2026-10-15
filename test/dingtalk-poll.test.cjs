const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { verifyPollConnectorConformance } = require("@regenic/connector-test-utils");
const { DingTalkChatPollConnector, secondIso } = require("../dist/dingtalk-chat-poll-connector");

describe("DingTalkChatPollConnector", () => {
  it("seeds the newest page and then walks older history", async () => {
    const calls = [];
    const connector = newConnector(fakeClient(calls));
    const report = await verifyPollConnectorConformance({
      connector,
      cursor: null,
      connector_id: "ding-1",
      source: "dingtalk",
    });
    assert.equal(report.record_count, 2);
    const seeded = await connector.poll(null);
    assert.equal(seeded.poll_hint.live_seeded, true);
    assert.equal(seeded.poll_hint.history_pending, true);
    assert.deepEqual(
      seeded.batch.records.map((record) => record.external_id),
      ["m1", "m2"],
    );
    assert.equal(seeded.batch.records[0].direction_tags[0], "outbound");
    const older = await connector.poll({ value: seeded.next_cursor }, { older: true });
    assert.equal(older.has_more, false);
    assert.equal(older.poll_hint.history_pending, false);
    assert.deepEqual(older.batch.records.map((record) => record.external_id), ["m0"]);
    const olderCall = calls.find((call) => call.direction === "older" && call.time);
    assert.equal(olderCall.time, "2026-08-01T00:00:00Z");
    assert.equal(olderCall.chat_mode, "group");
  });

  it("reads only messages newer than the seeded head", async () => {
    const calls = [];
    const connector = newConnector(fakeClient(calls, {
      newer: [
        message("m2", "2026-08-02T00:00:00.000Z", "第二句", "staff-1"),
        message("m3", "2026-08-02T00:00:00.000Z", "同一毫秒", "staff-2"),
        message("m4", "2026-08-03T00:00:00.000Z", "新消息", "staff-1"),
      ],
    }));
    const seeded = await connector.poll(null);
    const live = await connector.poll({ value: seeded.next_cursor });
    assert.equal(live.poll_hint.live_seeded, true);
    assert.deepEqual(live.batch.records.map((record) => record.external_id), ["m3", "m4"]);
    const newerCall = calls.find((call) => call.direction === "newer");
    assert.equal(newerCall.time, "2026-08-02T00:00:00Z");
    const again = await connector.poll({ value: live.next_cursor });
    assert.equal(again.batch.records.length, 0);
  });

  it("scrolls before an on-screen anchor without moving stored history", async () => {
    const calls = [];
    const connector = newConnector(fakeClient(calls));
    const seeded = await connector.poll(null);
    const scrolled = await connector.poll(
      { value: seeded.next_cursor },
      { older: true, before: "2026-08-01T00:00:00.000Z", before_external_id: "m1" },
    );
    assert.deepEqual(scrolled.batch.records.map((record) => record.external_id), ["m0"]);
    assert.equal(scrolled.poll_hint.history_pending, false);
    const state = JSON.parse(scrolled.next_cursor);
    assert.equal(state.tail_ms, Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("returns the latest page for an opened thread", async () => {
    const calls = [];
    const connector = newConnector(fakeClient(calls));
    const seeded = await connector.poll(null);
    const latest = await connector.poll({ value: seeded.next_cursor }, { latest: true });
    assert.deepEqual(latest.batch.records.map((record) => record.external_id), ["m1", "m2"]);
    assert.equal(calls.at(-1).timeout_ms, 8000);
  });

  it("passes the host abort signal to dws", async () => {
    const calls = [];
    const connector = newConnector(fakeClient(calls));
    const controller = new AbortController();
    await connector.poll(null, { signal: controller.signal });
    assert.equal(calls[0].signal, controller.signal);
  });

  it("rounds dws time flags outward to whole seconds", () => {
    const ms = Date.parse("2026-08-01T00:00:00.400Z");
    assert.equal(secondIso(ms, "floor"), "2026-08-01T00:00:00Z");
    assert.equal(secondIso(ms, "ceil"), "2026-08-01T00:00:01Z");
  });
});

function newConnector(client) {
  return new DingTalkChatPollConnector(client, {
    connector_id: "ding-1",
    org_id: "local-owner",
    conversation_id: "cid-1",
    conversation_name: "工程群",
    chat_mode: "group",
    now: () => "2026-10-14T00:00:00.000Z",
  });
}

function fakeClient(calls, pages = {}) {
  const newest = [
    message("m2", "2026-08-02T00:00:00.000Z", "第二句", "staff-1"),
    message("m1", "2026-08-01T00:00:00.000Z", "第一句", "me"),
  ];
  const older = [
    message("m1", "2026-08-01T00:00:00.000Z", "第一句", "me"),
    message("m0", "2026-07-01T00:00:00.000Z", "更早", "staff-1"),
  ];
  return {
    describeConversation() {
      return { conversation_id: "cid-1", name: "工程群", chat_mode: "group" };
    },
    async selfUserId() {
      return "me";
    },
    async listMessages(input) {
      calls.push(input);
      if (input.direction === "newer") {
        return { items: pages.newer ?? [], has_more: false };
      }
      if (input.time) {
        return { items: older, has_more: false };
      }
      return { items: newest, has_more: true, next_time: "2026-08-01T00:00:00Z" };
    },
    async listRecentConversations() {
      return [];
    },
    async listAllConversations() {
      return [];
    },
    async sendText() {
      return { message_id: "sent-1" };
    },
    async listUnread() {
      return [];
    },
    async markRead() {},
  };
}

function message(id, createTime, text, senderId) {
  return {
    msg_id: id,
    conversation_id: "cid-1",
    chat_mode: "group",
    create_at: Date.parse(createTime),
    sender_id: senderId,
    sender_label: senderId === "me" ? "我" : "小钉",
    text,
    msg_type: "text",
    sender_type: "user",
  };
}
