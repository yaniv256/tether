import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { browserHostServices, mountHostReturn, type BrowserHostEnvironment, type EmbeddedBrowserHost } from "../src/web/embedded-host";

function fixture(embedded = true) {
  const requests: Request[] = [];
  let nativeCalls = 0;
  let returned = 0;
  let closed = false;
  const eventUrls: string[] = [];
  const stream = { addEventListener() {}, onerror: null, close() { closed = true; } };
  const host: EmbeddedBrowserHost = {
    version: 1,
    baseUrl: "https://host.invalid/review/s/document/",
    request: async request => { requests.push(request); return new Response("host response"); },
    events: url => { eventUrls.push(url); return stream; },
    navigation: { label: "Back to Example", returnToHost() { returned++; } },
  };
  const environment: BrowserHostEnvironment = {
    location: { href: "https://standalone.invalid/s/local/?returnTo=https://untrusted.invalid" },
    fetch: async () => { nativeCalls++; return new Response("native response"); },
    ...(embedded ? { tetherEmbeddedHost: host } : {}),
  };
  return { host, environment, requests, eventUrls, stream,
    nativeCalls: () => nativeCalls, returned: () => returned, closed: () => closed };
}

test("standalone keeps native requests and ignores URL-supplied return navigation", async () => {
  const f = fixture(false);
  const services = browserHostServices(f.environment);
  expect(await (await services.fetch("api/file")).text()).toBe("native response");
  expect(f.nativeCalls()).toBe(1);
  expect(services.resolve("api/file")).toBe("https://standalone.invalid/s/local/api/file");
  expect(services.navigation).toBeUndefined();
  expect(services.openEvents("api/events")).toBeNull();
});

test("embedded requests preserve method, body, headers and cancellation through host transport", async () => {
  const f = fixture();
  const services = browserHostServices(f.environment);
  const abort = new AbortController();
  const result = await services.fetch("api/body", {
    method: "POST", body: "markdown", headers: { "content-type": "text/plain" }, signal: abort.signal,
  });
  expect(await result.text()).toBe("host response");
  expect(f.nativeCalls()).toBe(0);
  const request = f.requests[0]!;
  expect(request.url).toBe("https://host.invalid/review/s/document/api/body");
  expect(request.method).toBe("POST");
  expect(request.headers.get("content-type")).toBe("text/plain");
  expect(await request.text()).toBe("markdown");
  abort.abort();
  expect(request.signal.aborted).toBe(true);
});

test("transport errors do not fall back to a plaintext network request", async () => {
  const f = fixture();
  f.host.request = async () => { throw new Error("host disconnected"); };
  await expect(browserHostServices(f.environment).fetch("api/file")).rejects.toThrow("host disconnected");
  expect(f.nativeCalls()).toBe(0);
});

test("embedded requests cannot leave the host-registered session URL", async () => {
  const f = fixture();
  const services = browserHostServices(f.environment);
  for (const path of ["https://other.invalid/api/file", "../other/api/file", "/control/status", "api/%2e%2e/%2e%2e/other"]) {
    await expect(services.fetch(path)).rejects.toThrow("session");
  }
  expect(f.requests).toHaveLength(0);
  expect(f.nativeCalls()).toBe(0);
});

test("host owns event lifecycle and return action", () => {
  const f = fixture();
  const services = browserHostServices(f.environment);
  const source = services.openEvents("api/events");
  expect(source).toBe(f.stream);
  expect(f.eventUrls).toEqual(["https://host.invalid/review/s/document/api/events"]);
  source!.close();
  expect(f.closed()).toBe(true);
  expect(services.navigation!.label).toBe("Back to Example");
  services.navigation!.returnToHost();
  expect(f.returned()).toBe(1);
});

test("an incomplete or unsupported host fails at startup", () => {
  const f = fixture();
  for (const invalid of [{}, { ...f.host, version: 2 }, { ...f.host, request: undefined },
    { ...f.host, events: undefined }, { ...f.host, baseUrl: "javascript:alert(1)" },
    { ...f.host, baseUrl: "https://host.invalid/review" }, { ...f.host, navigation: undefined }]) {
    expect(() => browserHostServices({ ...f.environment, tetherEmbeddedHost: invalid as EmbeddedBrowserHost })).toThrow();
  }
  expect(f.nativeCalls()).toBe(0);
});

test("return navigation waits for saved draft and stays put on failure", async () => {
  const dom = new JSDOM("<header></header>");
  try {
    let returned = false;
    let failSave = true;
    const errors: string[] = [];
    const navigation = { label: "Back <img src=x>", returnToHost() { returned = true; } };
    const button = mountHostReturn(dom.window.document.querySelector("header")!, navigation,
      async () => { if (failSave) throw new Error("Draft was not saved"); }, message => errors.push(message))!;
    expect(button.textContent).toBe(navigation.label);
    expect(button.querySelector("img")).toBeNull();
    button.click();
    await Bun.sleep(0);
    expect(returned).toBe(false);
    expect(errors).toEqual(["Draft was not saved"]);
    expect(button.disabled).toBe(false);
    failSave = false;
    button.click();
    await Bun.sleep(0);
    expect(returned).toBe(true);
  } finally { dom.window.close(); }
});
