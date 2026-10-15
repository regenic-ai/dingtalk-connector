import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { ContentPart } from "@regenic/connector-contract";
import type { DingTalkInboundMessage, DingTalkResourceRef } from "./dingtalk-message";

export const MAX_DINGTALK_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DINGTALK_MEDIA_JOBS = 40;
export const MAX_DINGTALK_MEDIA_ATTEMPTS = 5;
export const MAX_DINGTALK_MEDIA_JOBS_PER_POLL = 8;

/** One message whose attachments still need bytes. */
export interface DingTalkMediaJob {
  message: DingTalkInboundMessage;
  attempts: number;
  retry_after?: number;
}

export type DingTalkDownloadType = "mediaId" | "fileId" | "image" | "file";

export interface DingTalkDownloadedFile {
  bytes: Uint8Array;
  filename?: string;
}

export function dingtalkDownloadType(
  ref: DingTalkResourceRef,
  msgType: string,
): DingTalkDownloadType {
  const type = ref.type?.toLowerCase();
  if (type === "fileid") {
    return "fileId";
  }
  if (type === "mediaid") {
    return "mediaId";
  }
  if (isImage(type) || isImage(msgType.toLowerCase())) {
    return "image";
  }
  if (type === "file" || msgType.toLowerCase() === "file") {
    return "file";
  }
  return "mediaId";
}

export function dingtalkMediaLocator(ref: DingTalkResourceRef): string {
  return `dingtalk:${ref.type ?? "resource"}:${ref.resource_id}`;
}

export function pointerAttachment(ref: DingTalkResourceRef, msgType: string): ContentPart {
  const filename = ref.name ?? defaultFilename(ref, msgType);
  return {
    role: "attachment",
    media_type: mediaTypeFromName(filename) ?? fallbackMediaType(ref, msgType),
    source_filename: filename,
    external_locator: dingtalkMediaLocator(ref),
  };
}

export function downloadedAttachment(
  ref: DingTalkResourceRef,
  msgType: string,
  file: DingTalkDownloadedFile,
): ContentPart | undefined {
  if (
    file.bytes.byteLength === 0 ||
    file.bytes.byteLength > MAX_DINGTALK_ATTACHMENT_BYTES ||
    looksLikeJson(file.bytes)
  ) {
    return undefined;
  }
  const filename = ref.name ?? file.filename ?? defaultFilename(ref, msgType);
  return {
    role: "attachment",
    media_type: sniffMediaType(
      file.bytes,
      mediaTypeFromName(filename) ?? fallbackMediaType(ref, msgType),
    ),
    source_filename: filename,
    external_locator: dingtalkMediaLocator(ref),
    bytes: file.bytes,
  };
}

export function isDueMediaJob(job: DingTalkMediaJob, nowMs: number): boolean {
  return job.attempts < MAX_DINGTALK_MEDIA_ATTEMPTS && (job.retry_after ?? 0) <= nowMs;
}

export function mediaRetryBackoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 4 ** Math.max(0, attempts - 1));
}

export function enqueueMediaJobs(
  current: DingTalkMediaJob[],
  messages: readonly DingTalkInboundMessage[],
): DingTalkMediaJob[] {
  const jobs = [...current];
  const seen = new Set(jobs.map((job) => job.message.msg_id));
  for (const message of messages) {
    if (!message.resources?.length || seen.has(message.msg_id)) {
      continue;
    }
    seen.add(message.msg_id);
    jobs.push({ message, attempts: 0 });
  }
  return jobs.slice(-MAX_DINGTALK_MEDIA_JOBS);
}

export function sniffMediaType(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "%PDF") {
    return "application/pdf";
  }
  return fallback;
}

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".amr": "audio/amr",
  ".m4a": "audio/mp4",
};

function mediaTypeFromName(filename: string): string | undefined {
  return MEDIA_TYPE_BY_EXT[extname(filename).toLowerCase()];
}

function fallbackMediaType(ref: DingTalkResourceRef, msgType: string): string {
  const type = ref.type?.toLowerCase();
  if (isImage(type) || isImage(msgType.toLowerCase())) {
    return "image/png";
  }
  if (msgType === "video") {
    return "video/mp4";
  }
  if (msgType === "audio" || msgType === "voice") {
    return "audio/amr";
  }
  return "application/octet-stream";
}

function defaultFilename(ref: DingTalkResourceRef, msgType: string): string {
  return isImage(ref.type?.toLowerCase()) || isImage(msgType.toLowerCase()) ? "image.png" : "attachment";
}

function isImage(type: string | undefined): boolean {
  return type === "image" || type === "picture" || type === "photo";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** dws error envelopes land on disk as JSON when a resource cannot be fetched. */
function looksLikeJson(bytes: Uint8Array): boolean {
  let index = 0;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x0a || bytes[index] === 0x0d || bytes[index] === 0x09)) {
    index += 1;
  }
  if (bytes[index] !== 0x7b) {
    return false;
  }
  try {
    JSON.parse(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Durable attachment queues. Kept off the sync cursor so stream state stays
 * small, but they survive a restart.
 */
const memory = new Map<string, DingTalkMediaJob[]>();
let rootOverride: string | undefined;

export function setDingTalkMediaJobsRootForTests(root?: string): void {
  rootOverride = root?.trim() || undefined;
  memory.clear();
}

export function clearDingTalkMediaJobsForTests(): void {
  memory.clear();
  if (rootOverride) {
    rmSync(rootOverride, { recursive: true, force: true });
  }
}

export function loadDingTalkMediaJobs(connectorId: string, conversationId: string): DingTalkMediaJob[] {
  const key = storeKey(connectorId, conversationId);
  const cached = memory.get(key);
  if (cached) {
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath(connectorId, conversationId), "utf8")) as unknown;
    const jobs = Array.isArray(parsed) ? parsed.filter(isMediaJob) : [];
    if (jobs.length > 0) {
      memory.set(key, jobs);
    }
    return jobs;
  } catch {
    return [];
  }
}

export function saveDingTalkMediaJobs(
  connectorId: string,
  conversationId: string,
  jobs: DingTalkMediaJob[],
): void {
  const key = storeKey(connectorId, conversationId);
  const path = filePath(connectorId, conversationId);
  if (jobs.length === 0) {
    if (memory.delete(key)) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
    return;
  }
  memory.set(key, jobs);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(jobs));
  } catch {
    // The in-memory queue still drains in this process.
  }
}

function storeKey(connectorId: string, conversationId: string): string {
  return `${connectorId}\u0000${conversationId}`;
}

function resolveRoot(): string {
  if (rootOverride) {
    return rootOverride;
  }
  const env = process.env.REGENIC_DINGTALK_MEDIA_JOBS_DIR?.trim();
  if (env) {
    return env;
  }
  const home = process.env.REGENIC_HOME?.trim() || join(homedir(), ".regenic");
  return join(home, "dingtalk-media-jobs");
}

function filePath(connectorId: string, conversationId: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "x";
  return join(resolveRoot(), safe(connectorId), `${safe(conversationId)}.json`);
}

function isMediaJob(value: unknown): value is DingTalkMediaJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const job = value as Record<string, unknown>;
  const message = job.message as Record<string, unknown> | undefined;
  return (
    typeof job.attempts === "number" &&
    !!message &&
    typeof message.msg_id === "string" &&
    typeof message.sender_id === "string" &&
    typeof message.create_at === "number" &&
    Array.isArray(message.resources)
  );
}
