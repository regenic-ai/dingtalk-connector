import { spawn } from "node:child_process";

export class DingTalkCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DingTalkCliError";
  }
}

export interface DwsSpawnResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type DwsSpawn = (input: {
  command: string[];
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
  signal?: AbortSignal;
  cwd?: string;
}) => Promise<DwsSpawnResult>;

export interface DwsRunOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: DwsSpawn;
  timeout_ms?: number;
  signal?: AbortSignal;
  /** dws only writes downloads to relative paths inside its working directory. */
  cwd?: string;
}

const CLI_SLOTS = 4;
let activeSlots = 0;
const waiters: Array<() => void> = [];

export async function runDws(
  args: string[],
  options: DwsRunOptions = {},
): Promise<unknown> {
  throwIfAborted(options.signal);
  await acquireSlot();
  try {
    throwIfAborted(options.signal);
    const executable = options.command?.trim() || options.env?.REGENIC_DWS_CLI?.trim() || "dws";
    const result = await (options.spawn ?? spawnDwsProcess)({
      command: [executable, ...args, "--format", "json"],
      env: options.env,
      timeout_ms: options.timeout_ms ?? 30_000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (result.exit_code !== 0) {
      throw new DingTalkCliError(cliFailure(result));
    }
    return parseCliJson(result.stdout);
  } finally {
    releaseSlot();
  }
}

export function spawnDwsProcess(input: {
  command: string[];
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
  signal?: AbortSignal;
  cwd?: string;
}): Promise<DwsSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command[0] ?? "dws", input.command.slice(1), {
      env: input.env ?? process.env,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new DingTalkCliError("dws timed out")));
    }, input.timeout_ms);
    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      finish(() => reject(abortError(input.signal)));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(() => resolve({
        stdout,
        stderr,
        exit_code: code ?? 1,
      }));
    });

    function finish(done: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      done();
    }
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("dws aborted");
  error.name = "AbortError";
  return error;
}

export function isDwsMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    }
    throw new DingTalkCliError("dws returned non-JSON output");
  }
}

function cliFailure(result: DwsSpawnResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const line = detail.split("\n").find((entry) => entry.trim())?.trim();
  return line ? `dws failed (${result.exit_code}): ${line.slice(0, 240)}` : `dws failed (${result.exit_code})`;
}

async function acquireSlot(): Promise<void> {
  if (activeSlots < CLI_SLOTS) {
    activeSlots += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  activeSlots = Math.max(0, activeSlots - 1);
}
