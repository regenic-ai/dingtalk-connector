export const DINGTALK_SOURCE = "dingtalk";

export type DingTalkChatMode = "group" | "p2p";

export interface DingTalkConversation {
  conversation_id: string;
  name?: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
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
}

export function messageCursor(message: {
  create_at: number;
  msg_id: string;
}): string {
  return `${String(Math.max(0, Math.trunc(message.create_at))).padStart(16, "0")}:${message.msg_id}`;
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

/**
 * Translate one DingTalk robot callback into an inbound message.
 * Unknown message types are dropped instead of being stored as text.
 */
export function parseRobotCallback(raw: unknown): DingTalkInboundMessage | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const conversationId = stringValue(raw.conversationId);
  const msgId = stringValue(raw.msgId);
  const msgType = stringValue(raw.msgtype);
  if (!conversationId || !msgId || !msgType) {
    return undefined;
  }
  const text = extractText(msgType, raw);
  if (!text) {
    return undefined;
  }
  const senderStaffId = stringValue(raw.senderStaffId);
  const senderId = senderStaffId || stringValue(raw.senderId);
  const chatbotUserId = stringValue(raw.chatbotUserId);
  if (!senderId || (chatbotUserId && senderId === chatbotUserId)) {
    return undefined;
  }
  const createAt = numberValue(raw.createAt);
  if (createAt === undefined || createAt <= 0) {
    return undefined;
  }
  const chatMode = chatModeOf(stringValue(raw.conversationType));
  const title = cleanLabel(stringValue(raw.conversationTitle));
  const senderLabel = cleanLabel(stringValue(raw.senderNick));
  return {
    msg_id: msgId,
    conversation_id: conversationId,
    ...(title ? { conversation_title: title } : {}),
    ...(chatMode ? { chat_mode: chatMode } : {}),
    create_at: Math.trunc(createAt),
    sender_id: senderId,
    ...(senderLabel ? { sender_label: senderLabel } : {}),
    ...(chatMode === "p2p" && senderStaffId ? { peer_user_id: senderStaffId } : {}),
    text,
    msg_type: msgType,
  };
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

function extractText(msgType: string, raw: Record<string, unknown>): string | undefined {
  if (msgType === "text" || msgType === "markdown") {
    return textContent(raw.text);
  }
  if (msgType === "richText") {
    const content = isObject(raw.content) ? raw.content.richText : undefined;
    if (!Array.isArray(content)) {
      return undefined;
    }
    const parts = content.flatMap((node) => {
      if (!isObject(node)) {
        return [];
      }
      const text = stringValue(node.text);
      return text ? [text] : [];
    });
    const joined = parts.join("\n").trim();
    return joined || undefined;
  }
  return undefined;
}

function textContent(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return stringValue(value.content);
}

function chatModeOf(value: string | undefined): DingTalkChatMode | undefined {
  if (value === "1") {
    return "p2p";
  }
  if (value === "2") {
    return "group";
  }
  return undefined;
}

function cleanLabel(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
