const DINGTALK_API = "https://api.dingtalk.com";

export class DingTalkApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DingTalkApiError";
  }
}

export interface DingTalkCredentials {
  client_id: string;
  client_secret: string;
  robot_code: string;
}

export interface DingTalkFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DingTalkFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<DingTalkFetchResponse>;

export class DingTalkOpenApi {
  private token: { value: string; expires_at: number } | undefined;

  constructor(
    private readonly credentials: DingTalkCredentials,
    private readonly fetchImpl: DingTalkFetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    if (this.token && this.token.expires_at > this.now() + 60_000) {
      return this.token.value;
    }
    const body = await this.post("/v1.0/oauth2/accessToken", {
      appKey: this.credentials.client_id,
      appSecret: this.credentials.client_secret,
    });
    const token = stringValue(body.accessToken);
    const expireIn = numberValue(body.expireIn) ?? 7200;
    if (!token) {
      throw new DingTalkApiError("DingTalk access token response is missing accessToken");
    }
    this.token = {
      value: token,
      expires_at: this.now() + expireIn * 1000,
    };
    return token;
  }

  async sendGroupText(conversationId: string, text: string): Promise<string> {
    const body = await this.post(
      "/v1.0/robot/groupMessages/send",
      {
        robotCode: this.credentials.robot_code,
        openConversationId: conversationId,
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content: text }),
      },
      true,
    );
    return requireProcessQueryKey(body, "DingTalk group send");
  }

  async sendDirectText(userId: string, text: string): Promise<string> {
    const body = await this.post(
      "/v1.0/robot/oToMessages/batchSend",
      {
        robotCode: this.credentials.robot_code,
        userIds: [userId],
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content: text }),
      },
      true,
    );
    const invalid = stringList(body.invalidStaffIdList);
    if (invalid.length > 0) {
      throw new DingTalkApiError("DingTalk direct send rejected the staff id");
    }
    return requireProcessQueryKey(body, "DingTalk direct send");
  }

  async readGroupUsers(
    conversationId: string,
    processQueryKey: string,
  ): Promise<string[]> {
    const body = await this.post(
      "/v1.0/robot/groupMessages/query",
      {
        robotCode: this.credentials.robot_code,
        openConversationId: conversationId,
        processQueryKey,
        maxResults: 50,
      },
      true,
    );
    return readUserIds(body);
  }

  async readDirectUsers(processQueryKey: string): Promise<string[]> {
    const body = await this.post(
      "/v1.0/robot/oToMessages/readStatus",
      {
        robotCode: this.credentials.robot_code,
        processQueryKey,
      },
      true,
    );
    return readUserIds(body);
  }

  private async post(
    path: string,
    payload: unknown,
    authed = false,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (authed) {
      headers["x-acs-dingtalk-access-token"] = await this.accessToken();
    }
    const response = await this.fetchImpl(`${DINGTALK_API}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    let json: unknown = {};
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    if (!response.ok) {
      const code = isObject(json) ? stringValue(json.code) : undefined;
      throw new DingTalkApiError(
        code
          ? `DingTalk API ${path} failed (${code})`
          : `DingTalk API ${path} failed (${response.status})`,
        code,
      );
    }
    if (!isObject(json)) {
      throw new DingTalkApiError(`DingTalk API ${path} response is invalid`);
    }
    return json;
  }
}

function requireProcessQueryKey(
  body: Record<string, unknown>,
  action: string,
): string {
  const key = stringValue(body.processQueryKey);
  if (!key) {
    throw new DingTalkApiError(`${action} did not return processQueryKey`);
  }
  return key;
}

function readUserIds(body: Record<string, unknown>): string[] {
  return stringList(body.readUserIds ?? body.readUserIdList);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed ? [trimmed] : [];
  });
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
