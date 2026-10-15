export const DINGTALK_SOURCE = "dingtalk";

export type DingTalkChatMode = "group" | "p2p";

export interface DingTalkConversation {
  conversation_id: string;
  name?: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
}

export interface DingTalkResourceRef {
  resource_id: string;
  type?: string;
  name?: string;
}

export interface DingTalkInboundMessage {
  msg_id: string;
  conversation_id: string;
  conversation_title?: string;
  chat_mode?: DingTalkChatMode;
  create_at: number;
  sender_id: string;
  sender_label?: string;
  peer_user_id?: string;
  text: string;
  msg_type: string;
  sender_type?: string;
  thread_id?: string;
  resources?: DingTalkResourceRef[];
}

export function dingtalkConversationKind(
  chatMode: DingTalkChatMode | undefined,
): "group" | "direct" | undefined {
  if (chatMode === "p2p") {
    return "direct";
  }
  if (chatMode === "group") {
    return "group";
  }
  return undefined;
}

export function dingtalkSentMessageId(externalId: string): string | undefined {
  const marker = ":out:";
  const index = externalId.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const id = externalId.slice(index + marker.length).trim();
  if (!id || id === "local") {
    return undefined;
  }
  return id;
}
