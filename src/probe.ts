import type { CopyRef } from "@regenic/connector-contract";
import { probeDwsAuth, type DwsRunOptions } from "./dingtalk-client";

const PROBE_TTL_MS = 20_000;
let cache: { at: number; installed: boolean; authenticated: boolean } | undefined;

export async function probeDingTalkCatalog(input: {
  env: NodeJS.ProcessEnv;
  command?: string;
  spawn?: DwsRunOptions["spawn"];
  now?: () => number;
}): Promise<{
  services: Record<string, { ready: boolean; hint: CopyRef }>;
}> {
  const now = input.now?.() ?? Date.now();
  if (!cache || now - cache.at >= PROBE_TTL_MS) {
    const probe = await probeDwsAuth({
      command: input.command ?? input.env.REGENIC_DWS_CLI,
      env: input.env,
      spawn: input.spawn,
    });
    cache = { at: now, ...probe };
  }
  return {
    services: {
      dws: {
        ready: cache.installed && cache.authenticated,
        hint: !cache.installed
          ? "probe.notInstalled"
          : !cache.authenticated
            ? "probe.notSignedIn"
            : "probe.ready",
      },
    },
  };
}

export function resetDingTalkProbeForTests(): void {
  cache = undefined;
}
