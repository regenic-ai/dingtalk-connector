const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DingTalkApiError, DingTalkOpenApi } = require("../dist/index.js");

describe("DingTalkOpenApi", () => {
  it("caches the access token and sends a group text message", async () => {
    const calls = [];
    let now = 1_000_000;
    const api = new DingTalkOpenApi(
      {
        client_id: "ding-app",
        client_secret: "secret-value",
        robot_code: "ding-robot",
      },
      async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
        if (url.endsWith("/v1.0/oauth2/accessToken")) {
          return jsonResponse({ accessToken: "token-1", expireIn: 7200 });
        }
        return jsonResponse({ processQueryKey: "pqk-1" });
      },
      () => now,
    );

    assert.equal(await api.sendGroupText("cid-1", "你好"), "pqk-1");
    now += 1_000;
    assert.equal(await api.sendGroupText("cid-1", "再一次"), "pqk-1");
    assert.equal(calls.filter((call) => call.url.endsWith("/oauth2/accessToken")).length, 1);
    const send = calls.find((call) => call.url.endsWith("/groupMessages/send"));
    assert.equal(send.headers["x-acs-dingtalk-access-token"], "token-1");
    assert.equal(send.body.robotCode, "ding-robot");
    assert.equal(send.body.openConversationId, "cid-1");
    assert.equal(send.body.msgKey, "sampleText");
    assert.deepEqual(JSON.parse(send.body.msgParam), { content: "你好" });
    assert.equal(JSON.stringify(calls).includes("secret-value"), true);
    assert.equal(calls[1].body.appSecret, undefined);
  });

  it("rejects a direct send that names an invalid staff id", async () => {
    const api = new DingTalkOpenApi(
      {
        client_id: "ding-app",
        client_secret: "secret-value",
        robot_code: "ding-app",
      },
      async (url) => {
        if (url.endsWith("/oauth2/accessToken")) {
          return jsonResponse({ accessToken: "token-1", expireIn: 7200 });
        }
        return jsonResponse({
          processQueryKey: "pqk-2",
          invalidStaffIdList: ["missing"],
        });
      },
    );
    await assert.rejects(
      () => api.sendDirectText("missing", "你好"),
      (error) => error instanceof DingTalkApiError,
    );
  });

  it("reads group receipt user ids and surfaces API failures without the secret", async () => {
    const api = new DingTalkOpenApi(
      {
        client_id: "ding-app",
        client_secret: "secret-value",
        robot_code: "ding-app",
      },
      async (url) => {
        if (url.endsWith("/oauth2/accessToken")) {
          return jsonResponse({ accessToken: "token-1", expireIn: 7200 });
        }
        if (url.endsWith("/groupMessages/query")) {
          return jsonResponse({ readUserIds: ["staff-1"] });
        }
        return { ok: false, status: 400, async json() { return { code: "invalidParameter" }; } };
      },
    );
    assert.deepEqual(await api.readGroupUsers("cid-1", "pqk-1"), ["staff-1"]);
    await assert.rejects(
      () => api.readDirectUsers("pqk-1"),
      (error) => {
        assert.equal(error instanceof DingTalkApiError, true);
        assert.equal(error.message.includes("secret-value"), false);
        assert.equal(error.code, "invalidParameter");
        return true;
      },
    );
  });
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}
