import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  keychainCredentialsRef,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type NewConnectorInstallation,
  type ResolveStreamsOptions,
} from "@regenic/connector-contract";
import {
  dwsClientFor,
  resetDwsClientsForTests,
  type DingTalkImClient,
} from "./dingtalk-client";
import {
  dingtalkAllLabel,
  dingtalkInstallConfig,
  dingtalkKinds,
  dingtalkPickedConversationIds,
  dingtalkRecentLabel,
  dingtalkSelection,
  dingtalkStreamDiscover,
  dingtalkWriteBackLabels,
  pickedConversationNames,
} from "./dingtalk-config";
import {
  dingtalkConversationsFromCatalog,
  dingtalkConversationsFromThreads,
  resolveDingTalkConversationTargets,
} from "./dingtalk-directory";
import { dingtalkLocaleTables } from "./locales";
import { DINGTALK_SOURCE } from "./dingtalk-message";
import type { DingTalkChatMode, DingTalkConversation } from "./dingtalk-message";
import { DingTalkChatPollConnector } from "./dingtalk-chat-poll-connector";
import { dingtalkChatPlugin } from "./plugin";
import { probeDingTalkCatalog } from "./probe";
import {
  createDingTalkPickedSyncSource,
  createDingTalkRecentSyncSource,
  createDingTalkSyncSource,
} from "./dingtalk-sync-source";
import {
  dingtalkConversationIdFromStreamKey,
  dingtalkStreamKey,
} from "./dingtalk-streams";

export {
  dingtalkSelection,
  dingtalkStreamDiscover,
  dingtalkWriteBackLabels,
} from "./dingtalk-config";
export { resetDwsClientsForTests };
export { DINGTALK_STREAM_PACE, dingtalkStreamKey } from "./dingtalk-streams";

const CONNECTOR_TYPE = "dingtalk-chat";

