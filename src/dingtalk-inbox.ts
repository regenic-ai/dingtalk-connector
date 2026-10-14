import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  messageCursor,
  parseRobotCallback,
  type DingTalkChatMode,
  type DingTalkConversation,
  type DingTalkInboundMessage,
} from "./dingtalk-message";

const MAX_MESSAGES_PER_CONVERSATION = 200;

interface StoredConversation {
  conversation_id: string;
  name?: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
  last_at: number;
}

interface InboxFile {
  conversations: Record<string, StoredConversation>;
  messages: Record<string, DingTalkInboundMessage[]>;
}

const memory = new Map<string, InboxFile>();
let rootOverride: string | undefined;

export function setDingTalkInboxRootForTests(root?: string): void {
  rootOverride = root?.trim() || undefined;
  memory.clear();
}

export function clearDingTalkInboxForTests(): void {
  memory.clear();
  if (!rootOverride) {
    return;
  }
  rmSync(rootOverride, { recursive: true, force: true });
}

export function clearAllDingTalkInboxes(): void {
  memory.clear();
  try {
    rmSync(resolveRoot(), { recursive: true, force: true });
  } catch {
    // A missing cache is already clear.
  }
}

export function acceptRobotPayload(clientId: string, raw: unknown): boolean {
  const message = parseRobotCallback(raw);
  if (!message) {
    return false;
  }
  rememberDingTalkMessage(clientId, message);
  return true;
}

export function rememberDingTalkMessage(
  clientId: string,
  message: DingTalkInboundMessage,
): void {
  const inbox = load(clientId);
  const current = inbox.messages[message.conversation_id] ?? [];
  if (!current.some((item) => item.msg_id === message.msg_id)) {
    current.push(message);
    current.sort(compareMessages);
    inbox.messages[message.conversation_id] = current.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  const prev = inbox.conversations[message.conversation_id];
  inbox.conversations[message.conversation_id] = {
    conversation_id: message.conversation_id,
    name: message.conversation_title || prev?.name,
    chat_mode: message.chat_mode ?? prev?.chat_mode,
    peer_user_id: message.peer_user_id ?? prev?.peer_user_id,
    last_at: Math.max(prev?.last_at ?? 0, message.create_at),
  };
  save(clientId, inbox);
}

export function listDingTalkMessages(
  clientId: string,
  conversationId: string,
  after: string | undefined,
  limit: number,
): DingTalkInboundMessage[] {
  const list = load(clientId).messages[conversationId] ?? [];
  const filtered = after
    ? list.filter((message) => messageCursor(message) > after)
    : list;
  return filtered.slice(0, limit);
}

export function listDingTalkConversations(
  clientId: string,
  kinds?: readonly DingTalkChatMode[],
): DingTalkConversation[] {
  return Object.values(load(clientId).conversations)
    .filter((chat) => !kinds || !chat.chat_mode || kinds.includes(chat.chat_mode))
    .sort((left, right) => right.last_at - left.last_at || left.conversation_id.localeCompare(right.conversation_id))
    .map((chat) => ({
      conversation_id: chat.conversation_id,
      ...(chat.name ? { name: chat.name } : {}),
      ...(chat.chat_mode ? { chat_mode: chat.chat_mode } : {}),
      ...(chat.peer_user_id ? { peer_user_id: chat.peer_user_id } : {}),
    }));
}

export function describeDingTalkConversation(
  clientId: string,
  conversationId: string,
): DingTalkConversation | undefined {
  const chat = load(clientId).conversations[conversationId];
  if (!chat) {
    return undefined;
  }
  return {
    conversation_id: chat.conversation_id,
    ...(chat.name ? { name: chat.name } : {}),
    ...(chat.chat_mode ? { chat_mode: chat.chat_mode } : {}),
    ...(chat.peer_user_id ? { peer_user_id: chat.peer_user_id } : {}),
  };
}

function compareMessages(
  left: DingTalkInboundMessage,
  right: DingTalkInboundMessage,
): number {
  return left.create_at - right.create_at || left.msg_id.localeCompare(right.msg_id);
}

function load(clientId: string): InboxFile {
  const cached = memory.get(clientId);
  if (cached) {
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath(clientId), "utf8")) as Partial<InboxFile>;
    const inbox: InboxFile = {
      conversations: parsed.conversations ?? {},
      messages: parsed.messages ?? {},
    };
    memory.set(clientId, inbox);
    return inbox;
  } catch {
    const inbox: InboxFile = { conversations: {}, messages: {} };
    memory.set(clientId, inbox);
    return inbox;
  }
}

function save(clientId: string, inbox: InboxFile): void {
  memory.set(clientId, inbox);
  const path = filePath(clientId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(inbox));
  renameSync(temporary, path);
}

function filePath(clientId: string): string {
  return join(resolveRoot(), `${safeSegment(clientId)}.json`);
}

function resolveRoot(): string {
  if (rootOverride) {
    return rootOverride;
  }
  const env = process.env.REGENIC_DINGTALK_INBOX_DIR?.trim();
  if (env) {
    return env;
  }
  const home = process.env.REGENIC_HOME?.trim() || join(homedir(), ".regenic");
  return join(home, "dingtalk-inbox");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "x";
}
