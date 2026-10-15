const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { messageFromCli, timeToMillis } = require("../dist/dingtalk-client");

describe("dws message parsing", () => {
  it("reads a group history row", () => {
    const message = messageFromCli({
      messageId: "msg-1",
      conversationId: "cid-group",
      conversationType: "group",
      conversationTitle: "工程群",
      senderId: "staff-1",
      sender: "小钉",
      senderType: "user",
      messageType: "text",
      text: " 你好 ",
      createTime: "2026-08-01T00:00:00.000Z",
    }, "cid-group");
    assert.equal(message.conversation_id, "cid-group");
    assert.equal(message.chat_mode, "group");
    assert.equal(message.text, "你好");
    assert.equal(message.sender_id, "staff-1");
    assert.equal(message.sender_label, "小钉");
    assert.equal(message.create_at, Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("reads a direct chat and keeps the peer", () => {
    const message = messageFromCli({
      openMessageId: "msg-2",
      conversationType: "1",
      sender: { id: "staff-2", name: "阿花" },
      messageType: "text",
      text: { content: "在吗" },
      createTime: 1_700_000_000_000,
    }, "cid-direct");
    assert.equal(message.msg_id, "msg-2");
    assert.equal(message.chat_mode, "p2p");
    assert.equal(message.peer_user_id, "staff-2");
    assert.equal(message.text, "在吗");
    assert.equal(timeToMillis("1700000000000"), 1_700_000_000_000);
  });

  it("keeps media rows as a placeholder with their resource refs", () => {
    const image = messageFromCli({
      messageId: "msg-3",
      senderId: "staff-1",
      messageType: "picture",
      createTime: 10,
    }, "cid-group");
    assert.equal(image.text, "[image]");
    const file = messageFromCli({
      messageId: "msg-4",
      senderId: "staff-1",
      messageType: "file",
      threadId: "thread-1",
      resourceRefs: [{ type: "fileId", resourceId: "file-1", fileName: "周报.pdf" }],
      createTime: 10,
    }, "cid-group");
    assert.equal(file.text, "[file] 周报.pdf");
    assert.equal(file.thread_id, "thread-1");
    assert.deepEqual(file.resources, [{ resource_id: "file-1", type: "fileId", name: "周报.pdf" }]);
  });

  it("drops a row with neither text nor media", () => {
    assert.equal(messageFromCli({
      messageId: "msg-5",
      senderId: "staff-1",
      messageType: "system",
      createTime: 10,
    }, "cid-group"), undefined);
  });
});
