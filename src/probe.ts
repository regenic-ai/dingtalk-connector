import { createHash } from "node:crypto";
import type { CopyRef } from "@regenic/connector-contract";
import { probeDwsAuth, type DwsRunOptions } from "./dingtalk-client";

const PROBE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; installed: boolean; authenticated: boolean }>();
const spawnIds = new WeakMap<NonNullable<DwsRunOptions["spawn"]>, number>();
let nextSpawnId = 1;

export async function probeDingTalkCatalog(input: {
  env: NodeJS.ProcessEnv;
  command?: string;
  spawn?: DwsRunOptions["spawn"];
  now?: () => number;
}): Promise<{
  services: Record<string, { ready: boolean; hint: CopyRef }>;
}> {
  const now = input.now?.() ?? Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= PROBE_TTL_MS) {
      cache.delete(key);
    }
  }
  const key = probeCacheKey(input);
  let result = cache.get(key);
  if (!result) {
    const probe = await probeDwsAuth({
      command: input.command ?? input.env.REGENIC_DWS_CLI,
      env: input.env,
      spawn: input.spawn,
    });
    result = { at: now, ...probe };
    cache.set(key, result);
  }
  return {
    services: {
      dws: {
        ready: result.installed && result.authenticated,
        hint: !result.installed
          ? "probe.notInstalled"
          : !result.authenticated
            ? "probe.notSignedIn"
            : "probe.ready",
      },
    },
  };
}

export function resetDingTalkProbeForTests(): void {
  cache.clear();
}

function probeCacheKey(input: {
  env: NodeJS.ProcessEnv;
  command?: string;
  spawn?: DwsRunOptions["spawn"];
}): string {
  const env = Object.entries(input.env).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const envHash = createHash("sha256").update(JSON.stringify(env)).digest("hex");
  let spawnId = 0;
  if (input.spawn) {
    spawnId = spawnIds.get(input.spawn) ?? nextSpawnId++;
    spawnIds.set(input.spawn, spawnId);
  }
  const command = input.command?.trim() || input.env.REGENIC_DWS_CLI?.trim() || "dws";
  return `${command}\u0000${envHash}\u0000${spawnId}`;
}
