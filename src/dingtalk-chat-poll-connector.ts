import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ContentPart,
  type ConnectorCursor,
  type ConnectorPollOptions,
  type IngestBatch,
  type PollResult,
  type SyncPollHint,
} from "@regenic/connector-contract";
import type { DingTalkHistoryRequest, DingTalkImClient } from "./dingtalk-client";
import {
  DINGTALK_SOURCE,
  dingtalkConversationKind,
  type DingTalkChatMode,
  type DingTalkInboundMessage,
} from "./dingtalk-message";
import {
  MAX_DINGTALK_MEDIA_ATTEMPTS,
  MAX_DINGTALK_MEDIA_JOBS_PER_POLL,
  dingtalkDownloadType,
  downloadedAttachment,
  enqueueMediaJobs,
  isDueMediaJob,
  loadDingTalkMediaJobs,
  mediaRetryBackoffMs,
  pointerAttachment,
  saveDingTalkMediaJobs,
  type DingTalkMediaJob,
} from "./dingtalk-media";

export interface DingTalkChatPollConnectorOptions {
  connector_id: string;
  org_id: string;
  conversation_id: string;
  conversation_name?: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
  now?: () => string;
}

/**
 * dws pages by time boundary only, so each edge keeps the ids already seen at
 * its exact millisecond. That lets an inclusive boundary re-read drop them.
 */
interface CursorState {
  head_ms?: number;
  head_ids?: string[];
  tail_ms?: number;
  tail_ids?: string[];
  live_seeded?: boolean;
  history_done?: boolean;
}

interface Edge {
  ms: number;
  ids: string[];
}

interface PollContext {
  wantMedia: boolean;
  signal?: AbortSignal;
}

const INTERACTIVE_TIMEOUT_MS = 8_000;
const OLDER_HOPS = 3;

export class DingTalkChatPollConnector {
  readonly source = DINGTALK_SOURCE;
  private readonly now: () => string;
  private conversationName: string | undefined;
  private chatMode: DingTalkChatMode | undefined;
  private peerUserId: string | undefined;
  private selfId: string | undefined;

