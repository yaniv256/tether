import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureControlToken, readControlToken, resolveConfig } from "../src/server/config";
import { createDaemon, type EmbeddedServerHost, type TetherDaemon } from "../src/server/server";

const daemons: TetherDaemon[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("Windows embedded profiles can read their control credential", async () => {
  if (process.platform !== "win32") return;
  const directory = await mkdtemp(join(homedir(), ".tether-embedded-control-"));
  directories.push(directory);
  const config = resolveConfig({ profile: "windows-control-test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const created = await ensureControlToken(config);
  expect(await readControlToken(config)).toBe(created);
});

test("embedded document sessions require the configured principal and a live canonical file grant", async () => {
  const directory = await mkdtemp("/tmp/tether-embedded-server-");
  directories.push(directory);
  const first = join(directory, "first.md");
  const second = join(directory, "second.md");
  await writeFile(first, "First\n");
  await writeFile(second, "Second\n");
  const canonical = await realpath(first);
  let granted = new Set([canonical]);
  const checked: Array<[string, string, string]> = [];
  const embeddedHost: EmbeddedServerHost = {
    principal: "owner-one",
    authenticate: request => request.headers.get("x-test-principal"),
    authorizeDocument: (principal, path, method) => {
      checked.push([principal, path, method]);
      return granted.has(path);
    },
  };
  const config = resolveConfig({ profile: "embedded-test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, embeddedHost, startupGraceMs: 600_000, web: () => new Response("editor") });
  daemons.push(daemon);
  await daemon.ready;
  const launch = daemon.mintTicket(await daemon.service.open(first));
  expect((await fetch(launch.url, { redirect: "manual" })).status).toBe(401);
  expect((await fetch(launch.url, { redirect: "manual", headers: { "x-test-principal": "owner-two" } })).status).toBe(401);
  const denied = daemon.mintTicket(await daemon.service.open(second));
  expect((await fetch(denied.url, { redirect: "manual", headers: { "x-test-principal": "owner-one" } })).status).toBe(403);
  const opened = await fetch(launch.url, { redirect: "manual", headers: { "x-test-principal": "owner-one" } });
  expect(opened.status).toBe(302);
  const root = opened.headers.get("location")!;
  const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
  const read = (principal: string, path = "api/bootstrap") => fetch(new URL(path, `${daemon.origin}${root}`), { headers: { "x-test-principal": principal, cookie } });
  expect((await read("owner-two")).status).toBe(401);
  expect((await read("owner-one")).status).toBe(200);
  expect((await read("owner-one", "")).status).toBe(200);
  granted = new Set();
  expect((await read("owner-one")).status).toBe(403);
  expect((await read("owner-one", "")).status).toBe(403);
  granted = new Set([canonical]);
  embeddedHost.authorizeDocument = () => { throw new Error("Host policy unavailable"); };
  expect((await read("owner-one")).status).toBe(403);
  expect(checked.some(([principal, path, method]) => principal === "owner-one" && path === canonical && method === "GET")).toBe(true);
});

test("a second host can use the same server seam with a folder grant", async () => {
  const directory = await mkdtemp("/tmp/tether-embedded-folder-");
  directories.push(directory);
  const allowed = join(directory, "notes.md");
  await writeFile(allowed, "Notes\n");
  const config = resolveConfig({ profile: "folder-test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  const daemon = createDaemon({ config, embeddedHost: {
    principal: "another-host-user",
    authenticate: request => request.headers.get("authorization") === "Bearer host-secret" ? "another-host-user" : null,
    authorizeDocument: (_principal, path) => path.startsWith(`${directory}/`),
  }, startupGraceMs: 600_000 });
  daemons.push(daemon);
  await daemon.ready;
  const launch = daemon.mintTicket(await daemon.service.open(allowed));
  expect((await fetch(launch.url, { redirect: "manual", headers: { authorization: "Bearer host-secret" } })).status).toBe(302);
});

test("Folio needs an explicit profile grant and rechecks it on every request", async () => {
  const directory = await mkdtemp("/tmp/tether-embedded-folio-");
  directories.push(directory);
  const config = resolveConfig({ profile: "folio-test", runtimeDir: join(directory, "runtime"), configDir: join(directory, "config") });
  let folioAllowed = false;
  const daemon = createDaemon({ config, embeddedHost: {
    principal: "profile-owner",
    authenticate: request => request.headers.get("x-test-principal"),
    authorizeDocument: () => true,
    authorizeFolio: () => folioAllowed,
  }, startupGraceMs: 600_000 });
  daemons.push(daemon);
  await daemon.ready;
  const token = await readControlToken(config);
  const response = await fetch(`${daemon.origin}/control/recents/launch`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, origin: daemon.origin, "content-type": "application/json" }, body: "{}",
  });
  expect(response.status).toBe(200);
  const launch = await response.json() as { url: string };
  const principal = { "x-test-principal": "profile-owner" };
  expect((await fetch(launch.url, { headers: principal, redirect: "manual" })).status).toBe(403);
  folioAllowed = true;
  const opened = await fetch(launch.url, { headers: principal, redirect: "manual" });
  expect(opened.status).toBe(302);
  const root = opened.headers.get("location")!;
  const cookie = opened.headers.get("set-cookie")!.split(";", 1)[0]!;
  const snapshot = new URL("api/snapshot", `${daemon.origin}${root}`);
  expect((await fetch(snapshot, { headers: { ...principal, cookie } })).status).toBe(200);
  expect((await fetch(new URL("api/updates", `${daemon.origin}${root}`), { headers: { ...principal, cookie } })).status).toBe(404);
  expect((await fetch(new URL("api/service", `${daemon.origin}${root}`), {
    method: "POST", headers: { ...principal, cookie, origin: daemon.origin, "content-type": "application/json" }, body: '{"action":"quit"}',
  })).status).toBe(403);
  const document = join(directory, "folio.md");
  await writeFile(document, "Folio document\n");
  const add = await fetch(`${daemon.origin}/control/recents/add`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, origin: daemon.origin, "content-type": "application/json" },
    body: JSON.stringify({ path: document }),
  });
  expect(add.status).toBe(200);
  const openedDocument = await fetch(new URL("api/open", `${daemon.origin}${root}`), {
    method: "POST", headers: { ...principal, cookie, origin: daemon.origin, "content-type": "application/json" },
    body: JSON.stringify({ path: document }),
  });
  expect(openedDocument.status).toBe(200);
  const destination = await openedDocument.json() as { launchUrl: string };
  expect(destination.launchUrl).toContain("/launch?ticket=");
  expect((await fetch(destination.launchUrl, { headers: principal, redirect: "manual" })).status).toBe(302);
  folioAllowed = false;
  expect((await fetch(snapshot, { headers: { ...principal, cookie } })).status).toBe(403);
});
