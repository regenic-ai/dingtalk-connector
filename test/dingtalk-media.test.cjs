const assert = require("node:assert/strict");
const { writeFile, mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");
const { DingTalkChatPollConnector } = require("../dist/dingtalk-chat-poll-connector");
const { DwsCliClient } = require("../dist/dingtalk-client");
const {
  clearDingTalkMediaJobsForTests,
  loadDingTalkMediaJobs,
  setDingTalkMediaJobsRootForTests,
} = require("../dist/dingtalk-media");

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("DingTalk attachments", () => {
  beforeEach(async () => {
    setDingTalkMediaJobsRootForTests(await mkdtemp(join(tmpdir(), "dingtalk-media-test-")));
  });

  afterEach(() => {
    clearDingTalkMediaJobsForTests();
    setDingTalkMediaJobsRootForTests();
  });

  it("sends a pointer first, then revises the message with the bytes", async () => {
    const downloads = [];
    const connector = newConnector(fakeClient({
      download: async (input) => {
        downloads.push(input);
        return { bytes: PNG, filename: "photo.png" };
      },
    }));
    const text = await connector.poll(null, { media: false });
    const created = text.batch.records[0];
    assert.equal(created.operation, "create");
    assert.equal(attachment(created).external_locator, "dingtalk:image:media-1");
    assert.equal(attachment(created).bytes, undefined);
    assert.equal(text.media_pending, true);
    assert.equal(downloads.length, 0);

    const media = await connector.poll({ value: text.next_cursor }, { media: true });
    assert.equal(downloads.length, 1);
    assert.deepEqual(downloads[0], {
      conversation_id: "cid-1",
      message_id: "img-1",
      resource_id: "media-1",
      type: "image",
    });
    const revised = media.batch.records[0];
    assert.equal(revised.operation, "revise");
    assert.equal(revised.external_id, "img-1");
    assert.equal(attachment(revised).media_type, "image/png");
    assert.equal(attachment(revised).bytes.byteLength, PNG.byteLength);
    assert.equal(media.media_pending, false);
    assert.notEqual(media.batch.delivery_id, text.batch.delivery_id);
    assert.deepEqual(loadDingTalkMediaJobs("ding-1", "cid-1"), []);
  });

  it("retries a failed download with backoff", async () => {
    let now = "2026-10-14T00:00:00.000Z";
    let fail = true;
    const connector = newConnector(fakeClient({
      download: async () => {
        if (fail) {
          throw new Error("network");
        }
        return { bytes: PNG };
      },
    }), () => now);
    const first = await connector.poll(null);
    assert.equal(first.batch.records.length, 1);
    assert.equal(first.media_pending, true);
    assert.equal(loadDingTalkMediaJobs("ding-1", "cid-1")[0].attempts, 1);

    fail = false;
    const early = await connector.poll({ value: first.next_cursor }, { media: true });
    assert.equal(early.batch.records.length, 0);
    assert.equal(early.media_pending, true);

    now = "2026-10-14T00:00:02.000Z";
    const later = await connector.poll({ value: first.next_cursor }, { media: true });
    assert.equal(later.batch.records[0].operation, "revise");
    assert.equal(later.media_pending, false);
  });

  it("drops a JSON error body instead of storing it as the file", async () => {
    const connector = newConnector(fakeClient({
      download: async () => ({ bytes: new TextEncoder().encode('{"error":{"code":5}}') }),
    }));
    const page = await connector.poll(null);
    assert.equal(page.batch.records.every((record) => record.operation === "create"), true);
    assert.equal(page.media_pending, true);
  });

  it("downloads through dws into a temporary working directory", async () => {
    const commands = [];
    const client = new DwsCliClient({
      spawn: async (input) => {
        commands.push(input);
        await writeFile(join(input.cwd, "周报.pdf"), "%PDF-1.7");
        return { stdout: JSON.stringify({ success: true }), stderr: "", exit_code: 0 };
      },
    });
    const file = await client.downloadResource({
      conversation_id: "cid-1",
      message_id: "msg-1",
      resource_id: "media-9",
      type: "file",
    });
    assert.equal(file.filename, "周报.pdf");
    assert.equal(new TextDecoder().decode(file.bytes), "%PDF-1.7");
    assert.deepEqual(commands[0].command, [
      "dws", "chat", "+messages-resource-download", "--resource-id", "media-9",
      "--type", "file", "--output", ".", "--message-id", "msg-1",
      "--open-conversation-id", "cid-1", "--format", "json",
    ]);
    assert.equal(commands[0].timeout_ms, 60000);
  });
});

function attachment(record) {
  return record.content.find((part) => part.role === "attachment");
}

function newConnector(client, now = () => "2026-10-14T00:00:00.000Z") {
  return new DingTalkChatPollConnector(client, {
    connector_id: "ding-1",
    org_id: "local-owner",
    conversation_id: "cid-1",
    chat_mode: "group",
    now,
  });
}

function fakeClient({ download }) {
  return {
    describeConversation() {
      return undefined;
    },
    async selfUserId() {
      return "me";
    },
    async listMessages() {
      return {
        items: [{
          msg_id: "img-1",
          conversation_id: "cid-1",
          create_at: Date.parse("2026-08-01T00:00:00.000Z"),
          sender_id: "staff-1",
          text: "[image]",
          msg_type: "picture",
          resources: [{ resource_id: "media-1", type: "image" }],
        }],
        has_more: false,
      };
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
    downloadResource: download,
  };
}
