import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DingTalkCliError,
  isDwsMissing,
  runDws,
  type DwsRunOptions,
} from "./dingtalk-cli";
import type {
  DingTalkChatMode,
  DingTalkConversation,
  DingTalkInboundMessage,
  DingTalkResourceRef,
} from "./dingtalk-message";
import type { DingTalkDownloadedFile, DingTalkDownloadType } from "./dingtalk-media";

export { DingTalkCliError };

const DOWNLOAD_TIMEOUT_MS = 60_000;

async function firstFile(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { recursive: true });
  for (const entry of entries.sort()) {
    if (basename(entry).startsWith(".")) {
      continue;
    }
    if ((await stat(join(directory, entry))).isFile()) {
      return entry;
    }
  }
  return undefined;
}
export type { DwsRunOptions };

export interface DingTalkHistoryPage {
  items: DingTalkInboundMessage[];
  has_more: boolean;
  /** Lower or upper time boundary dws hands back for the next page. */
  next_time?: string;
}

export interface DingTalkHistoryRequest {
  conversation_id: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
  /** `older` reads backwards from `time` (or now); `newer` reads forwards from `time`. */
  direction: "older" | "newer";
  time?: string;
  limit?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface DingTalkUnread {
  conversation_id: string;
  unread_count?: number;
  mentioned?: boolean;
}

export interface DingTalkSendResult {
  /** openMessageId when dws reports one, else its openTaskId or our idempotency key. */
  message_id: string;
  /** Only a real openMessageId; history rows can be matched against it. */
  channel_message_id?: string;
}

export const DINGTALK_PAGE_SIZE = 50;

export interface DingTalkImClient {
  listMessages(input: DingTalkHistoryRequest): Promise<DingTalkHistoryPage>;
  listRecentConversations(
    kinds?: readonly DingTalkChatMode[],
  ): Promise<DingTalkConversation[]>;
  listAllConversations(
    kinds?: readonly DingTalkChatMode[],
  ): Promise<DingTalkConversation[]>;
  describeConversation(conversationId: string): DingTalkConversation | undefined;
  sendText(input: {
    conversation_id: string;
    chat_mode?: DingTalkChatMode;
    peer_user_id?: string;
    text: string;
    idempotency_key?: string;
  }): Promise<DingTalkSendResult>;
  selfUserId(): Promise<string | undefined>;
  listUnread(): Promise<DingTalkUnread[]>;
  markRead(input: { conversation_id: string; message_id?: string }): Promise<void>;
  downloadResource?(input: DingTalkDownloadRequest): Promise<DingTalkDownloadedFile>;
}

export interface DingTalkDownloadRequest {
  conversation_id: string;
  message_id: string;
  resource_id: string;
  type: DingTalkDownloadType;
  signal?: AbortSignal;
}

export class DwsCliClient implements DingTalkImClient {
  private readonly known = new Map<string, DingTalkConversation>();
  private selfId: string | undefined;

  constructor(private readonly options: DwsRunOptions = {}) {}

  async listMessages(input: DingTalkHistoryRequest): Promise<DingTalkHistoryPage> {
    const described = this.describeConversation(input.conversation_id);
    const chatMode = input.chat_mode ?? described?.chat_mode;
    const peerUserId = input.peer_user_id ?? described?.peer_user_id;
    const args = [
      "chat",
      "+chat-messages",
      ...(chatMode === "p2p" && peerUserId
        ? ["--user", peerUserId]
        : ["--group", input.conversation_id]),
      "--no-reactions",
      "--direction",
      input.direction,
      "--limit",
      String(input.limit ?? DINGTALK_PAGE_SIZE),
    ];
    if (input.time) {
      args.push("--time", input.time);
    }
    const payload = await runDws(args, this.runOptions(input));
    const items = readMessages(payload).flatMap((message) => {
      const parsed = messageFromCli(message, input.conversation_id);
      return parsed ? [parsed] : [];
    });
    const page = readPage(payload);
    return {
      items,
      has_more: page.has_more,
      ...(page.next_time ? { next_time: page.next_time } : {}),
    };
  }

  async listRecentConversations(
    kinds?: readonly DingTalkChatMode[],
  ): Promise<DingTalkConversation[]> {
    const payload = await runDws(
      ["chat", "+recent-conversations"],
      this.options,
    );
    return this.remember(readConversations(payload, kinds));
  }

  async listAllConversations(
    kinds?: readonly DingTalkChatMode[],
  ): Promise<DingTalkConversation[]> {
    const payload = await runDws(
      ["chat", "+conversation-list", "--page-all"],
      this.options,
    );
    return this.remember(readConversations(payload, kinds));
  }

