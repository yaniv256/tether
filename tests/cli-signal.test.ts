import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main";
import { commandResult } from "../src/cli/results";
import { diagnostic, diagnosticText, diagnosticValue, errorDetails } from "../src/shared/diagnostics";
import { prepareConfig, resolveConfig, writeDiscovery } from "../src/server/config";
import { ensureDaemon, statusDaemon, stopDaemon } from "../src/server/lifecycle";
import { createDaemon } from "../src/server/server";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(withDaemon = true) {
  const root = await mkdtemp("/tmp/tether-cli-signal-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ runtimeDir: join(root, "runtime"), configDir: join(root, "config") });
  await prepareConfig(config);
  if (withDaemon) {
    const daemon = createDaemon({ config, startupGraceMs: 600000, web: () => new Response("test") });
    cleanup.push(() => daemon.stop());
    await daemon.ready;
  }
  return { root, config };
}

test("ordinary registration is compact and explicit sync remains diagnostic", async () => {
  const { root, config } = await fixture();
  const path = join(root, "one.md"); await writeFile(path, "One");
  const result = await runCli(["recents", "add", path], { config });
  expect(result).toEqual({ exitCode: 0, response: { protocol: 1, ok: true, command: "recents.add", data: { added: [{ path: await import("node:fs/promises").then(fs => fs.realpath(path)) }] } } });
  expect((await runCli(["folio", "sync"], { config })).response).toMatchObject({ data: { hostSyncStatus: "unsupported" } });
});

test("import projection preserves per-item and registration failures without registry noise", () => {
  const failed = { code: "EACCES", message: "Access denied", outcome: "outcome_unknown" };
  const result = commandResult("folio.import", { completed: [{ path: "/tmp/a.md" }], failed: [{ path: "/tmp/b.md", code: "EEXIST" }], outcome: "partially_applied", registration: failed });
  expect(result).toMatchObject({ failed: [{ code: "EEXIST" }], registration: failed, outcome: "partially_applied" });
  expect(commandResult("folio.import", { registration: { added: [{ path: "/tmp/a.md", createdAt: 1 }], entries: ["unrelated"], hostSyncStatus: "skipped" } })).toEqual({ registration: { added: [{ path: "/tmp/a.md" }] } });
});

test("missing and invalid registration inputs report not-applied with the original cause", async () => {
  const { root, config } = await fixture();
  const path = join(root, "absent.md");
  const missing = await runCli(["recents", "add", path], { config });
  expect(JSON.stringify(missing.response)).not.toContain("Inspect current state before retrying");
  expect(missing.response).toMatchObject({ error: { code: "path_not_found", details: { outcome: "not_applied", diagnostic: { code: "ENOENT", path } } } });
  expect((await runCli(["folio", "add", join(root, "wrong.txt")], { config })).response).toMatchObject({ error: { code: "invalid_document_type", details: { outcome: "not_applied" } } });
  expect((await runCli(["folio", "list"], { config })).response).toMatchObject({ data: { files: [] } });
});

test("package read errors retain codes while syntax errors identify invalid packages", async () => {
  const { root, config } = await fixture(false);
  const path = join(root, "package.tether");
  expect((await runCli(["folio", "import", "--package", path, "--directory", root], { config })).response).toMatchObject({ error: { code: "ENOENT" } });
  await writeFile(path, "not json");
  expect((await runCli(["folio", "import", "--package", path, "--directory", root], { config })).response).toMatchObject({ error: { code: "invalid_package" } });
});

test("corrupt host preferences fail host launches but cannot block registration", async () => {
  const { root, config } = await fixture();
  const path = join(root, "one.md"); await writeFile(path, "One");
  await writeFile(join(config.configDir, "launch.json"), "not json");
  expect((await runCli(["recents", "add", path], { config })).exitCode).toBe(0);
  expect((await runCli(["open", path], { config })).exitCode).toBe(1);
  expect((await runCli(["daemon", "status"], { config })).response).toMatchObject({ data: { running: true } });
});

test("diagnostics preserve safe identity, bound causes and redact credentials", () => {
  const cause = Object.assign(new Error("open denied"), { code: "EPERM", syscall: "open", path: "/tmp/file" });
  expect(diagnostic(cause)).toMatchObject({ code: "EPERM", syscall: "open", path: "/tmp/file" });
  const wrapper = Object.assign(new Error("Service failed"), { status: 403, details: { diagnostic: diagnostic(cause), outcome: "not_applied" } });
  expect(errorDetails(wrapper)).toMatchObject({ httpStatus: 403, diagnostic: { code: "EPERM" }, outcome: "not_applied" });
  const message = diagnosticText("http://localhost/launch?ticket=credential Authorization: Bearer credential");
  expect(message).not.toContain("credential");
  expect(message).toContain("[redacted]");
  expect(diagnosticText('{"WAVETERM_JWT":"fixture-value"} WAVETERM_JWT=fixture-value')).not.toContain("fixture-value");
  expect(diagnosticText('{"Authorization":"Basic fixture-value", "Cookie":"session=fixture-value"}')).not.toContain("fixture-value");
  expect(JSON.stringify(diagnosticValue({ apiKey: "fixture-value" }))).not.toContain("fixture-value");
  expect(diagnosticText("a".repeat(3000))).toEndWith("[truncated]");
  const cycle = new Error("cycle"); cycle.cause = cycle;
  expect(JSON.stringify(diagnostic(cycle))).toContain("[truncated]");
});

test("a live but unverified daemon never becomes stopped or triggers another launch", async () => {
  const { config } = await fixture(false);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unavailable", { status: 503 }) });
  cleanup.push(async () => { listener.stop(true); });
  await writeDiscovery(config, { protocol: 1, instanceId: "fixture", pid: process.pid, origin: `http://127.0.0.1:${listener.port}`, startedAt: new Date().toISOString() });
  let spawned = false;
  await expect(ensureDaemon({ config, spawn: () => { spawned = true; } })).rejects.toMatchObject({ code: "daemon_unreachable", details: { diagnostic: { status: 503 } } });
  expect(spawned).toBe(false);
  await expect(statusDaemon(config)).rejects.toMatchObject({ code: "daemon_unreachable" });
  await expect(stopDaemon(config)).rejects.toMatchObject({ code: "daemon_unreachable" });
  expect(await readFile(config.discoveryPath, "utf8")).toContain("fixture");
});

test("startup failures retain child status and clean up the private report directory", async () => {
  const { config } = await fixture(false);
  await expect(ensureDaemon({ config, command: [process.execPath, "-e", "process.exit(7)"], waitAttempts: 20 })).rejects.toMatchObject({ code: "daemon_start_failed", details: { exitCode: 7 } });
  expect((await readdir(config.runtimeDir)).some(name => name.startsWith("startup-report-"))).toBe(false);
});

test("startup timeout cleans up its report directory", async () => {
  const { config } = await fixture(false);
  await expect(ensureDaemon({ config, spawn: () => {}, waitAttempts: 1 })).rejects.toMatchObject({ code: "daemon_start_timeout", details: { outcome: "outcome_unknown" } });
  expect((await readdir(config.runtimeDir)).some(name => name.startsWith("startup-report-"))).toBe(false);
});

test("status retains credential-read failures without pretending the healthy process is stopped", async () => {
  if (process.platform === "win32") return; // chmod cannot express Windows ACL permissions.
  const { config } = await fixture();
  await chmod(config.controlPath, 0o644);
  expect(await statusDaemon(config)).toMatchObject({ running: true, controlIssue: { diagnostic: { code: "control_permissions_unsafe" } } });
});

test("a real timed-out startup child exits before a subsequent launch acquires exclusion", async () => {
  const { root, config } = await fixture(false);
  const pidPath = join(root, "child.pid");
  const script = `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
  await expect(ensureDaemon({ config, command: [process.execPath, "-e", script], waitAttempts: 2 })).rejects.toMatchObject({ code: "daemon_start_timeout" });
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(ensureDaemon({ config, command: [process.execPath, "-e", "process.exit(6)"], waitAttempts: 10 })).rejects.toMatchObject({ code: "daemon_start_failed", details: { exitCode: 6 } });
});

test("listener bookkeeping failure closes the child and returns its structured startup cause", async () => {
  const { config } = await fixture(false);
  await mkdir(join(config.runtimeDir, "listener.json"));
  await expect(ensureDaemon({ config, waitAttempts: 40 })).rejects.toMatchObject({ code: "daemon_start_failed", details: { exitCode: 1, diagnostic: { code: "EISDIR" } } });
  expect((await readdir(config.runtimeDir)).some(name => name.startsWith("startup-report-"))).toBe(false);
});

test("launch cleanup failure is secondary to the original placement error", async () => {
  const { root, config } = await fixture();
  const path = join(root, "cleanup.md"); await writeFile(path, "Cleanup");
  const discovery = await readFile(config.discoveryPath, "utf8");
  try {
    const result = await runCli(["open", path], { config, host: {
      id: "browser", detect: async () => true,
      capabilities: () => ({ embeddedBrowser: false, hiddenNavigation: false, widgetInstallation: false, fileNavigatorHook: false, revealFile: false }),
      openExternal: async () => {},
      openView: async () => { await writeFile(config.discoveryPath, "invalid"); throw Object.assign(new Error("placement failed"), { code: "placement_failed" }); },
    } });
    expect(result.response).toMatchObject({ command: "open", error: { code: "placement_failed", message: "placement failed", details: { outcome: "partially_applied", cleanup: { stage: "discovery" } } } });
  } finally { await writeFile(config.discoveryPath, discovery); }
});


test("group help lists subcommands without launching a service", async () => {
  for (const group of ["document", "daemon", "wave", "cmux", "folio", "recents"]) {
    const result = await runCli([group, "--help"]);
    expect(result).toMatchObject({ exitCode: 0, response: { command: "help", data: { command: group, commands: expect.any(Array), reporting: expect.stringContaining("plain language") } } });
  }
  expect((await runCli(["document", "--help"])).response).toMatchObject({ data: { commands: expect.arrayContaining([expect.objectContaining({ name: "document.save" })]) } });
  expect((await runCli(["unknown", "--help"])).exitCode).toBe(2);
  expect((await runCli(["document", "--help", "extra"])).exitCode).toBe(2);
});
