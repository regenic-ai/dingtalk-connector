import type { DingTalkChatMode, DingTalkConversation, DingTalkInboundMessage } from "./dingtalk-message";
import {
  acceptRobotPayload,
  describeDingTalkConversation,
  listDingTalkConversations,
  listDingTalkMessages,
} from "./dingtalk-inbox";
import {
  DingTalkApiError,
  DingTalkOpenApi,
  type DingTalkCredentials,
  type DingTalkFetch,
} from "./dingtalk-openapi";

const ROBOT_TOPIC = "/v1.0/im/bot/messages/get";

export interface DingTalkSendTextInput {
  conversation_id: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
  text: string;
}

export interface DingTalkReadReceiptInput {
  conversation_id: string;
  chat_mode?: DingTalkChatMode;
  process_query_key: string;
}

export interface DingTalkImClient {
  ensureConnected(): Promise<void>;
  listRecentConversations(
    kinds?: readonly DingTalkChatMode[],
  ): Promise<DingTalkConversation[]>;
  describeConversation(conversationId: string): DingTalkConversation | undefined;
  listMessages(input: {
    conversation_id: string;
    after?: string;
    limit: number;
  }): Promise<DingTalkInboundMessage[]>;
  sendText(input: DingTalkSendTextInput): Promise<{ message_id: string }>;
  readReceipt(
    input: DingTalkReadReceiptInput,
  ): Promise<{ read_user_ids: string[] } | undefined>;
}

interface StreamDownStream {
  headers?: { messageId?: string };
  data?: string;
}

interface StreamSdkClient {
  registerCallbackListener(
    topic: string,
    callback: (message: StreamDownStream) => Promise<void>,
  ): unknown;
  connect(): Promise<void>;
  disconnect(): void;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

interface StreamSdkModule {
  DWClient: new (options: { clientId: string; clientSecret: string }) => StreamSdkClient;
  TOPIC_ROBOT?: string;
}

export interface DingTalkAppClientOptions {
  fetch?: DingTalkFetch;
  now?: () => number;
  loadSdk?: () => Promise<StreamSdkModule>;
}

export class DingTalkAppClient implements DingTalkImClient {
  private readonly api: DingTalkOpenApi;
  private stream: StreamSdkClient | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly credentials: DingTalkCredentials,
    private readonly options: DingTalkAppClientOptions = {},
  ) {
    this.api = new DingTalkOpenApi(credentials, options.fetch, options.now);
  }

  async ensureConnected(): Promise<void> {
    if (this.stream) {
      return;
    }
    if (!this.starting) {
      this.starting = this.start().catch((error: unknown) => {
        this.starting = undefined;
        throw error;
      });
    }
    await this.starting;
  }

  disconnect(): void {
    this.stream?.disconnect();
    this.stream = undefined;
    this.starting = undefined;
  }

  async listRecentConversations(
    kinds?: readonly DingTalkChatMode[],
  ): Promise<DingTalkConversation[]> {
    await this.ensureConnected();
    return listDingTalkConversations(this.credentials.client_id, kinds);
  }

  describeConversation(conversationId: string): DingTalkConversation | undefined {
    return describeDingTalkConversation(this.credentials.client_id, conversationId);
  }

  async listMessages(input: {
    conversation_id: string;
    after?: string;
    limit: number;
  }): Promise<DingTalkInboundMessage[]> {
    await this.ensureConnected();
    return listDingTalkMessages(
      this.credentials.client_id,
      input.conversation_id,
      input.after,
      input.limit,
    );
  }

  async sendText(input: DingTalkSendTextInput): Promise<{ message_id: string }> {
    const described = this.describeConversation(input.conversation_id);
    const chatMode = input.chat_mode ?? described?.chat_mode;
    const peerUserId = input.peer_user_id ?? described?.peer_user_id;
    if (chatMode === "p2p") {
      if (!peerUserId) {
        throw new DingTalkApiError("DingTalk direct send needs the peer staff id");
      }
      return { message_id: await this.api.sendDirectText(peerUserId, input.text) };
    }
    return {
      message_id: await this.api.sendGroupText(input.conversation_id, input.text),
    };
  }

  async readReceipt(
    input: DingTalkReadReceiptInput,
  ): Promise<{ read_user_ids: string[] } | undefined> {
    try {
      const readUserIds =
        input.chat_mode === "p2p"
          ? await this.api.readDirectUsers(input.process_query_key)
          : await this.api.readGroupUsers(
              input.conversation_id,
              input.process_query_key,
            );
      return { read_user_ids: readUserIds };
    } catch {
      return undefined;
    }
  }

  private async start(): Promise<void> {
    const sdk = await (this.options.loadSdk ?? loadDingTalkStreamSdk)();
    const topic = sdk.TOPIC_ROBOT ?? ROBOT_TOPIC;
    const stream = new sdk.DWClient({
      clientId: this.credentials.client_id,
      clientSecret: this.credentials.client_secret,
    });
    stream.registerCallbackListener(topic, async (message) => {
      acceptStreamMessage(this.credentials.client_id, message);
      const messageId = message.headers?.messageId?.trim();
      if (!messageId) {
        return;
      }
      stream.socketCallBackResponse(messageId, { success: true });
    });
    await stream.connect();
    this.stream = stream;
  }
}

export function acceptStreamMessage(clientId: string, message: StreamDownStream): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data ?? "");
  } catch {
    return false;
  }
  return acceptRobotPayload(clientId, parsed);
}

async function loadDingTalkStreamSdk(): Promise<StreamSdkModule> {
  const imported = (await import("dingtalk-stream")) as Partial<StreamSdkModule> & {
    default?: Partial<StreamSdkModule>;
  };
  const sdk = imported.DWClient ? imported : imported.default;
  if (!sdk?.DWClient) {
    throw new DingTalkApiError("dingtalk-stream SDK is missing DWClient");
  }
  return sdk as StreamSdkModule;
}

const liveClients = new Map<string, DingTalkAppClient>();
let clientOverride: DingTalkImClient | undefined;

export function setDingTalkClientForTests(client?: DingTalkImClient): void {
  clientOverride = client;
}

export function resetDingTalkClientsForTests(): void {
  for (const client of liveClients.values()) {
    client.disconnect();
  }
  liveClients.clear();
  clientOverride = undefined;
}

export function disconnectDingTalkClients(): void {
  for (const client of liveClients.values()) {
    client.disconnect();
  }
  liveClients.clear();
}

export function dingtalkClientFor(credentials: DingTalkCredentials): DingTalkImClient {
  if (clientOverride) {
    return clientOverride;
  }
  const key = `${credentials.client_id}\u0000${credentials.robot_code}`;
  const existing = liveClients.get(key);
  if (existing) {
    return existing;
  }
  const client = new DingTalkAppClient(credentials);
  liveClients.set(key, client);
  return client;
}