export const dingtalkChatDriver: ChannelDriver = {
  connector_type: CONNECTOR_TYPE,
  source: DINGTALK_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  onStoreClear() {
    resetDwsClientsForTests();
  },

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: CONNECTOR_TYPE,
      status: "enabled",
      config: dingtalkInstallConfig(input.config),
      credentials_ref: keychainCredentialsRef(CONNECTOR_TYPE),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    if (thread.source !== DINGTALK_SOURCE || installation.status !== "enabled") {
      return false;
    }
    if (dingtalkSelection(installation.config) !== "pick") {
      return true;
    }
    return dingtalkPickedConversationIds(installation.config).includes(thread.target);
  },

  ownsThread(installation, thread) {
    if (!this.matchesThread(installation, thread)) {
      return false;
    }
    return dingtalkSelection(installation.config) === "pick";
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    return {
      sync: true,
      reply: true,
      create: false,
      list_title: "conversation",
      hydrate_on_open: true,
      attention: true,
    };
  },

  locales() {
    return dingtalkLocaleTables;
  },

  writeBackLabels(label) {
    return dingtalkWriteBackLabels(label);
  },

  installCatalog() {
    return {
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      fields: [
        {
          key: "sync_mode",
          label: "field.syncMode",
          required: true,
          default: "conversation",
          options: [
            { value: "conversation", label: "option.syncMode.conversation" },
            { value: "balanced", label: "option.syncMode.balanced" },
            { value: "context", label: "option.syncMode.context" },
          ],
        },
        {
          key: "selection",
          label: "field.selection",
          required: true,
          default: "recent",
          options: [
            { value: "recent", label: "option.selection.recent" },
            { value: "pick", label: "option.selection.pick" },
            { value: "all", label: "option.selection.all" },
          ],
        },
        {
          key: "kinds",
          label: "field.kinds",
          required: true,
          multiple: true,
          default: "group,p2p",
          options: [
            { value: "group", label: "option.kinds.group" },
            { value: "p2p", label: "option.kinds.p2p" },
          ],
          visible_when: { field: "selection", values: ["all", "recent", "pick"] },
        },
        {
          key: "conversation_ids",
          label: "field.conversationIds",
          required: true,
          multiple: true,
          placeholder: "field.conversationIds.placeholder",
          filter_options_by: "kinds",
          option_labels_key: "conversation_names",
          visible_when: { field: "selection", value: "pick" },
        },
      ],
      prerequisites: [
        {
          kind: "local_service" as const,
          key: "dws",
          label: "prereq.dws",
          required: true,
          hint: "prereq.dws.hint",
        },
      ],
      setup_steps: [
        {
          title: "setup.installCli.title",
          command: "npm install -g dingtalk-workspace-cli",
          href: "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli",
        },
        {
          title: "setup.signIn.title",
          body: "setup.signIn.body",
          command: "dws auth login",
        },
        {
          title: "setup.choose.title",
          body: "setup.choose.body",
        },
      ],
      install_confirm: {
        when: { field: "selection", value: "all" },
        warning: "confirm.all.warning",
        ack: "confirm.all.ack",
      },
    };
  },

  presentInstall(installation) {
    const config = installation.config;
    const selection = dingtalkSelection(config);
    const conversationIds = dingtalkPickedConversationIds(config);
    if (selection === "recent") {
      return { label: dingtalkRecentLabel(config), detail: { literal: "cli" } };
    }
    if (selection === "all") {
      return { label: dingtalkAllLabel(config), detail: { literal: "cli" } };
    }
    const names = pickedConversationNames(config, conversationIds);
    if (conversationIds.length > 1) {
      return {
        label: { key: "present.pickedCount", params: { count: conversationIds.length } },
        detail: { literal: "cli" },
      };
    }
    return {
      label: {
        literal: names[0] ?? conversationIds[0] ?? installation.id,
      },
      detail: { literal: "cli" },
    };
  },

  async resolveStreams(installation, host, env, options?: ResolveStreamsOptions) {
    const client = await clientFor(env);
    const mounted = conversationsFromStreams(
      host.get("connectors").listStreams(installation.id),
    );
    const selection = dingtalkSelection(installation.config);
    const conversations = await resolveDingTalkConversationTargets(
      installation.config,
      client,
      {
        known: mergeKnown(
          dingtalkConversationsFromThreads(options?.threads ?? [], (thread) =>
            this.matchesThread(installation, thread),
          ),
          dingtalkConversationsFromCatalog(options?.catalog ?? []),
          mounted,
        ),
        discover: dingtalkStreamDiscover(selection, options?.discover === true),
      },
    );
    return mountConversations(host, installation, conversations, client);
  },

  async bindSyncSource(installation, host, env) {
    const selection = dingtalkSelection(installation.config);
    if (selection === "pick") {
      const ids = dingtalkPickedConversationIds(installation.config);
      const names = pickedConversationNames(installation.config, ids);
      return createDingTalkPickedSyncSource(
        ids.map((conversation_id, index) => ({
          conversation_id,
          name: names[index],
        })),
      );
    }
    const client = await clientFor(env);
    const kinds = dingtalkKinds(installation.config);
    if (selection === "recent") {
      return createDingTalkRecentSyncSource(client, kinds);
    }
    return createDingTalkSyncSource(client, kinds);
  },

  async resolveThreadStream(installation, thread, host, env) {
    if (!this.matchesThread(installation, thread)) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "DingTalk installation does not include this conversation",
      );
    }
    const client = await clientFor(env);
    const mounted = conversationsFromStreams(
      host.get("connectors").listStreams(installation.id),
    ).find((conversation) => conversation.conversation_id === thread.target);
    const described = client.describeConversation(thread.target);
    const streams = await mountConversations(
      host,
      installation,
      [
        {
          conversation_id: thread.target,
          name:
            conversationName(installation.config, thread.target) ??
            mounted?.name ??
            described?.name,
          chat_mode: mounted?.chat_mode ?? described?.chat_mode,
          peer_user_id: mounted?.peer_user_id ?? described?.peer_user_id,
        },
      ],
      client,
    );
    return (
      streams[0] ??
      requireConnectorStream(
        host.get("connectors"),
        installation.id,
        dingtalkStreamKey(thread.target),
      )
    );
  },

  async bindEgress(installation, thread, host, env) {
    await this.resolveThreadStream(installation, thread, host, env);
    const egress = host.get("egress").get(
      installation.id,
      dingtalkStreamKey(thread.target),
    );
    if (!egress) {
      throw new ChannelDriverError(
        "send_failed",
        "DingTalk egress adapter failed to mount",
      );
    }
    return egress;
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    const sent = receipt.rpc_id?.trim();
    if (sent) {
      return `${thread.target}:out:${sent}`;
    }
    return `${thread.target}:out:local`;
  },

  async resolveConversationLabels(installation, threads, env) {
    const labels = new Map<string, string>();
    const wanted = threads.filter((thread) => thread.source === DINGTALK_SOURCE);
    const ids = dingtalkPickedConversationIds(installation.config);
    const names = pickedConversationNames(installation.config, ids);
    if (ids.length > 0 && names.length === ids.length) {
      for (let index = 0; index < ids.length; index += 1) {
        const name = names[index]?.replace(/\s+/g, " ").trim();
        if (name) {
          labels.set(`${DINGTALK_SOURCE}:${ids[index]}`, name);
        }
      }
    }
    const missing = wanted.filter(
      (thread) => !labels.has(`${DINGTALK_SOURCE}:${thread.target}`),
    );
    if (missing.length === 0) {
      return labels;
    }
    const client = dwsClientFor({ env });
    if (!client) {
      return labels;
    }
    for (const thread of missing.slice(0, 24)) {
      const name = client.describeConversation(thread.target)?.name?.replace(/\s+/g, " ").trim();
      if (name) {
        labels.set(`${DINGTALK_SOURCE}:${thread.target}`, name);
      }
    }
    return labels;
  },

  async readAttention(installation, threads, _host, env) {
    const attention = new Map<string, { unread: boolean; unread_count?: number; mentioned?: boolean }>();
    if (!this.capabilities(installation).attention) {
      return attention;
    }
    let unread: Awaited<ReturnType<DingTalkImClient["listUnread"]>> = [];
    try {
      unread = await clientFor(env).listUnread();
    } catch {
      return attention;
    }
    const byId = new Map(unread.map((item) => [item.conversation_id, item]));
    for (const thread of threads) {
      if (thread.source !== DINGTALK_SOURCE) {
        continue;
      }
      const row = byId.get(thread.target);
      if (!row) {
        continue;
      }
      attention.set(`${thread.source}:${thread.target}`, {
        unread: true,
        ...(row.unread_count !== undefined ? { unread_count: row.unread_count } : {}),
        ...(row.mentioned ? { mentioned: true } : {}),
      });
    }
    return attention;
  },

  async ackAttention(installation, thread, ack, _host, env) {
    if (thread.source !== DINGTALK_SOURCE || !this.capabilities(installation).attention) {
      return;
    }
    try {
      await clientFor(env).markRead({
        conversation_id: thread.target,
        message_id: ack.last_read_external_id,
      });
    } catch {
      // Leaving the badge is safer than failing the open.
    }
  },

  async listCatalogFieldOptions({ env }) {
    const client = dwsClientFor({ env });
    try {
      const conversations = await client.listAllConversations();
      return {
        conversation_ids: conversations.map((conversation) => ({
          value: conversation.conversation_id,
          label: conversation.name?.trim() || conversation.conversation_id,
          kind: conversation.chat_mode === "p2p" ? "p2p" : "group",
          title: conversation.name?.trim() || undefined,
        })),
      };
    } catch {
      return { conversation_ids: [] };
    }
  },

  async probeCatalog({ env }) {
    return probeDingTalkCatalog({ env });
  },
};

