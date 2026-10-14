const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const {
  acceptRobotPayload,
  clearDingTalkInboxForTests,
  messageCursor,
  parseRobotCallback,
  setDingTalkInboxRootForTests,
} = require("../dist/index.js");
const {
  listDingTalkConversations,
  listDingTalkMessages,
} = require("../dist/dingtalk-inbox.js");

describe("parseRobotCallback", () => {
  it("reads a group text callback", () => {
    const message = parseRobotCallback({
      conversationId: "cid-group",
      conversationType: "2",
      conversationTitle: "工程群",
      msgId: "msg-1",
      msgtype: "text",
      text: { content: " 你好 " },
      senderStaffId: "staff-1",
      senderNick: "小钉",
      createAt: 1_700_000_000_000,
      chatbotUserId: "bot-1",
    });
    assert.equal(message.conversation_id, "cid-group");
    assert.equal(message.chat_mode, "group");
    assert.equal(message.text, "你好");
    assert.equal(message.sender_id, "staff-1");
    assert.equal(message.sender_label, "小钉");
    assert.equal(message.peer_user_id, undefined);
    assert.equal(messageCursor(message), `${String(1_700_000_000_000).padStart(16, "0")}:msg-1`);
  });

  it("reads a direct rich-text callback and keeps the peer staff id", () => {
    const message = parseRobotCallback({
      conversationId: "cid-direct",
      conversationType: "1",
      msgId: "msg-2",
      msgtype: "richText",
      content: { richText: [{ text: "第一行" }, { text: "第二行" }] },
      senderStaffId: "staff-2",
      senderId: "encrypted",
      createAt: "1700000000001",
    });
    assert.equal(message.chat_mode, "p2p");
    assert.equal(message.peer_user_id, "staff-2");
    assert.equal(message.text, "第一行\n第二行");
    assert.equal(message.sender_id, "staff-2");
  });

  it("drops picture callbacks and the robot's own sender id", () => {
    assert.equal(
      parseRobotCallback({
        conversationId: "cid-group",
        msgId: "msg-3",
        msgtype: "picture",
        senderStaffId: "staff-1",
        createAt: 10,
      }),
      undefined,
    );
    assert.equal(
      parseRobotCallback({
        conversationId: "cid-group",
        msgId: "msg-4",
        msgtype: "text",
        text: { content: "echo" },
        senderId: "bot-1",
        chatbotUserId: "bot-1",
        createAt: 10,
      }),
      undefined,
    );
  });
});

describe("dingtalk inbox", () => {
  let root;

  afterEach(() => {
    clearDingTalkInboxForTests();
    setDingTalkInboxRootForTests(undefined);
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dedupes by message id and lists conversations newest first", () => {
    root = mkdtempSync(join(tmpdir(), "dingtalk-inbox-"));
    setDingTalkInboxRootForTests(root);
    const first = {
      conversationId: "cid-a",
      conversationType: "2",
      conversationTitle: "甲",
      msgId: "m1",
      msgtype: "text",
      text: { content: "一" },
      senderStaffId: "s1",
      createAt: 20,
    };
    assert.equal(acceptRobotPayload("ding-app", first), true);
    assert.equal(acceptRobotPayload("ding-app", first), true);
    acceptRobotPayload("ding-app", {
      ...first,
      conversationId: "cid-b",
      conversationTitle: "乙",
      msgId: "m2",
      createAt: 30,
    });
    assert.deepEqual(
      listDingTalkConversations("ding-app").map((chat) => chat.conversation_id),
      ["cid-b", "cid-a"],
    );
    assert.equal(listDingTalkMessages("ding-app", "cid-a", undefined, 10).length, 1);
    const cursor = messageCursor({ create_at: 20, msg_id: "m1" });
    assert.equal(listDingTalkMessages("ding-app", "cid-a", cursor, 10).length, 0);
  });
});
