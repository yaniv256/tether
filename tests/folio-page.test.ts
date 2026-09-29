import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { folioHtml } from "../src/web/folio-page";
import type { EmbeddedBrowserHost, HostEventSource } from "../src/web/embedded-host";

function runPage(snapshot: Record<string, unknown>, savedView?: string, configure?: (window: JSDOM["window"]) => void) {
  const html = folioHtml({ pickerAvailable: true });
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1/r/test/" });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { value: function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new dom.window.Event("close")); } });
  if (savedView !== undefined) dom.window.localStorage.setItem("tether.folio.view.v1", savedView);
  let currentSnapshot = { ...snapshot };
  const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  class FakeEventSource {
    static instance: FakeEventSource;
    closed = false;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { FakeEventSource.instance = this; }
    addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
    emit(value: Record<string, unknown>) { this.listeners.get("snapshot")?.({ data: JSON.stringify(value) }); }
    onerror: (() => void) | null = null;
    close() { this.closed = true; }
  }
  Object.defineProperty(dom.window, "EventSource", { value: FakeEventSource });
  Object.defineProperty(dom.window, "setInterval", { value: () => 0 });
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: async (input: string | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/api/")[1] ?? "";
    if (endpoint === "snapshot") return Response.json(currentSnapshot);
    if (init?.body) requests.push({ endpoint, body: JSON.parse(String(init.body)) });
    if (endpoint === "filters") {
      const body = JSON.parse(String(init?.body));
      const filters = ((currentSnapshot.filters ?? []) as Array<{ text: string; active: boolean }>).map(item => ({ ...item }));
      const index = filters.findIndex(item => item.text.toLowerCase() === body.text.toLowerCase());
      if (body.action === "delete") { if (index >= 0) filters.splice(index, 1); }
      else if (index >= 0) filters[index]!.active = body.action === "save" ? true : body.active;
      else filters.push({ text: body.text, active: true });
      currentSnapshot = { ...currentSnapshot, sequence: Number(currentSnapshot.sequence) + 1, filters };
      return Response.json(currentSnapshot);
    }
    return Response.json({ ok: true });
  } });
  configure?.(dom.window);
  const script = dom.window.document.querySelector("script")?.textContent;
  if (!script) throw new Error("Folio script missing");
  dom.window.eval(script);
  return { dom, html, requests, events: () => FakeEventSource.instance };
}

test("embedded Folio loads and receives updates entirely through its host, then returns and closes events", async () => {
  let nativeCalls = 0;
  let returns = 0;
  const openedDocuments: string[] = [];
  const requested: string[] = [];
  const snapshot = { sequence: 1, files: [{ path: "/notes.md", name: "Host notes", view: "active" }], instanceId: "embedded" };
  const { dom, events } = runPage(snapshot, undefined, window => {
    Object.defineProperty(window, "Request", { value: Request });
    Object.defineProperty(window, "AbortSignal", { value: AbortSignal });
    Object.defineProperty(window, "AbortController", { value: AbortController });
    Object.defineProperty(window, "fetch", { value: async () => { nativeCalls++; throw new Error("Network disabled"); } });
    const Events = (window as unknown as { EventSource: new (url: string) => HostEventSource }).EventSource;
    const host: EmbeddedBrowserHost = {
      version: 1, baseUrl: "https://logical.invalid/r/embedded/",
      request: async request => { requested.push(request.url); return Response.json(request.url.endsWith("/snapshot") ? snapshot : request.url.endsWith("/open") ? { launchUrl: "https://logical.invalid/launch?ticket=private" } : { ok: true }); },
      events: url => { expect(url).toBe("https://logical.invalid/r/embedded/api/events"); return new Events(url); },
      navigation: { label: "Back to Example", returnToHost() { returns++; }, openDocument(url) { openedDocuments.push(url); } },
    };
    Object.defineProperty(window, "tetherEmbeddedHost", { value: host });
  });
  try {
    await Bun.sleep(0);
    expect(requested).toContain("https://logical.invalid/r/embedded/api/snapshot");
    events().emit({ sequence: 2, files: [{ path: "/notes.md", name: "Host notes", view: "active" }] });
    expect(dom.window.document.querySelector(".name")?.textContent).toBe("Host notes");
    dom.window.document.querySelector<HTMLButtonElement>(".file")!.click();
    await Bun.sleep(0);
    expect(openedDocuments).toEqual(["https://logical.invalid/launch?ticket=private"]);
    const back = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Back to Example")!;
    back.click();
    await Bun.sleep(0);
    expect(returns).toBe(1);
    expect(nativeCalls).toBe(0);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide", { persisted: false }));
    expect(events().closed).toBe(true);
  } finally { dom.window.close(); }
});