  constructor(
    private readonly client: DingTalkImClient,
    private readonly options: DingTalkChatPollConnectorOptions,
  ) {
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
    const state = decodeCursor(cursor?.value);
    const ctx: PollContext = {
      wantMedia: options?.media !== false,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    if (options?.media === true) {
      return this.page(ctx, cursor?.value, state, "media", []);
    }
    const described = this.client.describeConversation(this.options.conversation_id);
    if (described) {
      this.rememberConversation(described);
    }
    if (!this.selfId) {
      this.selfId = await this.client.selfUserId();
    }
    if (options?.older === true) {
      const anchor = anchorEdge(options);
      return anchor
        ? this.pollAnchored(cursor?.value, state, anchor, ctx)
        : this.pollOlder(cursor?.value, state, ctx);
    }
    if (!state.live_seeded) {
      return this.pollSeed(cursor?.value, state, ctx);
    }
    if (options?.latest === true || state.head_ms === undefined) {
      return this.pollLatest(cursor?.value, state, ctx);
    }
    return this.pollLive(cursor?.value, state, ctx);
  }

  private async pollSeed(
    previous: string | undefined,
    state: CursorState,
    ctx: PollContext,
  ): Promise<PollResult> {
    const page = await this.list({ direction: "older", signal: ctx.signal });
    const items = chronological(page.items);
    const next: CursorState = {
      ...state,
      live_seeded: true,
      history_done: !page.has_more,
      ...edgeState("head", newestEdge(items)),
      ...edgeState("tail", oldestEdge(items)),
    };
    return this.page(ctx, previous, next, "live", items, page.has_more);
  }

  /** Newest page for the thread the user just opened. History stays where it was. */
  private async pollLatest(
    previous: string | undefined,
    state: CursorState,
    ctx: PollContext,
  ): Promise<PollResult> {
    const page = await this.list({
      direction: "older",
      timeout_ms: INTERACTIVE_TIMEOUT_MS,
      signal: ctx.signal,
    });
    const items = chronological(page.items);
    const next: CursorState = {
      ...state,
      ...edgeState("head", laterEdge(headOf(state), newestEdge(items))),
      ...(state.tail_ms === undefined ? edgeState("tail", oldestEdge(items)) : {}),
    };
    return this.page(ctx, previous, next, "latest", items, false);
  }

  private async pollLive(
    previous: string | undefined,
    state: CursorState,
    ctx: PollContext,
  ): Promise<PollResult> {
    const head = headOf(state);
    const page = await this.list({
      direction: "newer",
      ...(head ? { time: secondIso(head.ms, "floor") } : {}),
      signal: ctx.signal,
    });
    const items = chronological(page.items).filter((message) => !head || afterEdge(message, head));
    const next: CursorState = {
      ...state,
      live_seeded: true,
      ...edgeState("head", laterEdge(head, newestEdge(items))),
    };
    return this.page(ctx, previous, next, "live", items, page.has_more && items.length > 0);
  }

  private async pollOlder(
    previous: string | undefined,
    state: CursorState,
    ctx: PollContext,
  ): Promise<PollResult> {
    const tail = tailOf(state);
    if (state.history_done || !tail) {
      return this.page(ctx, previous, { ...state, history_done: true }, "older", []);
    }
    const page = await this.walkOlder(tail, ctx.signal);
    const next: CursorState = {
      ...state,
      history_done: !page.has_more,
      ...edgeState("tail", earlierEdge(tail, oldestEdge(page.items))),
    };
    return this.page(ctx, previous, next, "older", page.items, page.has_more);
  }

  /** One scroll before what is on screen. The stored history walk stays put. */
  private async pollAnchored(
    previous: string | undefined,
    state: CursorState,
    anchor: Edge,
    ctx: PollContext,
  ): Promise<PollResult> {
    const page = await this.walkOlder(anchor, ctx.signal, INTERACTIVE_TIMEOUT_MS);
    const next: CursorState = page.has_more ? state : { ...state, history_done: true };
    return this.page(ctx, previous, next, `older:${anchor.ms}`, page.items, page.has_more, {
      live_seeded: state.live_seeded === true,
      history_pending: page.has_more,
    });
  }

  private async walkOlder(
    boundary: Edge,
    signal: AbortSignal | undefined,
    timeoutMs?: number,
  ): Promise<{ items: DingTalkInboundMessage[]; has_more: boolean }> {
    let time = secondIso(boundary.ms, "ceil");
    for (let hop = 0; hop < OLDER_HOPS; hop += 1) {
      const page = await this.list({
        direction: "older",
        time,
        signal,
        ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
      });
      const items = chronological(page.items).filter((message) => beforeEdge(message, boundary));
      const nextTime = page.next_time ?? oldestRawTime(page.items);
      if (items.length > 0 || !page.has_more || !nextTime || nextTime === time) {
        return { items, has_more: page.has_more };
      }
      time = nextTime;
    }
    return { items: [], has_more: true };
  }

  private list(
    input: Omit<DingTalkHistoryRequest, "conversation_id" | "chat_mode" | "peer_user_id">,
  ) {
    return this.client.listMessages({
      conversation_id: this.options.conversation_id,
      ...(this.chatMode ? { chat_mode: this.chatMode } : {}),
      ...(this.peerUserId ? { peer_user_id: this.peerUserId } : {}),
      ...input,
    });
  }

  private async page(
    ctx: PollContext,
    previous: string | undefined,
    state: CursorState,
    lane: string,
    messages: DingTalkInboundMessage[],
    hasMore = false,
    hint: SyncPollHint = dingtalkPollHint(state),
  ): Promise<PollResult> {
    const canDownload = typeof this.client.downloadResource === "function";
    const queued = canDownload
      ? enqueueMediaJobs(
          loadDingTalkMediaJobs(this.options.connector_id, this.options.conversation_id),
          messages,
        )
      : [];
    const drained = ctx.wantMedia && queued.length > 0
      ? await this.drainMediaJobs(queued, ctx)
      : { records: [], jobs: queued };
    if (canDownload) {
      saveDingTalkMediaJobs(this.options.connector_id, this.options.conversation_id, drained.jobs);
    }
    const nextCursor = encodeCursor(state);
    const revised = drained.records.map((record) => record.external_id);
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: deliveryId(
        this.options.conversation_id,
        revised.length > 0 ? `${lane}:media:${revised.join(",")}` : lane,
        previous,
        nextCursor,
      ),
      received_at: this.now(),
      next_cursor: nextCursor,
      records: [
        ...messages.map((message) => this.toRecord(message)),
        ...drained.records,
      ],
    };
    return {
      batch,
      next_cursor: nextCursor,
      has_more: hasMore,
      media_pending: drained.jobs.length > 0,
      poll_hint: hint,
    };
  }

