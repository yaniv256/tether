# Browser embedding contract

An embedding host can supply Tether's browser transport and a return action without replacing browser globals. Install `globalThis.tetherEmbeddedHost` before the editor bundle or Folio client executes. The exported `EmbeddedBrowserHost` type in `src/web/embedded-host.ts` defines version 1 of this contract.

The host supplies:

- `baseUrl`: an absolute HTTP(S) logical session directory with a trailing slash and no credentials, query, or fragment. It may describe a virtual route. Requests are resolved within this directory and cannot escape to another origin or session path.
- `request(Request)`: return a standard `Response`, carrying the request method, headers, body, and abort signal through the host transport. The editor, Folio, update controls, and embedded release request use this transport. Handle cancellation without claiming it undoes an already accepted mutation.
- `events(url)`: return an event source implementing `addEventListener`, `onerror`, and `close`. Preserve Folio's `snapshot` and `theme` event payloads, reconnect behavior, and cleanup. The host owns the underlying connection.
- `navigation`: a plain-text button label and a registered `returnToHost()` callback. The editor attempts to persist its draft before returning. If that fails, the view stays open and reports the error through its existing notice.
- `navigation.openDocument(launchUrl)`: required when the embedded Folio or a local Markdown link opens another editor. The host consumes the single-use launch ticket through its trusted transport, retains the scoped session cookie outside browser-visible state, installs a fresh browser adapter for the new session, and changes the visible view. Do not put the ticket in an address bar or server log.

The adapter is trusted host code, not document content or URL parameters. Tether does not derive a return destination from a query string. A malformed adapter fails at startup. A failed host request never falls back to a native network request. When no adapter is installed, standalone browser behavior uses native fetch and EventSource and has no host-return button.

This is a browser transport contract, not a server authorization layer. The host must authenticate each user and enforce the selected agent, document scope, and operation on the server. Browser URL checks are only an additional guard. Do not expose Tether's local control credential to the browser or assume that installing this adapter makes the local daemon safe for remote access. Server embedding, principal/profile isolation, and file-grant enforcement must be integrated before serving an embedded deployment.

The opt-in `DaemonOptions.embeddedHost` server seam takes a fixed `principal` for one isolated profile, `authenticate(request)` for every browser request, and `authorizeDocument(principal, canonicalPath, method)` for every document launch and session request. Authentication and grants must be checked by trusted host code; client headers are not themselves identity. A denied or revoked grant blocks existing document sessions. The local control token remains private to the host. `authorizeFolio(principal, method)` explicitly grants the entire profile, including Folio list, events, and profile-wide mutations; omitting it denies Folio. Hosts with only folder or document grants can open those documents directly without granting Folio. In embedded mode, Folio and local Markdown links return a launch ticket for the host's `openDocument` callback instead of asking an operating-system browser to open the local daemon URL.

On Windows, the host must place the runtime and config directories under an access-controlled user profile, not a shared temporary directory. Windows `stat().mode` does not describe the file ACL, so Tether's POSIX permission check cannot validate the control token there. The host is responsible for the Windows ACL that protects the profile and token.

Every editor or Folio view opened by the host must install the adapter for that view's logical session. The host also supplies the corresponding static assets and preserves its connection across view navigation. Do not rely on the adapter surviving a normal page reload unless the host reinstalls it.

`tests/embedded-host.test.ts` checks the transport and navigation contract. The embedded Folio case in `tests/folio-page.test.ts` renders the real inline client with native network access disabled and verifies snapshots, live events, return navigation, and event cleanup.