  describeConversation(conversationId: string): DingTalkConversation | undefined {
    return this.known.get(conversationId);
  }

  async sendText(input: {
    conversation_id: string;
    chat_mode?: DingTalkChatMode;
    peer_user_id?: string;
    text: string;
    idempotency_key?: string;
  }): Promise<DingTalkSendResult> {
    const described = this.describeConversation(input.conversation_id);
    const chatMode = input.chat_mode ?? described?.chat_mode;
    const peerUserId = input.peer_user_id ?? described?.peer_user_id;
    const key = input.idempotency_key?.trim() || randomUUID();
    const args = [
      "chat",
      "+messages-send",
      "--as",
      "user",
      ...(chatMode === "p2p" && peerUserId
        ? ["--user", peerUserId]
        : ["--group", input.conversation_id]),
      "--text",
      input.text,
      "--idempotency-key",
      key,
      "--yes",
    ];
    const payload = await runDws(args, this.options);
    const messageId = findString(payload, ["openMessageId", "messageId", "msgId"]);
    if (messageId) {
      return { message_id: messageId, channel_message_id: messageId };
    }
    return { message_id: findString(payload, ["openTaskId", "taskId"]) ?? key };
  }

  async selfUserId(): Promise<string | undefined> {
    if (this.selfId) {
      return this.selfId;
    }
    try {
      const payload = await runDws(["contact", "user", "get-self"], this.options);
      this.selfId = findString(payload, ["userId", "userid", "openDingTalkId"]);
      return this.selfId;
    } catch {
      return undefined;
    }
  }

  async listUnread(): Promise<DingTalkUnread[]> {
    const payload = await runDws(["chat", "+unread-chats"], this.options);
    return readUnread(payload);
  }

  async markRead(input: { conversation_id: string; message_id?: string }): Promise<void> {
    const messageId = input.message_id?.trim()
      || (await this.listMessages({
        conversation_id: input.conversation_id,
        direction: "older",
        limit: 1,
      })).items.at(-1)?.msg_id;
    if (!messageId) {
      return;
    }
    await runDws(
      [
        "chat",
        "+conversation-mark-read",
        "--conversation-id",
        input.conversation_id,
        "--message-id",
        messageId,
        "--yes",
      ],
      this.options,
    );
  }

