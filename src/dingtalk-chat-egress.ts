import type {
  ContentPart,
  DeliveryReceipt,
  EgressAdapter,
  EgressCapabilities,
  SendIntent,
} from "@regenic/connector-contract";
import type { DingTalkImClient } from "./dingtalk-client";
import { DingTalkApiError } from "./dingtalk-openapi";
import { DINGTALK_SOURCE, type DingTalkChatMode } from "./dingtalk-message";

export interface DingTalkChatEgressOptions {
  installation_id: string;
  conversation_id: string;
  chat_mode?: DingTalkChatMode;
  peer_user_id?: string;
}

export class DingTalkChatEgress implements EgressAdapter {
  readonly source = DINGTALK_SOURCE;

  constructor(
    private readonly client: DingTalkImClient,
    private readonly options: DingTalkChatEgressOptions,
  ) {}

  capabilities(): EgressCapabilities {
    return { reply: true, edit: false, tombstone: false };
  }

  async send(intent: SendIntent): Promise<DeliveryReceipt> {
    if (intent.installation_id !== this.options.installation_id) {
      throw new DingTalkApiError("Send intent installation does not match the DingTalk adapter");
    }
    const text = textFromContentParts(intent.content);
    if (!text) {
      throw new DingTalkApiError("DingTalk send needs a text body");
    }
    const described = this.client.describeConversation(this.options.conversation_id);
    const sent = await this.client.sendText({
      conversation_id: this.options.conversation_id,
      chat_mode: this.options.chat_mode ?? described?.chat_mode,
      peer_user_id: this.options.peer_user_id ?? described?.peer_user_id,
      text,
    });
    return {
      accepted: true,
      rpc_id: sent.message_id,
      channel_message_ids: [sent.message_id],
    };
  }
}

export function textFromContentParts(content: ContentPart[]): string {
  const texts: string[] = [];
  for (const part of content) {
    if (part.role === "attachment") {
      throw new DingTalkApiError("DingTalk send cannot deliver attachments");
    }
    if (part.role === "body" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  return texts.join("\n").trim();
}
