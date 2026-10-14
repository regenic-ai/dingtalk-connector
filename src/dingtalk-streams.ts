import type { ConnectorInstallation, ConnectorStream } from "@regenic/connector-contract";
import type { DingTalkImClient } from "./dingtalk-client";
import { DingTalkChatPollConnector } from "./dingtalk-chat-poll-connector";
import { DINGTALK_SOURCE, type DingTalkConversation } from "./dingtalk-message";

export const DINGTALK_STREAM_PACE = {
  idle_ms: 15_000,
  catch_up_pages: 5,
} as const;

export const DINGTALK_RECENT_LIMIT = 30;

export function dingtalkStreamKey(conversationId: string): string {
  return `chat:${conversationId}`;
}

export function dingtalkConversationIdFromStreamKey(
  streamKey: string,
): string | undefined {
  if (!streamKey.startsWith("chat:") || streamKey.length <= 5) {
    return undefined;
  }
  return streamKey.slice(5);
}

export function createDingTalkStreams(
  installation: Pick<ConnectorInstallation, "id" | "org_id">,
  conversations: DingTalkConversation[],
  client: DingTalkImClient,
  pageSize?: number,
  now?: () => string,
): ConnectorStream[] {
  return conversations.map((conversation) => ({
    stream_key: dingtalkStreamKey(conversation.conversation_id),
    thread_id: `${DINGTALK_SOURCE}:${conversation.conversation_id}`,
    label: conversation.name ?? conversation.conversation_id,
    pace: { ...DINGTALK_STREAM_PACE },
    connector: new DingTalkChatPollConnector(client, {
      connector_id: installation.id,
      org_id: installation.org_id,
      conversation_id: conversation.conversation_id,
      conversation_name: conversation.name,
      chat_mode: conversation.chat_mode,
      peer_user_id: conversation.peer_user_id,
      page_size: pageSize,
      now,
    }),
  }));
}
