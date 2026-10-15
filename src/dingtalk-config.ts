import {
  ChannelDriverError,
  DEFAULT_SYNC_MODE,
  parseSyncMode,
  type JsonValue,
} from "@regenic/connector-contract";
import type { DingTalkChatMode } from "./dingtalk-message";

const WRITE_BACK_GROUPS = [
  ["同意", "通过", "批准", "Approve", "approve", "Yes", "yes"],
  ["拒绝", "驳回", "不通过", "Reject", "reject", "No", "no"],
] as const;

export function dingtalkWriteBackLabels(label: string): string[] {
  const trimmed = label.trim();
  if (!trimmed) {
    return [];
  }
  const folded = trimmed.toLowerCase();
  const group = WRITE_BACK_GROUPS.find((aliases) =>
    aliases.some((alias) => alias.toLowerCase() === folded),
  );
  return [...new Set([trimmed, ...(group ? [...group] : [])])];
}

export function dingtalkSelection(
  config: Record<string, unknown>,
): "all" | "pick" | "recent" {
  const selection = configString(config, "selection");
  if (selection === "all" || selection === "pick" || selection === "recent") {
    return selection;
  }
  return dingtalkPickedConversationIds(config).length > 0 ? "pick" : "recent";
}

export function dingtalkStreamDiscover(
  selection: ReturnType<typeof dingtalkSelection>,
  discoverRequested: boolean,
): "known" | "recent" | "full" {
  if (selection === "pick") {
    return "known";
  }
  if (!discoverRequested) {
    return "known";
  }
  return selection === "all" ? "full" : "recent";
}

export function dingtalkPickedConversationIds(config: Record<string, unknown>): string[] {
  const fromList = configStringList(config, "conversation_ids");
  if (fromList.length > 0) {
    return fromList;
  }
  const single = configString(config, "conversation_id");
  return single ? [single] : [];
}

export function dingtalkKinds(config: Record<string, unknown>): DingTalkChatMode[] {
  const raw = configStringList(config, "kinds");
  if (raw.length === 0) {
    return ["group", "p2p"];
  }
  return (["group", "p2p"] as const).filter((kind) => raw.includes(kind));
}

export function dingtalkInstallConfig(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const syncMode = parseSyncMode(input.sync_mode) ?? DEFAULT_SYNC_MODE;
  const base: Record<string, JsonValue> = {
    sync_mode: syncMode,
  };
  const rawSelection = configString(input, "selection") ?? "";
  const selection =
    rawSelection.length > 0
      ? dingtalkSelection(input)
      : dingtalkPickedConversationIds(input).length > 0
        ? "pick"
        : "recent";
  if (selection === "pick") {
    const conversationIds = dingtalkPickedConversationIds(input);
    if (conversationIds.length === 0) {
      throw new ChannelDriverError(
        "invalid_config",
        "DingTalk install requires at least one conversation when choosing conversations",
        "conversation_required",
      );
    }
    const names = pickedNames(input, conversationIds);
    return {
      ...base,
      selection: "pick",
      conversation_ids: conversationIds,
      ...(names.length === conversationIds.length ? { conversation_names: names } : {}),
    };
  }
  const kinds = dingtalkKinds(input);
  if (kinds.length === 0) {
    throw new ChannelDriverError(
      "invalid_config",
      "DingTalk install requires groups, direct messages, or both",
      "kinds_required",
    );
  }
  return {
    ...base,
    selection,
    kinds,
  };
}

export function dingtalkRecentLabel(config: Record<string, unknown>): string {
  return kindLabel(config, "present.recentConversations", "present.recentDirect", "present.recentGroups");
}

export function dingtalkAllLabel(config: Record<string, unknown>): string {
  return kindLabel(config, "present.allConversations", "present.allDirect", "present.allGroups");
}

export function pickedConversationNames(
  config: Record<string, unknown>,
  conversationIds: string[],
): string[] {
  return pickedNames(config, conversationIds);
}

export function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function configStringList(
  config: Record<string, unknown>,
  name: string,
): string[] {
  const value = config[name];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
    );
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function pickedNames(
  config: Record<string, unknown>,
  conversationIds: string[],
): string[] {
  const names = configStringList(config, "conversation_names");
  if (names.length === conversationIds.length) {
    return names;
  }
  const single = configString(config, "conversation_name");
  return single && conversationIds.length === 1 ? [single] : [];
}

function kindLabel(
  config: Record<string, unknown>,
  both: string,
  direct: string,
  groups: string,
): string {
  const kinds = dingtalkKinds(config);
  const hasGroups = kinds.includes("group");
  const hasDirect = kinds.includes("p2p");
  if (hasGroups && hasDirect) {
    return both;
  }
  if (hasDirect) {
    return direct;
  }
  return groups;
}