test("Folio retains the original recovery dialog if refreshing after an action failure disconnects", async () => {
  const file = { path: "/notes.md", name: "Notes", view: "active", hasConversation: true };
  const { dom } = runPage({ sequence: 1, files: [file] });
  await Bun.sleep(0);
  Object.defineProperty(dom.window, "fetch", { value: async (input: string) => {
    if (String(input).endsWith("snapshot")) throw new Error("offline");
    return Response.json({ error: { code: "conversation_present", message: "This file now has a conversation." } }, { status: 409 });
  } });
  dom.window.document.querySelector<HTMLButtonElement>(".file")!.click();
  await Bun.sleep(0);
  expect(dom.window.document.querySelector("#recovery-message")?.textContent).toBe("This file now has a conversation.");
  expect(dom.window.document.querySelector("#recovery-dialog")?.classList.contains("open")).toBe(true);
  dom.window.close();
});

test("Folio stops its stream and disables actions on a lease-only authorization failure", async () => {
  const snapshot = { sequence: 1, files: [] };
  const { dom, events } = runPage(snapshot);
  await Bun.sleep(0);
  Object.defineProperty(dom.window, "fetch", { value: async (input: string) =>
    String(input).endsWith("lease") ? new Response(null, { status: 401 }) : Response.json(snapshot) });
  events().onerror?.();
  await Bun.sleep(0);
  expect(events().closed).toBe(true);
  expect(dom.window.document.querySelector("#freshness")?.textContent).toContain("no longer has access");
  expect(dom.window.document.querySelector<HTMLButtonElement>("#add")!.disabled).toBe(true);
  dom.window.close();
});

test("renders Folio Active and Archive views with organization controls", async () => {
  const files = [
    { id: "one", path: "/Users/hart/code/repo/one.md", name: "one.md", directory: "/Users/hart/code/repo", repository: "/Users/hart/code/repo", view: "active", pinned: true, missing: false, needsAttention: true, addedAt: 1, openedAt: 5, modifiedAt: 4, activityAt: 3, fileCreatedAt: 2, archivedAt: null, expiresAt: null, createdAt: 5 },
    { id: "two", path: "/Users/hart/notes/two.md", name: "two.md", directory: "/Users/hart/notes", repository: null, view: "archive", pinned: false, missing: true, needsAttention: false, addedAt: 1, openedAt: 2, modifiedAt: null, activityAt: null, fileCreatedAt: null, archivedAt: 3, expiresAt: 4, createdAt: 2 },
  ];
  const { dom, html, requests } = runPage({ sequence: 1, files, retention: { mode: "days", days: 30 } });
  await Bun.sleep(0);

  expect(html).toContain("<title>Tether Folio</title>");
  expect(html).toContain("Export with annotations");
  expect(html).toContain("Restart service");
  expect(dom.window.document.querySelector("#app-menu")?.textContent).not.toContain("Getting started");
  expect(dom.window.document.querySelector("#clear-unpinned")).toBeNull();
  expect([...dom.window.document.querySelectorAll(".name")].map((node) => node.textContent)).toEqual(["one.md"]);
  expect(dom.window.document.querySelector(".attention")?.textContent).toBe("1");

  const menu = dom.window.document.querySelector<HTMLButtonElement>(".file")!;
  menu.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  expect(dom.window.document.querySelector<HTMLButtonElement>("[data-pin]")?.dataset.action).toBe("unpin");
  dom.window.document.body.click();
  menu.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  expect(dom.window.document.querySelector<HTMLButtonElement>("[data-pin]")?.dataset.action).toBe("unpin");

  dom.window.document.querySelector<HTMLButtonElement>('[data-view="archive"]')!.click();
  expect([...dom.window.document.querySelectorAll(".name")].map((node) => node.textContent)).toEqual(["two.md"]);
  expect(dom.window.document.querySelector(".file.missing .file-path")?.textContent).toBe("File missing");
  expect(dom.window.document.querySelector("#missing")).toBeNull();
  expect(dom.window.document.querySelector('[data-action="start-fresh"]')).toBeNull();
  expect(dom.window.document.querySelector("#attention")?.textContent).toBe("Open threads");
  dom.window.document.querySelector<HTMLButtonElement>(".file.missing")!.click();
  await Bun.sleep(0);
  expect(dom.window.document.querySelector("#recovery-dialog.open")).not.toBeNull();
  expect(requests).toEqual([]);

  dom.window.document.querySelector<HTMLSelectElement>("#group")!.value = "directory";
  dom.window.document.querySelector("#group")!.dispatchEvent(new dom.window.Event("change"));
  expect(dom.window.document.querySelector(".group")?.textContent).toBe("~/notes");
});

