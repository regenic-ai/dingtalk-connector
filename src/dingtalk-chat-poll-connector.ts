import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
  type ConnectorPollOptions,
  type IngestBatch,
  type PollResult,
  type SyncPollHint,
} from "@regenic/connector-contract";
import type { DingTalkImClient } from "./dingtalk-client";
import {
  DINGTALK_SOURCE,
  dingtalkConversationKind,
  messageCursor,
  type DingTalkChatMode,
  type DingTalkInboundMessage,
} from "./dingtalk-message";

export interface DingTalkChatPollConnectorOptions {
  connector_id: string;
  org_id: string;
  conversation_id: string;
  conversation_name?: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
  page_size?: number;
  now?: () => string;
}

export class DingTalkChatPollConnector {
  readonly source = DINGTALK_SOURCE;
  private readonly pageSize: number;
  private readonly now: () => string;
  private conversationName: string | undefined;
  private chatMode: DingTalkChatMode | undefined;
  private peerUserId: string | undefined;

  constructor(
    private readonly client: DingTalkImClient,
    private readonly options: DingTalkChatPollConnectorOptions,
  ) {
    this.pageSize = options.page_size ?? 50;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 50) {
      throw new Error("DingTalk page_size must be an integer from 1 through 50");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.conversationName = options.conversation_name?.trim() || undefined;
    this.chatMode = options.chat_mode;
    this.peerUserId = options.peer_user_id?.trim() || undefined;
  }

  describeConversation(): {
    conversation_id: string;
    name?: string;
    chat_mode?: DingTalkChatMode;
    peer_user_id?: string;
  } {
    return {
      conversation_id: this.options.conversation_id,
      ...(this.conversationName ? { name: this.conversationName } : {}),
      ...(this.chatMode ? { chat_mode: this.chatMode } : {}),
      ...(this.peerUserId ? { peer_user_id: this.peerUserId } : {}),
    };
  }

  rememberConversation(input: {
    name?: string;
    chat_mode?: DingTalkChatMode;
    peer_user_id?: string;
  }): void {
    const name = input.name?.replace(/\s+/g, " ").trim();
    if (name) {
      this.conversationName = name;
    }
    if (input.chat_mode) {
      this.chatMode = input.chat_mode;
    }
    const peer = input.peer_user_id?.trim();
    if (peer) {
      this.peerUserId = peer;
    }
  }

  async poll(
    cursor: ConnectorCursor | null,
    options?: ConnectorPollOptions,
  ): Promise<PollResult> {
    if (options?.media === true || options?.older === true) {
      return this.emptyPage(cursor, options?.older === true ? "older" : "media");
    }
    await this.client.ensureConnected();
    const described = this.client.describeConversation(this.options.conversation_id);
    if (described) {
      this.rememberConversation({
        name: described.name,
        chat_mode: described.chat_mode,
        peer_user_id: described.peer_user_id,
      });
    }
    const rows = await this.client.listMessages({
      conversation_id: this.options.conversation_id,
      after: cursor?.value,
      limit: this.pageSize + 1,
    });
    const page = rows.slice(0, this.pageSize);
    const hasMore = rows.length > this.pageSize;
    const nextCursor = page.length > 0
      ? messageCursor(page[page.length - 1]!)
      : cursor?.value;
    const batch = this.batch(cursor?.value, nextCursor, "live", page);
    return {
      batch,
      next_cursor: nextCursor,
      has_more: hasMore,
      poll_hint: dingtalkPollHint(),
    };
  }

  private emptyPage(cursor: ConnectorCursor | null, lane: string): PollResult {
    const batch = this.batch(cursor?.value, cursor?.value, lane, []);
    return {
      batch,
      next_cursor: cursor?.value,
      has_more: false,
      poll_hint: dingtalkPollHint(),
    };
  }

  private batch(
    cursor: string | undefined,
    nextCursor: string | undefined,
    lane: string,
    messages: DingTalkInboundMessage[],
  ): IngestBatch {
    return {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor, nextCursor, lane),
      received_at: this.now(),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      records: messages.flatMap((message) => this.toRecord(message)),
    };
  }

  private toRecord(message: DingTalkInboundMessage): IngestBatch["records"] {
    const chatMode = message.chat_mode ?? this.chatMode;
    const conversationKind = dingtalkConversationKind(chatMode);
    return [
      channelRecord({
        channel: DINGTALK_SOURCE,
        kind: "user",
        direction: "inbound",
        external_id: message.msg_id,
        occurred_at: new Date(message.create_at).toISOString(),
        actor_id: message.sender_id,
        ...(message.sender_label ? { actor_label: message.sender_label } : {}),
        scope_id: this.options.conversation_id,
        scope_name: message.conversation_title ?? this.conversationName,
        ...(conversationKind ? { conversation_kind: conversationKind } : {}),
        text: message.text,
      }),
    ];
  }

  private deliveryId(
    cursor: string | undefined,
    nextCursor: string | undefined,
    lane: string,
  ): string {
    const hash = createHash("sha256")
      .update(
        [
          this.options.conversation_id,
          lane,
          cursor ?? "initial",
          nextCursor ?? "empty",
        ].join("\u0000"),
      )
      .digest("hex");
    return `dingtalk:${this.options.conversation_id}:${hash}`;
  }
}

export function dingtalkPollHint(): SyncPollHint {
  return {
    live_seeded: true,
    history_pending: false,
  };
}
