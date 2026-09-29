import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

for (const embedded of [false, true]) test(`the actual ${embedded ? "embedded" : "standalone"} reader recovers its draft before post-mount requests, and preserves it through reconnect`, async () => {
  const bundle = await Bun.build({ entrypoints: ["src/web/app.ts"], target: "browser", format: "iife", minify: true });
  expect(bundle.success).toBe(true);
  const js = await bundle.outputs.find(asset => asset.path.endsWith(".js"))!.text();
  const dom = new JSDOM(await Bun.file("src/web/index.html").text(), { url: "http://127.0.0.1/s/reader/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  let bootstraps = 0, leases = 0;
  let hostReturns = 0, nativeRequests = 0, beacons = 0;
  const writes: Array<{ route: string; body: any }> = [];
  Object.assign(win, {
    structuredClone, TextEncoder, TextDecoder,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    scrollTo: (_x: number, y: number) => { Object.defineProperty(win, "scrollY", { configurable: true, value: y }); },
    fetch: async (input: string, init?: RequestInit) => {
      const route = String(input);
      if (route === "api/bootstrap") {
        if (++bootstraps === 1) return Response.json({ error: { message: "starting" } }, { status: 503 });
        return Response.json({ preferences: { theme: "tether" }, scroll: 900,
          document: { path: "/tmp/reader.md", body: "# Disk changed\n", bodyRevision: "disk", ledgerRevision: "ledger", annotations: { threads: [] } },
          draft: { body: "# My unsaved draft\n", baseRevision: "original", scroll: 900 },
        });
      }
      if (route === "api/lease") {
        if (++leases === 1) throw new Error("temporary disconnection after mount");
        return Response.json({ bodyRevision: "disk", ledgerRevision: "ledger" });
      }
      if (route === "api/file" && (!init?.method || init.method === "GET")) return Response.json({ path: "/tmp/reader.md", body: "# Disk changed\n", bodyRevision: "disk", ledgerRevision: "ledger", annotations: { threads: [] } });
      if (init?.body) writes.push({ route, body: JSON.parse(String(init.body)) });
      return Response.json({});
    },
  });
  Object.defineProperty(doc, "fonts", { value: { ready: Promise.resolve() } });
  Object.defineProperty(win.navigator, "sendBeacon", { value: () => { beacons++; return true; } });
  if (embedded) {
    const serve = win.fetch;
    Object.assign(win, { Request, AbortController, AbortSignal, Blob });
    Object.defineProperty(win, "tetherEmbeddedHost", { value: {
      version: 1, baseUrl: "https://logical.invalid/s/reader/",
      request: async (request: Request) => serve(new URL(request.url).pathname.replace("/s/reader/", ""), {
        method: request.method,
        ...(request.method === "GET" ? {} : { body: await request.text() }),
      }),
      events: () => ({ addEventListener() {}, close() {}, onerror: null }),
      navigation: { label: "Back to Example", returnToHost() { hostReturns++; } },
    } });
    win.fetch = async () => { nativeRequests++; throw new Error("Native network disabled"); };
  }
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await Bun.sleep(20); }
    throw new Error(`Reader did not settle: ${doc.querySelector("#notice")?.textContent}`);
  };
  try {
    win.eval(js);
    await until(() => doc.querySelector(".ProseMirror") !== null && doc.querySelector<HTMLElement>("#editor")!.inert === false);
    const editor = doc.querySelector(".ProseMirror")!;
    expect(editor.textContent).toContain("My unsaved draft");
    expect(doc.querySelector<HTMLElement>("#conflict")!.hidden).toBe(false);
    const scroller = doc.querySelector<HTMLElement>(".wm-document-scroll")!;
    expect(scroller.scrollTop).toBe(900);
    expect(win.scrollY).toBe(0);
    scroller.scrollTop = 1100;
    scroller.dispatchEvent(new win.Event("scroll"));
    await until(() => writes.some(write => write.route === "api/position" && write.body.scroll === 1100));
    await until(() => writes.some(write => write.route === "api/draft"));
    expect(writes.filter(write => write.route === "api/draft").every(write => write.body.body.includes("My unsaved draft") && write.body.baseRevision === "original")).toBe(true);
    win.dispatchEvent(new win.PageTransitionEvent("pageshow", { persisted: true }));
    await until(() => leases >= 2);
    expect(bootstraps).toBe(2);
    expect(doc.querySelector(".ProseMirror")).toBe(editor);
    if (embedded) {
      const back = [...doc.querySelectorAll("button")].find(button => button.textContent === "Back to Example")!;
      expect(back).toBeDefined();
      back.click();
      await until(() => hostReturns === 1);
      expect(writes.filter(write => write.route === "api/draft").at(-1)?.body.body).toContain("My unsaved draft");
      expect(nativeRequests).toBe(0);
      expect(beacons).toBe(0);
    }
    expect(editor.textContent).toContain("My unsaved draft");
    expect(writes.some(write => write.route === "api/file")).toBe(false);
    expect(writes.filter(write => write.route === "api/draft").every(write => write.body.baseRevision === "original")).toBe(true);
    win.dispatchEvent(new win.PageTransitionEvent("pagehide", { persisted: true }));
    win.dispatchEvent(new win.PageTransitionEvent("pageshow", { persisted: true }));
    doc.querySelector<HTMLButtonElement>("#comment")!.click();
    expect(doc.querySelector("#comment")!.getAttribute("aria-pressed")).toBe("true");
    expect(doc.querySelector(".ProseMirror")).toBe(editor);
  } finally {
    win.dispatchEvent(new win.PageTransitionEvent("pagehide", { persisted: false }));
    win.close();
  }
});