test("accepts a lower snapshot sequence after the daemon instance changes", async () => {
  const active = { id: "one", path: "/tmp/one.md", name: "one.md", directory: "/tmp", repository: null, view: "active", pinned: false, missing: false, needsAttention: false, addedAt: 1, openedAt: 2, modifiedAt: 2, activityAt: null, fileCreatedAt: 1, archivedAt: null, expiresAt: null, createdAt: 2 };
  const archived = { ...active, id: "two", path: "/tmp/two.md", name: "two.md", view: "archive", archivedAt: 3 };
  const { dom, events } = runPage({ instanceId: "old", sequence: 100, files: [active], retention: { mode: "days", days: 30 } });
  await Bun.sleep(0);
  events().emit({ instanceId: "new", sequence: 1, files: [archived], retention: { mode: "days", days: 30 } });
  dom.window.document.querySelector<HTMLButtonElement>('[data-view="archive"]')!.click();
  expect(dom.window.document.querySelector(".name")?.textContent).toBe("two.md");
});

test("confirms immediate-retention clearing before sending the mutation", async () => {
  const file = { id: "one", path: "/tmp/one.md", name: "one.md", directory: "/tmp", repository: null, view: "active", pinned: false, missing: false, needsAttention: false, addedAt: 1, openedAt: 2, modifiedAt: 2, activityAt: null, fileCreatedAt: 1, archivedAt: null, expiresAt: null, createdAt: 2 };
  const { dom, requests } = runPage({ sequence: 1, files: [file], retention: { mode: "immediate" } });
  await Bun.sleep(0);
  dom.window.document.querySelector<HTMLButtonElement>(".file")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  dom.window.document.querySelector<HTMLButtonElement>('[data-action="archive"]')!.click();
  expect(dom.window.document.querySelector("#confirm-dialog")?.classList.contains("open")).toBe(true);
  expect(requests).toEqual([]);
  dom.window.document.querySelector<HTMLButtonElement>("#confirm-action")!.click();
  await Bun.sleep(0);
  expect(requests).toContainEqual({ endpoint: "action", body: { path: "/tmp/one.md", action: "archive", confirmed: true } });
});

test("does not render unavailable native and service actions", () => {
  const html = folioHtml({ pickFiles: false, importPackages: false, exportPackages: false, serviceControls: false });
  expect(html).toContain('"pickFiles":false');
  expect(html).toContain('"serviceControls":false');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  expect(() => new Function(script ?? "")).not.toThrow();
});

test("groups before sorting, keeps paths in hover text, and supports keyboard context menus", async () => {
  const base = { view: "active", pinned: false, missing: false, needsAttention: true, attentionCount: 3 };
  const files = [
    { ...base, path: "/b/a.md", directory: "/b", repository: "/b", name: "Newest B", openedAt: 9 },
    { ...base, path: "/a/a.md", directory: "/a", repository: "/a", name: "Middle A", openedAt: 8 },
    { ...base, path: "/b/b.md", directory: "/b", repository: "/b", name: "Older B", openedAt: 7 },
  ];
  const { dom } = runPage({ sequence: 1, files });
  await Bun.sleep(0);
  const doc = dom.window.document;
  for (const grouping of ["directory", "repository"]) {
    const group = doc.querySelector<HTMLSelectElement>("#group")!;
    group.value = grouping;
    group.dispatchEvent(new dom.window.Event("change"));
    expect([...doc.querySelectorAll(".group")].map(x => x.textContent)).toEqual(["/a", "/b"]);
    expect([...doc.querySelectorAll(".name")].map(x => x.textContent)).toEqual(["Middle A", "Newest B", "Older B"]);
  }
  expect(doc.querySelector(".row-menu")).toBeNull();
  expect(doc.querySelector(".dir")).toBeNull();
  expect(doc.querySelector(".attention")?.textContent).toBe("3");
  const card = doc.querySelector<HTMLButtonElement>(".file")!;
  expect(card.hasAttribute("title")).toBe(false);
  expect(card.querySelector(".file-path")?.textContent).toBe("/a/a.md");
  card.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  expect(doc.querySelector("#row-menu")?.classList.contains("open")).toBe(true);
  expect(doc.activeElement).toBe(doc.querySelector("[data-pin]"));
  expect(doc.querySelector("details")?.open).toBe(false);
  dom.window.close();
});

