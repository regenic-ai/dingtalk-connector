import type { SyncDirectoryPage, SyncSource } from "@regenic/connector-contract";
import type { DingTalkImClient } from "./dingtalk-client";
import { DINGTALK_SOURCE, type DingTalkChatMode, type DingTalkConversation } from "./dingtalk-message";
import { DINGTALK_RECENT_LIMIT, dingtalkStreamKey } from "./dingtalk-streams";

export function createDingTalkPickedSyncSource(
  conversations: readonly DingTalkConversation[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      return {
        members: conversations.flatMap((conversation) => memberOf(conversation)),
        complete: true,
        replaces: true,
      };
    },
  };
}

export function createDingTalkRecentSyncSource(
  client: DingTalkImClient,
  kinds: readonly DingTalkChatMode[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      const conversations = await client.listRecentConversations(kinds);
      return {
        members: conversations.slice(0, DINGTALK_RECENT_LIMIT).flatMap((conversation) =>
          memberOf(conversation),
        ),
        complete: true,
      };
    },
  };
}

export function createDingTalkSyncSource(
  client: DingTalkImClient,
  kinds: readonly DingTalkChatMode[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      const conversations = await client.listRecentConversations(kinds);
      return {
        members: conversations.flatMap((conversation) => memberOf(conversation)),
        complete: true,
        replaces: true,
      };
    },
  };
}

function memberOf(conversation: DingTalkConversation): SyncDirectoryPage["members"] {
  const conversationId = conversation.conversation_id.trim();
  if (!conversationId) {
    return [];
  }
  const name = conversation.name?.trim();
  return [
    {
      stream_key: dingtalkStreamKey(conversationId),
      thread_id: `${DINGTALK_SOURCE}:${conversationId}`,
      ...(name ? { label: name } : {}),
      ...(conversation.chat_mode ? { kind: conversation.chat_mode } : {}),
    },
  ];
}
