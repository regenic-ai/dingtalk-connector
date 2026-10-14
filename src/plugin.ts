import { definePlugin } from "@regenic/plugin-host";
import type { DingTalkImClient } from "./dingtalk-client";
import { DingTalkChatEgress } from "./dingtalk-chat-egress";
import type { DingTalkChatMode, DingTalkConversation } from "./dingtalk-message";
import { createDingTalkStreams, dingtalkStreamKey } from "./dingtalk-streams";

export interface DingTalkChatPluginConfig {
  installation_id: string;
  org_id: string;
  conversation_id?: string;
  conversation_name?: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
  conversations?: DingTalkConversation[];
  client: DingTalkImClient;
  page_size?: number;
  now?: () => string;
}

export const dingtalkChatPlugin = definePlugin<DingTalkChatPluginConfig>({
  name: "dingtalk-chat",
  inject: ["connectors", "egress"],
  apply(ctx, config) {
    const conversations = pluginConversations(config);
    const streams = createDingTalkStreams(
      {
        id: config.installation_id,
        org_id: config.org_id,
      },
      conversations,
      config.client,
      config.page_size,
      config.now,
    );
    ctx.effect(() => {
      const disposers = streams.flatMap((stream) => {
        const conversationId = stream.thread_id?.slice("dingtalk:".length) ?? "";
        const conversation = conversations.find(
          (item) => item.conversation_id === conversationId,
        );
        const connector = ctx.get("connectors").register(
          config.installation_id,
          stream.connector,
          {
            stream_key: stream.stream_key,
            thread_id: stream.thread_id,
            label: stream.label,
            pace: stream.pace,
          },
        );
        const egress = ctx.get("egress").register(
          config.installation_id,
          new DingTalkChatEgress(config.client, {
            installation_id: config.installation_id,
            conversation_id: conversationId,
            chat_mode: conversation?.chat_mode,
            peer_user_id: conversation?.peer_user_id,
          }),
          dingtalkStreamKey(conversationId),
        );
        return [connector, egress];
      });
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose();
        }
      };
    });
  },
});

function pluginConversations(config: DingTalkChatPluginConfig): DingTalkConversation[] {
  if (config.conversations && config.conversations.length > 0) {
    return config.conversations;
  }
  if (config.conversation_id) {
    return [
      {
        conversation_id: config.conversation_id,
        ...(config.conversation_name ? { name: config.conversation_name } : {}),
        ...(config.chat_mode ? { chat_mode: config.chat_mode } : {}),
        ...(config.peer_user_id ? { peer_user_id: config.peer_user_id } : {}),
      },
    ];
  }
  throw new Error("DingTalk plugin requires conversation_id or conversations");
}