test("restores sorting, grouping, and an active filter across reloads", async () => {
  const snapshot = { sequence: 1, files: [
    { path: "/a/one.md", directory: "/a", name: "One", view: "active", openedAt: 1 },
    { path: "/b/two.md", directory: "/b", name: "Two", view: "active", openedAt: 2 },
  ] };
  const first = runPage(snapshot);
  await Bun.sleep(0);
  const doc = first.dom.window.document;
  for (const [id, value, event] of [["sort", "name", "change"], ["group", "directory", "change"], ["filter", "Two", "input"]]) {
    doc.querySelector<HTMLInputElement>("#" + id)!.value = value!;
    doc.querySelector("#" + id)!.dispatchEvent(new first.dom.window.Event(event!));
  }
  const saved = first.dom.window.localStorage.getItem("tether.folio.view.v1")!;
  first.dom.window.close();
  const second = runPage(snapshot, saved);
  await Bun.sleep(0);
  const restored = second.dom.window.document;
  expect(restored.querySelector<HTMLSelectElement>("#sort")!.value).toBe("name");
  expect(restored.querySelector<HTMLSelectElement>("#group")!.value).toBe("directory");
  const filter = restored.querySelector<HTMLInputElement>("#filter")!;
  expect(filter.value).toBe("Two");
  expect(filter.classList.contains("has-filter")).toBe(true);
  expect([...restored.querySelectorAll(".name")].map(node => node.textContent)).toEqual(["Two"]);
  filter.value = "";
  filter.dispatchEvent(new second.dom.window.Event("input"));
  expect(filter.classList.contains("has-filter")).toBe(false);
  expect(restored.querySelectorAll(".file").length).toBe(2);
  second.dom.window.close();
});

test("ignores corrupt or obsolete saved view choices", async () => {
  for (const saved of ["bad json", "null", '{"sort":"obsolete","group":"obsolete","filter":42}']) {
    const { dom } = runPage({ sequence: 1, files: [] }, saved);
    await Bun.sleep(0);
    expect(dom.window.document.querySelector<HTMLSelectElement>("#sort")!.value).toBe("opened");
    expect(dom.window.document.querySelector<HTMLSelectElement>("#group")!.value).toBe("none");
    expect(dom.window.document.querySelector<HTMLInputElement>("#filter")!.value).toBe("");
    dom.window.close();
  }
});