function clientFor(env: NodeJS.ProcessEnv): DingTalkImClient {
  return dwsClientFor({
    command: env.REGENIC_DWS_CLI,
    env,
  });
}

async function mountConversations(
  host: ConnectorHost,
  installation: ConnectorInstallation,
  conversations: DingTalkConversation[],
  client: DingTalkImClient,
): Promise<ConnectorStream[]> {
  const registry = host.get("connectors");
  const existing = new Set(
    registry.listStreams(installation.id).map((stream) => stream.stream_key),
  );
  const wanted = new Set(
    conversations.map((conversation) => dingtalkStreamKey(conversation.conversation_id)),
  );
  for (const stream of registry.listStreams(installation.id)) {
    const conversation = conversations.find(
      (item) => dingtalkStreamKey(item.conversation_id) === stream.stream_key,
    );
    if (conversation && stream.connector instanceof DingTalkChatPollConnector) {
      stream.connector.rememberConversation(conversation);
    }
  }
  const missing = conversations.filter(
    (conversation) => !existing.has(dingtalkStreamKey(conversation.conversation_id)),
  );
  if (missing.length > 0) {
    await host.plugin(dingtalkChatPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      conversations: missing,
      client,
    });
  }
  return registry
    .listStreams(installation.id)
    .filter((stream) => wanted.has(stream.stream_key));
}

function conversationsFromStreams(streams: readonly ConnectorStream[]): DingTalkConversation[] {
  return streams.flatMap((stream) => {
    if (stream.connector instanceof DingTalkChatPollConnector) {
      const described = stream.connector.describeConversation();
      return [described];
    }
    const conversationId = dingtalkConversationIdFromStreamKey(stream.stream_key);
    if (!conversationId) {
      return [];
    }
    return [
      {
        conversation_id: conversationId,
        ...(stream.label && stream.label !== conversationId ? { name: stream.label } : {}),
      },
    ];
  });
}

function mergeKnown(...groups: DingTalkConversation[][]): DingTalkConversation[] {
  const byId = new Map<string, DingTalkConversation>();
  for (const conversation of groups.flat()) {
    const prev = byId.get(conversation.conversation_id);
    byId.set(conversation.conversation_id, {
      conversation_id: conversation.conversation_id,
      name: conversation.name ?? prev?.name,
      chat_mode: conversation.chat_mode ?? prev?.chat_mode,
      ...(conversation.peer_user_id || prev?.peer_user_id
        ? { peer_user_id: conversation.peer_user_id ?? prev?.peer_user_id }
        : {}),
    });
  }
  return [...byId.values()];
}

function conversationName(
  config: Record<string, unknown>,
  conversationId: string,
): string | undefined {
  const ids = dingtalkPickedConversationIds(config);
  const names = pickedConversationNames(config, ids);
  const index = ids.indexOf(conversationId);
  return index >= 0 ? names[index] : undefined;
}