  /** Download queued attachments and revise their messages with the bytes. */
  private async drainMediaJobs(
    jobs: DingTalkMediaJob[],
    ctx: PollContext,
  ): Promise<{ records: IngestBatch["records"]; jobs: DingTalkMediaJob[] }> {
    const nowMs = this.clockMs();
    const due = new Set(
      jobs.filter((job) => isDueMediaJob(job, nowMs))
        .slice(0, MAX_DINGTALK_MEDIA_JOBS_PER_POLL)
        .map((job) => job.message.msg_id),
    );
    const records: IngestBatch["records"] = [];
    const remaining: DingTalkMediaJob[] = [];
    for (const job of jobs) {
      if (!due.has(job.message.msg_id)) {
        remaining.push(job);
        continue;
      }
      const parts = await this.downloadMessage(job.message, ctx);
      const complete = parts.every((part) => part.bytes);
      const attempts = job.attempts + 1;
      if (complete || attempts >= MAX_DINGTALK_MEDIA_ATTEMPTS) {
        if (parts.some((part) => part.bytes)) {
          records.push(this.toRecord(job.message, parts, "revise"));
        }
        continue;
      }
      remaining.push({ ...job, attempts, retry_after: nowMs + mediaRetryBackoffMs(attempts) });
    }
    return { records, jobs: remaining };
  }

