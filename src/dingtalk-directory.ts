import type { ConversationThread, SyncCatalogMember } from "@regenic/connector-contract";
import type { DingTalkImClient } from "./dingtalk-client";
import {
  dingtalkKinds,
  dingtalkPickedConversationIds,
  dingtalkSelection,
  pickedConversationNames,
} from "./dingtalk-config";
import {
  DINGTALK_SOURCE,
  type DingTalkChatMode,
  type DingTalkConversation,
} from "./dingtalk-message";
import {
  DINGTALK_RECENT_LIMIT,
  dingtalkConversationIdFromStreamKey,
} from "./dingtalk-streams";

export type DingTalkDiscover = "known" | "recent" | "full";

export async function resolveDingTalkConversationTargets(
  config: Record<string, unknown>,
  client: DingTalkImClient,
  options: {
    known?: DingTalkConversation[];
    discover?: DingTalkDiscover;
  } = {},
): Promise<DingTalkConversation[]> {
  if (dingtalkSelection(config) === "pick") {
    return fillPickedConversations(config, client);
  }
  const kinds = dingtalkKinds(config);
  const known = (options.known ?? []).filter((conversation) =>
    matchesKinds(conversation, kinds),
  );
  const discover = options.discover ?? "recent";
  if (discover === "known") {
    return known;
  }
  const listed = discover === "full"
    ? await client.listAllConversations(kinds)
    : await client.listRecentConversations(kinds);
  const capped = discover === "recent" ? listed.slice(0, DINGTALK_RECENT_LIMIT) : listed;
  return mergeConversations(known, capped);
}

export function dingtalkConversationsFromThreads(
  threads: readonly ConversationThread[],
  sourceMatches: (thread: ConversationThread) => boolean,
): DingTalkConversation[] {
  return threads.flatMap((thread) => {
    if (thread.source !== DINGTALK_SOURCE || !sourceMatches(thread)) {
      return [];
    }
    return [{ conversation_id: thread.target }];
  });
}

export function dingtalkConversationsFromCatalog(
  members: readonly SyncCatalogMember[],
): DingTalkConversation[] {
  return members.flatMap((member) => {
    const conversationId =
      dingtalkConversationIdFromStreamKey(member.stream_key) ??
      (member.thread_id?.startsWith(`${DINGTALK_SOURCE}:`)
        ? member.thread_id.slice(DINGTALK_SOURCE.length + 1)
        : undefined);
    if (!conversationId) {
      return [];
    }
    const name = member.label?.replace(/\s+/g, " ").trim();
    const kind =
      member.kind === "group" || member.kind === "p2p" ? member.kind : undefined;
    return [
      {
        conversation_id: conversationId,
        ...(name ? { name } : {}),
        ...(kind ? { chat_mode: kind } : {}),
      },
    ];
  });
}

async function fillPickedConversations(
  config: Record<string, unknown>,
  client: DingTalkImClient,
): Promise<DingTalkConversation[]> {
  const ids = dingtalkPickedConversationIds(config);
  const names = pickedConversationNames(config, ids);
  const cached = ids.map((conversationId) => client.describeConversation(conversationId));
  const needsDirectory = cached.some(
    (conversation) =>
      !conversation?.chat_mode ||
      (conversation.chat_mode === "p2p" && !conversation.peer_user_id),
  );
  const directory = needsDirectory ? await client.listAllConversations() : [];
  const listed = new Map(
    directory.map((conversation) => [conversation.conversation_id, conversation]),
  );

  return ids.map((conversationId, index) => {
    const listedConversation = listed.get(conversationId);
    const described = mergeConversations(
      cached[index] ? [cached[index]!] : [],
      listedConversation ? [listedConversation] : [],
    )[0];
    if (
      !described?.chat_mode ||
      (described.chat_mode === "p2p" && !described.peer_user_id)
    ) {
      throw new Error(
        `Unable to resolve routing details for selected DingTalk conversation "${conversationId}"`,
      );
    }
    const name = names[index] || described?.name;
    return {
      conversation_id: conversationId,
      ...(name ? { name } : {}),
      chat_mode: described.chat_mode,
      ...(described.peer_user_id ? { peer_user_id: described.peer_user_id } : {}),
    };
  });
}

function matchesKinds(
  conversation: DingTalkConversation,
  kinds: readonly DingTalkChatMode[],
): boolean {
  return !conversation.chat_mode || kinds.includes(conversation.chat_mode);
}

function mergeConversations(
  known: readonly DingTalkConversation[],
  extra: readonly DingTalkConversation[],
): DingTalkConversation[] {
  const byId = new Map<string, DingTalkConversation>();
  for (const conversation of [...known, ...extra]) {
    const conversationId = conversation.conversation_id.trim();
    if (!conversationId) {
      continue;
    }
    const prev = byId.get(conversationId);
    const name = conversation.name?.replace(/\s+/g, " ").trim() || prev?.name;
    byId.set(conversationId, {
      conversation_id: conversationId,
      ...(name ? { name } : {}),
      chat_mode: conversation.chat_mode ?? prev?.chat_mode,
      ...(conversation.peer_user_id || prev?.peer_user_id
        ? { peer_user_id: conversation.peer_user_id ?? prev?.peer_user_id }
        : {}),
    });
  }
  return [...byId.values()];
}
