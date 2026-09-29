import { operationError } from "../shared/diagnostics";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { acquireFileLock } from "../documents/path-lock";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DiscoveryRecord } from "../shared/contracts";
import { PROTOCOL_VERSION, SERVICE_ID } from "../shared/contracts";

/** Runtime and profile paths are deliberately outside a source checkout. */
export type TetherConfig = {
  profile: string;
  runtimeDir: string;
  configDir: string;
  discoveryPath: string;
  lockPath: string;
  controlPath: string;
  recentsPath: string;
  preferencesPath: string;
  waveBridgePath: string;
  cmuxBridgePath: string;
};

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateProfile(profile: string): string {
  if (!PROFILE_RE.test(profile) || profile === "." || profile === "..") {
    throw new Error("TETHER_PROFILE must contain 1–64 letters, numbers, underscores, or hyphens.");
  }
  return profile;
}

function defaultRuntimeRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "tether", "runtime");
  return process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "tether") : join(homedir(), ".local", "state", "tether");
}

function defaultConfigRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "tether", "config");
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "tether") : join(homedir(), ".config", "tether");
}

export function resolveConfig(input: Partial<Pick<TetherConfig, "profile" | "runtimeDir" | "configDir">> = {}): TetherConfig {
  // Normal launches share the existing user's data. Keep explicit isolated
  // profiles for development; `default` is an alias, not another user store.
  const requestedProfile = validateProfile(input.profile ?? process.env.TETHER_PROFILE ?? "preview");
  const profile = requestedProfile === "default" ? "preview" : requestedProfile;
  // Explicit overrides name the directory itself. Defaults are namespaced by
  // profile below the platform's per-user roots.
  const runtimeOverride = input.runtimeDir ?? process.env.TETHER_RUNTIME_DIR;
  const configOverride = input.configDir ?? process.env.TETHER_CONFIG_DIR;
  const runtimeDir = resolve(runtimeOverride ?? join(defaultRuntimeRoot(), profile));
  const configDir = resolve(configOverride ?? join(defaultConfigRoot(), profile));
  return {
    profile,
    runtimeDir,
    configDir,
    discoveryPath: join(runtimeDir, "discovery.json"),
    lockPath: join(runtimeDir, "startup.lock"),
    controlPath: join(runtimeDir, "control.token"),
    recentsPath: join(configDir, "recent-files.json"),
    preferencesPath: join(configDir, "preferences.json"),
    waveBridgePath: join(runtimeDir, "wave-bridge.json"),
    cmuxBridgePath: join(runtimeDir, "cmux-bridge.json"),
  };
}

export async function prepareConfig(config: TetherConfig): Promise<void> {
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  // chmod is needed when an existing directory was created too broadly.
  await chmod(config.runtimeDir, 0o700).catch(() => {});
  await chmod(config.configDir, 0o700).catch(() => {});
}

export async function readDiscovery(config: TetherConfig): Promise<DiscoveryRecord | null> {
  try {
    const value = JSON.parse(await readFile(config.discoveryPath, "utf8")) as Partial<DiscoveryRecord>;
    const pid = value.pid;
    if (value.protocol !== PROTOCOL_VERSION || typeof value.instanceId !== "string" || !value.instanceId ||
      typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.origin !== "string" ||
      typeof value.startedAt !== "string") throw new Error("Invalid daemon discovery record.");
    const origin = new URL(value.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port) throw new Error("Invalid daemon discovery address.");
    return { protocol: PROTOCOL_VERSION, instanceId: value.instanceId, pid, origin: value.origin, startedAt: value.startedAt };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw operationError(cause, { stage: "discovery", path: config.discoveryPath, outcome: "not_applied" });
  }
}

export async function writeDiscovery(config: TetherConfig, discovery: DiscoveryRecord): Promise<void> {
  await prepareConfig(config);
  const temporary = `${config.discoveryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(discovery), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, config.discoveryPath);
  await chmod(config.discoveryPath, 0o600).catch(() => {});
}

export async function removeDiscovery(config: TetherConfig, instanceId?: string): Promise<void> {
  if (instanceId) {
    const current = await readDiscovery(config);
    if (current && current.instanceId !== instanceId) return;
  }
  await unlink(config.discoveryPath).catch(() => {});
}

export async function readControlToken(config: TetherConfig): Promise<string | null> {
  try {
    const info = await stat(config.controlPath);
    // Windows stat mode does not represent the file's ACL (Bun reports 0666
    // even when the token is in a user-owned profile). Check POSIX bits only.
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw Object.assign(new Error("Unsafe daemon control credential permissions."), { code: "control_permissions_unsafe" });
    }
    const token = (await readFile(config.controlPath, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw Object.assign(new Error("Invalid daemon control credential."), { code: "control_invalid" });
    return token;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw operationError(cause, { stage: "control_credential", outcome: "not_applied" });
  }
}

export async function ensureControlToken(config: TetherConfig): Promise<string> {
  await prepareConfig(config);
  const existing = await readControlToken(config);
  if (existing) return existing;
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const temporary = `${config.controlPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  try {
    // Avoid replacing another launcher's token. Both values are valid, and a
    // retry will read the winner.
    const handle = await open(config.controlPath, "wx", 0o600);
    await handle.writeFile(`${token}\n`);
    await handle.close();
    await unlink(temporary).catch(() => {});
    return token;
  } catch {
    await unlink(temporary).catch(() => {});
    const winner = await readControlToken(config);
    if (winner) return winner;
    throw new Error("Unable to create the private daemon control credential.");
  }
}

type LockHandle = { release: () => Promise<void> };

/** Keep one stable inode. The kernel releases ownership on process exit, so
 * empty files and legacy PID records need no stale-owner recovery. */
export async function acquireStartupLock(config: TetherConfig): Promise<LockHandle> {
  await prepareConfig(config);
  return acquireFileLock(config.lockPath);
}

export async function removeStaleRuntime(config: TetherConfig): Promise<void> {
  const lock = await acquireStartupLock(config);
  try { await unlink(config.discoveryPath).catch(() => {}); }
  finally { await lock.release(); }
}

export { PROTOCOL_VERSION, SERVICE_ID };