  private async downloadMessage(
    message: DingTalkInboundMessage,
    ctx: PollContext,
  ): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];
    for (const ref of message.resources ?? []) {
      let part: ContentPart | undefined;
      try {
        const file = await this.client.downloadResource!({
          conversation_id: this.options.conversation_id,
          message_id: message.msg_id,
          resource_id: ref.resource_id,
          type: dingtalkDownloadType(ref, message.msg_type),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        part = downloadedAttachment(ref, message.msg_type, file);
      } catch (error) {
        if (ctx.signal?.aborted) {
          throw error;
        }
      }
      parts.push(part ?? pointerAttachment(ref, message.msg_type));
    }
    return parts;
  }

  private clockMs(): number {
    const parsed = Date.parse(this.now());
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  private toRecord(
    message: DingTalkInboundMessage,
    attachments: ContentPart[] = (message.resources ?? []).map((ref) => pointerAttachment(ref, message.msg_type)),
    operation: "create" | "revise" = "create",
  ): IngestBatch["records"][number] {
    const self = this.selfId && message.sender_id === this.selfId;
    const assistant = message.sender_type === "bot" || message.sender_type === "app";
    const chatMode = message.chat_mode ?? this.chatMode;
    const conversationKind = dingtalkConversationKind(chatMode);
    return {
      ...channelRecord({
        channel: DINGTALK_SOURCE,
        kind: assistant ? "assistant" : "user",
        direction: self ? "outbound" : "inbound",
        external_id: message.msg_id,
        occurred_at: new Date(message.create_at).toISOString(),
        actor_id: message.sender_id,
        ...(message.sender_label ? { actor_label: message.sender_label } : {}),
        scope_id: this.options.conversation_id,
        scope_name: message.conversation_title ?? this.conversationName,
        ...(conversationKind ? { conversation_kind: conversationKind } : {}),
        ...(message.thread_id ? { thread_id: message.thread_id } : {}),
        text: message.text,
        ...(attachments.length > 0 ? { content: attachments } : {}),
      }),
      operation,
    };
  }
}

export function dingtalkPollHint(state: CursorState): SyncPollHint {
  return {
    live_seeded: state.live_seeded === true,
    history_pending: state.live_seeded === true && state.history_done !== true,
  };
}

function anchorEdge(options: ConnectorPollOptions): Edge | undefined {
  const ms = options.before ? Date.parse(options.before) : Number.NaN;
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  const id = options.before_external_id?.trim();
  return { ms, ids: id ? [id] : [] };
}

function headOf(state: CursorState): Edge | undefined {
  return state.head_ms === undefined ? undefined : { ms: state.head_ms, ids: state.head_ids ?? [] };
}

function tailOf(state: CursorState): Edge | undefined {
  return state.tail_ms === undefined ? undefined : { ms: state.tail_ms, ids: state.tail_ids ?? [] };
}

function edgeState(side: "head" | "tail", edge: Edge | undefined): CursorState {
  if (!edge) {
    return {};
  }
  return side === "head"
    ? { head_ms: edge.ms, head_ids: edge.ids }
    : { tail_ms: edge.ms, tail_ids: edge.ids };
}

function newestEdge(items: DingTalkInboundMessage[]): Edge | undefined {
  const newest = items.at(-1);
  return newest ? edgeAt(items, newest.create_at) : undefined;
}

function oldestEdge(items: DingTalkInboundMessage[]): Edge | undefined {
  const oldest = items[0];
  return oldest ? edgeAt(items, oldest.create_at) : undefined;
}

function edgeAt(items: DingTalkInboundMessage[], ms: number): Edge {
  return { ms, ids: items.filter((item) => item.create_at === ms).map((item) => item.msg_id) };
}

function laterEdge(current: Edge | undefined, next: Edge | undefined): Edge | undefined {
  if (!current || !next) {
    return next ?? current;
  }
  if (next.ms > current.ms) {
    return next;
  }
  if (next.ms === current.ms) {
    return { ms: current.ms, ids: [...new Set([...current.ids, ...next.ids])] };
  }
  return current;
}

function earlierEdge(current: Edge | undefined, next: Edge | undefined): Edge | undefined {
  if (!current || !next) {
    return next ?? current;
  }
  if (next.ms < current.ms) {
    return next;
  }
  if (next.ms === current.ms) {
    return { ms: current.ms, ids: [...new Set([...current.ids, ...next.ids])] };
  }
  return current;
}

function afterEdge(message: DingTalkInboundMessage, edge: Edge): boolean {
  return message.create_at > edge.ms || (message.create_at === edge.ms && !edge.ids.includes(message.msg_id));
}

function beforeEdge(message: DingTalkInboundMessage, edge: Edge): boolean {
  return message.create_at < edge.ms || (message.create_at === edge.ms && !edge.ids.includes(message.msg_id));
}

function oldestRawTime(items: DingTalkInboundMessage[]): string | undefined {
  const oldest = chronological(items)[0];
  return oldest ? secondIso(oldest.create_at, "ceil") : undefined;
}

/** dws time flags take whole seconds; round outward so the boundary row is re-read, then filtered. */
export function secondIso(ms: number, mode: "floor" | "ceil"): string {
  const seconds = mode === "floor" ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function chronological(items: DingTalkInboundMessage[]): DingTalkInboundMessage[] {
  return [...items].sort((left, right) => left.create_at - right.create_at || left.msg_id.localeCompare(right.msg_id));
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}

function decodeCursor(value: string | undefined): CursorState {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as CursorState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function deliveryId(
  conversationId: string,
  lane: string,
  previous: string | undefined,
  nextCursor: string,
): string {
  const hash = createHash("sha256")
    .update([conversationId, lane, previous ?? "initial", nextCursor].join("\u0000"))
    .digest("hex");
  return `dingtalk:${conversationId}:${hash}`;
}