test("filter bank saves, combines, sorts, toggles and deletes while preserving input focus", async () => {
  const { dom, requests } = runPage({ sequence: 1, filters: [], files: [
    { path: "/notes/red.md", name: "Red", view: "active" },
    { path: "/notes/blue.md", name: "Blue", view: "active" },
    { path: "/other/red.md", name: "Other red", view: "active" },
  ] });
  await Bun.sleep(0);
  const doc = dom.window.document, input = doc.querySelector<HTMLInputElement>("#filter")!;
  const type = (text: string) => { input.value = text; input.dispatchEvent(new dom.window.Event("input")); };
  const names = () => [...doc.querySelectorAll(".name")].map(node => node.textContent);
  const pills = () => [...doc.querySelectorAll<HTMLButtonElement>(".filter-pill > button:first-child")];
  type("notes");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
  expect(requests).toEqual([]);
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
  await Bun.sleep(0);
  expect(input.value).toBe("");
  expect(doc.activeElement).toBe(input);
  expect(names()).toEqual(["Blue", "Red"]);
  type("red");
  expect(names()).toEqual(["Red"]);
  doc.querySelector<HTMLButtonElement>("#filter-save")!.click();
  await Bun.sleep(0);
  expect(pills().map(node => node.textContent)).toEqual(["notes", "red"]);
  pills()[0]!.click();
  await Bun.sleep(0);
  expect(pills().map(node => node.textContent)).toEqual(["red", "notes"]);
  expect(pills().map(node => node.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  expect(names()).toEqual(["Other red", "Red"]);
  pills()[0]!.click();
  await Bun.sleep(0);
  expect(pills().map(node => node.textContent)).toEqual(["notes", "red"]);
  type(" NOTES ");
  doc.querySelector<HTMLButtonElement>("#filter-save")!.click();
  await Bun.sleep(0);
  expect(pills()).toHaveLength(2);
  expect(names()).toEqual(["Blue", "Red"]);
  type("blue");
  doc.querySelector<HTMLButtonElement>("#filter-clear")!.click();
  expect(input.value).toBe("");
  expect(doc.activeElement).toBe(input);
  doc.querySelector<HTMLButtonElement>(".filter-delete")!.click();
  await Bun.sleep(0);
  expect(pills().map(node => node.textContent)).toEqual(["red"]);
  expect(names()).toHaveLength(3);
  expect(doc.querySelector("#confirm-dialog.open")).toBeNull();
  dom.window.close();
});

test("restores filter bank from daemon snapshots and retains text when saving fails", async () => {
  const snapshot = { instanceId: "new", sequence: 1, filters: [{ text: "red", active: true }, { text: "notes", active: false }], files: [
    { path: "/red.md", name: "Red", view: "active" }, { path: "/blue.md", name: "Blue", view: "active" },
  ] };
  const { dom, events } = runPage(snapshot);
  await Bun.sleep(0);
  const doc = dom.window.document;
  expect(doc.querySelectorAll(".file")).toHaveLength(1);
  events().emit({ ...snapshot, sequence: 2, filters: [{ text: "red", active: false }] });
  expect(doc.querySelectorAll(".file")).toHaveLength(2);
  Object.defineProperty(dom.window, "fetch", { value: async () => Response.json({ error: { message: "Disk full" } }, { status: 500 }) });
  const input = doc.querySelector<HTMLInputElement>("#filter")!;
  input.value = "blue";
  input.dispatchEvent(new dom.window.Event("input"));
  doc.querySelector<HTMLButtonElement>("#filter-save")!.click();
  await Bun.sleep(0);
  expect(input.value).toBe("blue");
  expect(doc.querySelector("#error-message")?.textContent).toContain("Disk full");
  expect(doc.querySelectorAll(".filter-pill")).toHaveLength(1);
  dom.window.close();
});

test("Folio open failures show the shared modal outside the scrolling document list", async () => {
  const { dom } = runPage({ sequence: 1, files: [{ path: "/one.md", name: "One", view: "active" }] });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { value: function(this: HTMLDialogElement) { this.open = true; } });
  await Bun.sleep(0);
  Object.defineProperty(dom.window, "fetch", { value: async () => Response.json({ error: {
    message: "Placement unavailable. In cmux, run: `'/path/mdreview' folio`",
  } }, { status: 503 }) });
  dom.window.document.querySelector<HTMLButtonElement>(".file")!.click();
  await Bun.sleep(0);
  const dialog = dom.window.document.querySelector<HTMLDialogElement>("dialog[data-tether-relaunch]")!;
  expect(dialog.open).toBe(true);
  expect(dialog.parentElement).toBe(dom.window.document.body);
  expect(dialog.querySelector("code")?.textContent).toBe("'/path/mdreview' folio");
  expect(dialog.querySelector("button")?.textContent).toBe("Copy");
  expect(dom.window.document.querySelector("#status")?.textContent).toBe("");
  dom.window.close();
});

test("file recovery offers disposable removal or conversation relocation", async () => {
  for (const hasConversation of [false, true]) {
    const file = { path: "/old.md", name: "Transcript", view: "active", hasConversation, fileIssue: { code: "folio_path_changed", message: "The saved path points elsewhere." } };
    const { dom, requests } = runPage({ sequence: 1, files: [file] });
    await Bun.sleep(0);
    const doc = dom.window.document;
    doc.querySelector<HTMLButtonElement>(".file")!.click();
    const buttons = [...doc.querySelectorAll<HTMLButtonElement>("#recovery-actions button")];
    expect(buttons.map(button => button.textContent)).toEqual(hasConversation ? ["Locate file", "Archive", "Close"] : ["Archive", "Remove from Folio", "Close"]);
    expect(doc.querySelector("#recovery-message")?.textContent).toBe(file.fileIssue.message);
    buttons.find(button => button.textContent === "Archive")!.click();
    await Bun.sleep(0);
    expect(requests).toContainEqual({ endpoint: "action", body: { path: file.path, action: "archive", confirmed: false } });
    dom.window.close();
  }
});

test("file errors discovered at action time offer recovery, and Locate cancellation is honest", async () => {
  const file = { path: "/old.md", name: "Transcript", view: "active", hasConversation: true };
  const { dom } = runPage({ sequence: 1, files: [file] }); await Bun.sleep(0);
  const doc = dom.window.document;
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: async () => Response.json({ error: { code: "folio_file_missing", message: "The file is missing." } }, { status: 409 }) });
  doc.querySelector<HTMLButtonElement>(".file")!.click(); await Bun.sleep(0);
  expect(doc.querySelector("#recovery-message")?.textContent).toBe("The file is missing.");
  Object.defineProperty(dom.window, "fetch", { value: async (input: string) => Response.json(input.endsWith("snapshot") ? { sequence: 2, files: [file] } : { cancelled: true }) });
  doc.querySelector<HTMLButtonElement>("#recovery-actions button")!.click(); await Bun.sleep(0);
  expect(doc.querySelector("#status")?.textContent).toBe("Locate cancelled.");
  dom.window.close();
});

