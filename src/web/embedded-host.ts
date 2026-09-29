/** Browser capabilities supplied by a trusted embedding host before Tether boots.
 * Authentication and file authorization remain the host server's responsibility.
 * This object carries no credential and never enables a network fallback.
 */
export type HostEventSource = Pick<EventSource, "addEventListener" | "onerror" | "close">;

export interface EmbeddedBrowserHost {
  version: 1;
  /** Logical session directory, including its trailing slash. */
  baseUrl: string;
  request(request: Request): Promise<Response>;
  events(url: string): HostEventSource;
  navigation: { label: string; returnToHost(): void | Promise<void>; openDocument?(launchUrl: string): void | Promise<void> };
}

/** Use the host's registered action; never derive navigation from a document URL. */
export function mountHostReturn(container: HTMLElement, navigation: EmbeddedBrowserHost["navigation"] | undefined,
    beforeReturn: () => Promise<void>, reportError: (message: string) => void, className = "button") {
  if (!navigation) return null;
  const button = container.ownerDocument.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = navigation.label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await beforeReturn(); await navigation.returnToHost(); }
    catch (cause) { reportError(cause instanceof Error ? cause.message : "Unable to return to the host."); }
    finally { button.disabled = false; }
  });
  container.prepend(button);
  return button;
}

export interface BrowserHostEnvironment {
  location: { href: string };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  EventSource?: new (url: string) => HostEventSource;
  tetherEmbeddedHost?: EmbeddedBrowserHost;
}

/** Self-contained because Folio embeds this function in its inline client. */
export function browserHostServices(environment: BrowserHostEnvironment = globalThis as unknown as BrowserHostEnvironment) {
  const host = environment.tetherEmbeddedHost;
  if (host !== undefined && (!host || host.version !== 1 || typeof host.request !== "function" ||
      typeof host.events !== "function" || typeof host.navigation?.returnToHost !== "function" ||
      typeof host.navigation.label !== "string" || !host.navigation.label.trim())) {
    throw new Error("Invalid Tether embedded host adapter");
  }
  const base = new URL(host ? host.baseUrl : environment.location.href);
  if (host && (!/^https?:$/.test(base.protocol) || base.username || base.password ||
      !base.pathname.endsWith("/") || base.search || base.hash)) {
    throw new Error("The embedded host must register an HTTP session directory");
  }
  function resolve(input: string | URL): string {
    const url = new URL(input, base);
    if (host && (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password)) {
      throw new Error("Request is outside the embedded host session");
    }
    return url.href;
  }
  return {
    resolve,
    navigation: host?.navigation,
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      return host ? host.request(new Request(resolve(input), init)) : environment.fetch(input, init);
    },
    openEvents(input: string | URL): HostEventSource | null {
      const url = resolve(input);
      return host ? host.events(url) : environment.EventSource ? new environment.EventSource(url) : null;
    },
  };
}