  async downloadResource(input: DingTalkDownloadRequest): Promise<DingTalkDownloadedFile> {
    const directory = await mkdtemp(join(tmpdir(), "regenic-dingtalk-dl-"));
    try {
      const args = [
        "chat",
        "+messages-resource-download",
        "--resource-id",
        input.resource_id,
        "--type",
        input.type,
        "--output",
        ".",
      ];
      if (input.type !== "fileId") {
        args.push("--message-id", input.message_id, "--open-conversation-id", input.conversation_id);
      }
      await runDws(args, {
        ...this.runOptions({ timeout_ms: DOWNLOAD_TIMEOUT_MS, signal: input.signal }),
        cwd: directory,
      });
      const file = await firstFile(directory);
      if (!file) {
        throw new DingTalkCliError("dws download wrote no file");
      }
      return {
        bytes: new Uint8Array(await readFile(join(directory, file))),
        filename: basename(file),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private runOptions(input: { timeout_ms?: number; signal?: AbortSignal }): DwsRunOptions {
    return {
      ...this.options,
      ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  private remember(conversations: DingTalkConversation[]): DingTalkConversation[] {
    for (const conversation of conversations) {
      const prev = this.known.get(conversation.conversation_id);
      this.known.set(conversation.conversation_id, {
        conversation_id: conversation.conversation_id,
        name: conversation.name ?? prev?.name,
        chat_mode: conversation.chat_mode ?? prev?.chat_mode,
        ...(conversation.peer_user_id || prev?.peer_user_id
          ? { peer_user_id: conversation.peer_user_id ?? prev?.peer_user_id }
          : {}),
      });
    }
    return conversations;
  }
}

export interface DwsAuthProbe {
  installed: boolean;
  authenticated: boolean;
}

export async function probeDwsAuth(options: DwsRunOptions = {}): Promise<DwsAuthProbe> {
  try {
    const payload = await runDws(["auth", "status"], options);
    return { installed: true, authenticated: authLooksReady(payload) };
  } catch (error) {
    if (isDwsMissing(error)) {
      return { installed: false, authenticated: false };
    }
    return { installed: true, authenticated: false };
  }
}

let shared: DwsCliClient | undefined;
let sharedKey = "";
let runOverride: DwsRunOptions | undefined;

export function setDwsRunOptionsForTests(options?: DwsRunOptions): void {
  runOverride = options;
  shared = undefined;
  sharedKey = "";
}

export function resetDwsClientsForTests(): void {
  shared = undefined;
  sharedKey = "";
  runOverride = undefined;
}

export function dwsClientFor(options: DwsRunOptions = {}): DingTalkImClient {
  const merged: DwsRunOptions = {
    ...options,
    ...runOverride,
    command: runOverride?.command ?? options.command,
    spawn: runOverride?.spawn ?? options.spawn,
    env: { ...options.env, ...runOverride?.env },
  };
  if (merged.spawn) {
    return new DwsCliClient(merged);
  }
  const key = `${merged.command ?? ""}\u0000${merged.env?.REGENIC_DWS_CLI ?? ""}`;
  if (!shared || sharedKey !== key) {
    shared = new DwsCliClient(merged);
    sharedKey = key;
  }
  return shared;
}

function authLooksReady(payload: unknown): boolean {
  const record = asRecord(payload);
  const nested = asRecord(record?.data) ?? record;
  if (!nested) {
    return false;
  }
  if (nested.authenticated === true || nested.loggedIn === true || nested.ready === true) {
    return true;
  }
  const status = stringValue(nested.status)?.toLowerCase();
  if (status === "ok" || status === "ready" || status === "logged_in" || status === "authenticated") {
    return true;
  }
  return Boolean(findString(payload, ["userId", "userid"]));
}

export function messageFromCli(
  raw: unknown,
  fallbackConversationId: string,
): DingTalkInboundMessage | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const messageId = stringValue(record.messageId) ?? stringValue(record.openMessageId) ?? stringValue(record.msgId);
  const conversationId = stringValue(record.conversationId) ?? fallbackConversationId;
  const msgType = stringValue(record.messageType) ?? stringValue(record.msgtype) ?? "text";
  const resources = resourceRefs(record.resourceRefs);
  const text = messageText(record) ?? placeholderText(msgType, resources);
  const createAt = timeToMillis(record.createTime ?? record.createAt);
  if (!messageId || !conversationId || !text || createAt === undefined) {
    return undefined;
  }
  const senderId = stringValue(record.senderId) ?? stringValue(asRecord(record.sender)?.id) ?? stringValue(record.sender);
  if (!senderId) {
    return undefined;
  }
  const senderLabel = stringValue(asRecord(record.sender)?.name)
    ?? (typeof record.sender === "string" && record.sender !== senderId ? stringValue(record.sender) : undefined)
    ?? stringValue(record.senderNick);
  const chatMode = chatModeOf(record.conversationType ?? record.chatType);
  const peer = chatMode === "p2p" ? senderId : undefined;
  return {
    msg_id: messageId,
    conversation_id: conversationId,
    ...(stringValue(record.conversationTitle) ? { conversation_title: stringValue(record.conversationTitle) } : {}),
    ...(chatMode ? { chat_mode: chatMode } : {}),
    create_at: createAt,
    sender_id: senderId,
    ...(senderLabel ? { sender_label: senderLabel } : {}),
    ...(peer ? { peer_user_id: peer } : {}),
    text,
    msg_type: msgType,
    ...(senderType(record) ? { sender_type: senderType(record) } : {}),
    ...(stringValue(record.threadId) ? { thread_id: stringValue(record.threadId) } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  };
}

function resourceRefs(value: unknown): DingTalkResourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const ref = asRecord(entry);
    const id = stringValue(ref?.resourceId)
      ?? stringValue(ref?.mediaId)
      ?? stringValue(ref?.fileId)
      ?? stringValue(ref?.id);
    if (!ref || !id) {
      return [];
    }
    const type = stringValue(ref.type) ?? stringValue(ref.resourceType) ?? stringValue(ref.kind);
    const name = stringValue(ref.fileName) ?? stringValue(ref.name) ?? stringValue(ref.filename);
    return [{
      resource_id: id,
      ...(type ? { type } : {}),
      ...(name ? { name } : {}),
    }];
  });
}

const PLACEHOLDER_BY_TYPE: Record<string, string> = {
  picture: "[image]",
  image: "[image]",
  photo: "[image]",
  video: "[video]",
  audio: "[voice]",
  voice: "[voice]",
  file: "[file]",
};

function placeholderText(msgType: string, resources: DingTalkResourceRef[]): string | undefined {
  const named = resources.find((ref) => ref.name)?.name;
  const label = PLACEHOLDER_BY_TYPE[msgType.toLowerCase()]
    ?? (resources.length > 0 ? PLACEHOLDER_BY_TYPE[resources[0]?.type?.toLowerCase() ?? ""] ?? "[attachment]" : undefined);
  if (!label) {
    return undefined;
  }
  return named ? `${label} ${named}` : label;
}

function messageText(record: Record<string, unknown>): string | undefined {
  const direct = stringValue(record.text) ?? stringValue(record.content);
  if (direct) {
    return direct;
  }
  const text = asRecord(record.text);
  return stringValue(text?.content);
}

function senderType(record: Record<string, unknown>): string | undefined {
  return stringValue(record.senderType) ?? stringValue(asRecord(record.sender)?.sender_type);
}

function readMessages(payload: unknown): unknown[] {
  const record = asRecord(payload);
  const nested = asRecord(record?.data) ?? asRecord(record?.result) ?? record;
  const messages = nested?.messages ?? nested?.items;
  return Array.isArray(messages) ? messages : [];
}

function readPage(payload: unknown): { has_more: boolean; next_time?: string } {
  const record = asRecord(payload);
  const nested = asRecord(record?.data) ?? asRecord(record?.result) ?? record;
  const hasMore = nested?.hasMore === true || nested?.has_more === true;
  const nextPage = nested?.nextPage;
  const next = stringValue(asRecord(nextPage)?.time) ?? stringValue(nextPage);
  return {
    has_more: hasMore,
    ...(next ? { next_time: next } : {}),
  };
}

function readConversations(
  payload: unknown,
  kinds?: readonly DingTalkChatMode[],
): DingTalkConversation[] {
  const records = collectRecords(payload, ["conversations", "items", "chats", "groups"]);
  return records.flatMap((record) => {
    const conversationId = stringValue(record.openConversationId)
      ?? stringValue(record.conversationId)
      ?? stringValue(record.chatId);
    if (!conversationId) {
      return [];
    }
    const chatMode = chatModeOf(record.conversationType ?? record.chatType ?? record.type ?? record.kind);
    if (kinds && chatMode && !kinds.includes(chatMode)) {
      return [];
    }
    const name = stringValue(record.title) ?? stringValue(record.name) ?? stringValue(record.conversationTitle);
    const peer = stringValue(record.peerUserId)
      ?? stringValue(record.peerId)
      ?? stringValue(record.targetUserId)
      ?? stringValue(record.userId);
    return [{
      conversation_id: conversationId,
      ...(name ? { name } : {}),
      ...(chatMode ? { chat_mode: chatMode } : {}),
      ...(chatMode === "p2p" && peer ? { peer_user_id: peer } : {}),
    }];
  });
}

function readUnread(payload: unknown): DingTalkUnread[] {
  return collectRecords(payload, ["conversations", "items", "chats", "unread"]).flatMap((record) => {
    const conversationId = stringValue(record.openConversationId)
      ?? stringValue(record.conversationId);
    if (!conversationId) {
      return [];
    }
    const count = numberValue(record.unreadCount ?? record.unread_count ?? record.count);
    return [{
      conversation_id: conversationId,
      ...(count !== undefined ? { unread_count: count } : {}),
      ...(record.mentioned === true || record.atMe === true ? { mentioned: true } : {}),
    }];
  });
}

function collectRecords(payload: unknown, keys: string[]): Record<string, unknown>[] {
  const record = asRecord(payload);
  const nested = asRecord(record?.data) ?? asRecord(record?.result) ?? record;
  if (!nested) {
    return [];
  }
  for (const key of keys) {
    const value = nested[key];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const item = asRecord(entry);
        return item ? [item] : [];
      });
    }
  }
  return [];
}

function chatModeOf(value: unknown): DingTalkChatMode | undefined {
  const raw = stringValue(value)?.toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (raw === "1" || raw === "p2p" || raw === "direct" || raw === "single" || raw === "dm") {
    return "p2p";
  }
  if (raw === "2" || raw === "group" || raw === "chat") {
    return "group";
  }
  return undefined;
}

export function timeToMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return timeToMillis(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function millisToIso(value: number): string {
  return new Date(value).toISOString();
}

function findString(payload: unknown, keys: string[]): string | undefined {
  const found = walk(payload, keys, 0);
  return found;
}

function walk(payload: unknown, keys: string[], depth: number): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  for (const value of Object.values(record)) {
    const nested = walk(value, keys, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