test("disposable entries need no preservation confirmation with immediate retention", async () => {
  const file = { path: "/missing.md", name: "Missing", view: "active", missing: true, hasConversation: false };
  const { dom, requests } = runPage({ sequence: 1, files: [file], retention: { mode: "immediate" } }); await Bun.sleep(0);
  dom.window.document.querySelector<HTMLButtonElement>(".file")!.click();
  dom.window.document.querySelector<HTMLButtonElement>("#recovery-actions button")!.click(); await Bun.sleep(0);
  expect(dom.window.document.querySelector("#confirm-dialog.open")).toBeNull();
  expect(requests).toContainEqual({ endpoint: "action", body: { path: file.path, action: "archive", confirmed: true } });
  dom.window.close();
});

test("ordinary Folio errors stay in a viewport popup until Close or Escape", async () => {
  const { dom } = runPage({ sequence: 1, files: [] }); await Bun.sleep(0);
  const doc = dom.window.document, source = doc.querySelector<HTMLButtonElement>("#add")!;
  Object.defineProperty(dom.window, "fetch", { value: async () => Response.json({ error: { message: "Access denied <details>" } }, { status: 403 }) });
  for (const dismiss of ["close", "escape"]) {
    source.focus(); source.click(); await Bun.sleep(0);
    const popup = doc.querySelector<HTMLDialogElement>("#error-popup")!;
    expect(popup.open).toBe(true);
    expect(popup.parentElement).toBe(doc.body);
    expect(dom.window.getComputedStyle(popup).position).toBe("fixed");
    expect(doc.querySelector("#error-message")?.textContent).toBe("Access denied <details>");
    expect(popup.querySelector("details")).toBeNull();
    expect(doc.querySelector("#status")?.textContent).toBe("");
    expect(doc.activeElement).toBe(doc.querySelector("#error-dismiss"));
    if (dismiss === "close") doc.querySelector<HTMLButtonElement>("#error-dismiss")!.click();
    else popup.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
    expect(popup.open).toBe(false);
    expect(doc.activeElement).toBe(source);
  }
  dom.window.close();
});


test("live theme colors preserve Folio controls and document elements", async () => {
  const { folioTheme } = await import("../src/web/folio-page");
  const { dom, events } = runPage({ sequence: 1, files: [{ path: "/notes.md", name: "Notes", view: "active" }] });
  await Bun.sleep(0);
  const doc = dom.window.document;
  doc.querySelector<HTMLButtonElement>("#select")!.click();
  doc.querySelector<HTMLInputElement>(".file-check")!.click();
  doc.querySelector<HTMLButtonElement>("#more")!.click();
  const row = doc.querySelector(".file");
  const theme = folioTheme({ theme: "tether" });
  events().listeners.get("theme")!({ data: JSON.stringify(theme) });
  expect(doc.documentElement.style.getPropertyValue("--bg")).toBe(theme.palette.background);
  expect(doc.documentElement.style.getPropertyValue("--accent")).toBe(theme.palette.primary);
  expect(doc.documentElement.style.colorScheme).toBe("light");
  expect(doc.querySelector(".file")).toBe(row);
  expect(doc.querySelector<HTMLInputElement>(".file-check")!.checked).toBe(true);
  expect(doc.querySelector("#app-menu")!.classList.contains("open")).toBe(true);
  dom.window.close();
});
