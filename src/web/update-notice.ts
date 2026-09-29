import type { AgentSkillReview } from "../cli/agent-skills";

/** Serialized into the standalone Folio page; keep this function self-contained. */
export function mountUpdateNotice(element: HTMLElement, api: string, reportError?: (message: string) => void, beforeInstall?: () => Promise<void>, reload = true, menuCheck?: HTMLButtonElement, packageButton?: HTMLButtonElement, request: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): void {
  let popupOpen = false;
  const closePopup = () => {
    popupOpen = false;
    packageButton?.setAttribute("aria-expanded", "false");
    if (element.hasAttribute("data-update-popover")) element.hidden = true;
  };
  if (packageButton) {
    packageButton.onclick = () => {
      popupOpen = !popupOpen; element.hidden = !popupOpen;
      packageButton.setAttribute("aria-expanded", String(popupOpen));
    };
    document.addEventListener("pointerdown", event => {
      if (event.target instanceof Node && !element.contains(event.target) && !packageButton.contains(event.target)) closePopup();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && popupOpen) { closePopup(); packageButton.focus(); }
    });
  }
  let pending = false;
  let installing = false;
  let started = 0;
  let reviewDialog: HTMLDialogElement | undefined;
  let finishReview: (() => void) | undefined;
  const message = (text: string) => { element.hidden = false; element.textContent = text; };
  const post = async (action: string, tag: string) => {
    const response = await request(`${api}/updates/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag }) });
    if (!response.ok) throw new Error("Update action failed");
  };
  const skillRequest = async (action: string, body?: unknown) => {
    const response = await request(`${api}/updates/skills${action}`, { cache: "no-store", ...(body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? "Could not review agent instructions. Try again.");
    return result;
  };
  const openReviews = async () => {
    if (reviewDialog) { reviewDialog.focus(); return; }
    const dialog = document.createElement("dialog");
    reviewDialog = dialog;
    dialog.setAttribute("aria-label", "Review agent instructions");
    dialog.className = "tether-skill-review";
    const style = document.createElement("style");
    style.textContent = `
      .tether-skill-review{--review-bg:var(--wm-page-background,var(--bg,Canvas));--review-text:var(--wm-page-color,var(--text,CanvasText));--review-panel:var(--wm-color-surface,var(--panel,Canvas));--review-line:var(--wm-color-outline,var(--line,GrayText));--review-accent:var(--wm-color-primary,var(--accent,Highlight));width:min(880px,90vw);max-height:85vh;overflow:auto;box-sizing:border-box;border:1px solid var(--review-line);border-radius:12px;padding:24px;background:var(--review-bg);color:var(--review-text);font:inherit;font-family:var(--wm-font-body,inherit);font-size:14px;line-height:1.5;box-shadow:0 16px 48px #0004}
      .tether-skill-review::backdrop{background:#0005}
      .tether-skill-review h2{font-family:var(--wm-font-heading,inherit);font-size:20px;margin:0 32px 12px 0}.tether-skill-review h3{font-size:14px;margin:0 0 8px}.tether-skill-review p{margin:8px 0 16px}
      .tether-skill-review button{font:inherit;color:inherit;background:var(--review-panel);border:1px solid var(--review-line);border-radius:7px;padding:8px 12px;cursor:pointer}
      .tether-skill-review button:hover{border-color:var(--review-accent)}.tether-skill-review button:focus-visible{outline:2px solid var(--review-accent);outline-offset:2px}.tether-skill-review button:disabled{opacity:.55;cursor:default}
      .tether-skill-review button[data-copied]{background:color-mix(in srgb,var(--review-accent) 30%,var(--review-bg));border-color:var(--review-accent);color:var(--review-text)}
      .tether-skill-review .review-close{position:absolute;right:16px;top:16px;padding:2px 9px;background:transparent;border:0;font-size:20px}
      .tether-skill-review .review-card + .review-card{border-top:1px solid var(--review-line);margin-top:20px;padding-top:20px}
      .tether-skill-review .review-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tether-skill-review summary{cursor:pointer;color:var(--review-accent)}
      .tether-skill-review .review-comparison{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr));gap:16px;margin-top:12px}
      .tether-skill-review pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;font:12px/1.5 ui-monospace,monospace;padding:12px;border:1px solid var(--review-line);border-radius:7px;background:var(--review-panel)}
    `;
    const title = document.createElement("h2"); title.textContent = "Review agent instructions";
    const explanation = document.createElement("p"); explanation.textContent = "Tether has updated instructions. Accept them, keep your copy, or work through a merge with your agent. Your app update can finish either way.";
    const status = document.createElement("p"); status.setAttribute("role", "status");
    const content = document.createElement("div");
    finishReview = () => { content.replaceChildren(); status.textContent = "All agent instructions have been reviewed."; };
    const close = document.createElement("button"); close.textContent = "×"; close.setAttribute("aria-label", "Close"); close.className = "review-close"; close.onclick = () => dialog.close();
    dialog.append(style, title, explanation, status, content, close);
    dialog.addEventListener("close", () => { dialog.remove(); reviewDialog = undefined; finishReview = undefined; element.querySelector<HTMLButtonElement>("[data-skill-review]")?.focus(); });
    document.body.append(dialog); dialog.showModal();
    let busy = false;
    const button = (label: string, action: () => Promise<void>) => {
      const node = document.createElement("button"); node.type = "button"; node.textContent = label;
      node.onclick = async () => {
        if (busy) return;
        busy = true; status.textContent = "";
        const buttons = [...content.querySelectorAll("button")]; buttons.forEach(item => item.disabled = true);
        try { await action(); } catch (cause) { status.textContent = (cause as Error).message; }
        finally { busy = false; buttons.forEach(item => item.disabled = false); }
      };
      return node;
    };
    const list = async () => {
      const entries: Array<{ id: string; path: string }> = await skillRequest("");
      const reviews: AgentSkillReview[] = await Promise.all(entries.map(entry => skillRequest("/read", { id: entry.id })));
      content.replaceChildren();
      if (!reviews.length) { status.textContent = "All agent instructions have been reviewed."; return; }
      for (const review of reviews) {
        const card = document.createElement("section"); card.className = "review-card"; card.dataset.skillId = review.id;
        if (reviews.length > 1) {
          const parts = review.path.split("/").filter(Boolean);
          const location = parts.includes(".codex") ? "Codex" : parts.includes(".claude") ? "Claude Code" : parts.at(-3) ?? "Installed copy";
          const heading = document.createElement("h3"); heading.textContent = `${parts.at(-2) ?? "Agent instructions"} — ${location}`; heading.title = review.path; card.append(heading);
        }
        const decide = async (action: string) => {
          await skillRequest("/decide", { id: review.id, revision: review.revision, action });
          await list(); await check();
        };
        const merge = button("Ask my agent to merge", async () => {
          await navigator.clipboard.writeText(review.mergePrompt);
          merge.textContent = "Prompt copied — paste in agent chat";
          merge.dataset.copied = "true";
        });
        const actions = document.createElement("div"); actions.className = "review-actions";
        actions.append(button("Accept new version", () => decide("replace")), button("Keep old version", () => decide("keep")), merge);
        const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "Compare instructions";
        const comparison = document.createElement("div"); comparison.className = "review-comparison";
        for (const [label, text] of [["Your installed instructions", review.current], ["Updated instructions", review.proposed]]) {
          const section = document.createElement("section"), heading = document.createElement("h3"), pre = document.createElement("pre");
          heading.textContent = label!; pre.textContent = text!; section.append(heading, pre); comparison.append(section);
        }
        details.append(summary, comparison); card.append(actions, details); content.append(card);
      }
    };
    try { await list(); } catch (cause) {
      status.textContent = (cause as Error).message;
      content.append(button("Retry", list));
    }
  };
  let forceQueued = false;
  let quietFailure = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let last: any;
  const action = (label: string, run: () => void) => {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.onclick = run; return node;
  };
  const show = (text: string, ...actions: HTMLElement[]) => {
    clearTimeout(hideTimer);
    if (packageButton) { element.removeAttribute("data-update-popover"); closePopup(); }
    element.hidden = false;
    element.replaceChildren(document.createTextNode(text));
    actions.forEach((node, index) => element.append(index ? " | " : "", node));
  };
  const retry = (label: string) => action(label, () => void check(true));
  const settle = () => action("Dismiss", () => { quietFailure = true; render(last, false); });
  const syncPackage = (state: any) => {
    if (!packageButton) return;
    packageButton.hidden = !state.available;
    element.toggleAttribute("data-update-popover", Boolean(state.available || state.installing));
    if (!state.available && !state.installing) closePopup();
  };
  const render = (state: any, force: boolean) => {
    clearTimeout(hideTimer);
    if (!state) { element.hidden = true; element.replaceChildren(); return; }
    syncPackage(state);
    const update = state.available;
    const skillNotice = state.agentSkillReviewNeeded ? "Agent instructions need review. " : "";
    const addSkillReview = () => {
      if (!state.agentSkillReviewNeeded) return;
      const review = document.createElement("button"); review.textContent = "Review agent instructions"; review.dataset.skillReview = "";
      review.onclick = () => void openReviews(); element.append(" ", review);
    };
    if (!update) {
      const hide = () => { element.hidden = true; element.replaceChildren(); };
      if (!state.managed && !skillNotice) { hide(); return; }
      const failing = state.checkError && (force || (state.prolongedFailure && !quietFailure));
      const text = state.failed ? "The last Tether update failed. Run tether doctor for details. "
        : force && state.unavailableReason ? `Tether can't check for updates on this installation. ${state.unavailableReason} `
        : failing ? `${force ? "Couldn't check for updates." : "Tether hasn't been able to check for updates for two days."} ${state.checkError} `
        : force ? `Tether${state.version ? ` ${state.version}` : ""} is up to date. ` : "";
      if (!skillNotice && !text) { hide(); return; }
      element.hidden = false;
      element.replaceChildren(document.createTextNode(skillNotice + text));
      const ok = () => action("OK", () => render(last, false));
      if (!state.failed && failing) element.append(retry(force ? "Try again" : "Check now"), " | ", settle());
      else if (text && force) {
        element.append(ok());
        if (!state.unavailableReason) hideTimer = setTimeout(() => render(last, false), 8000);
      }
      addSkillReview();
      return;
    }
    if (force && packageButton) { popupOpen = true; packageButton.setAttribute("aria-expanded", "true"); }
    element.hidden = packageButton ? !popupOpen : false;
    element.replaceChildren(document.createTextNode(skillNotice), document.createTextNode(state.failed ? "Update failed. " : ""), document.createTextNode(`Tether update available: version ${update.version}. `));
    const install = document.createElement("button");
    install.textContent = "Install";
    install.onclick = async () => {
      install.disabled = true;
      installing = true;
      started = Date.now();
      message("Installing Tether update…");
      try { await beforeInstall?.(); await post("install", update.tag); }
      catch { installing = false; (reportError ?? message)("Could not start update. Try again shortly."); }
      void check();
    };
    const notes = document.createElement("a");
    notes.textContent = "Release Notes";
    notes.href = update.notes;
    notes.target = "_blank";
    notes.rel = "noopener noreferrer";
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      try { await post("dismiss", update.tag); element.hidden = true; await check(); }
      catch { dismiss.disabled = false; (reportError ?? message)("Could not dismiss the update notice. Try again shortly."); }
    };
    element.append(notes, " | ", install, " | ", dismiss);
    addSkillReview();
  };
  const check = async (force = false) => {
    // A manual check always answers, even when a background check is in flight.
    if (force) { quietFailure = false; show("Checking for updates…"); }
    if (pending) { forceQueued ||= force; return; }
    if (document.hidden && !force) return;
    pending = true;
    try {
      const response = await request(`${api}/updates${force ? "/check" : ""}`, { cache: "no-store", ...(force ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {}), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("Unavailable");
      const state = await response.json();
      last = state;
      if (!state.agentSkillReviewNeeded) finishReview?.();
      if (menuCheck) menuCheck.hidden = !state.managed;
      // A queued manual check renders its own, fresher answer.
      if (forceQueued && !state.installing) return;
      if (state.installing) {
        syncPackage(state);
        installing = true; started ||= Date.now(); message("Installing Tether update…"); return;
      }
      if (installing) {
        installing = false;
        if (!state.failed && !state.available) {
          if (reload) { location.reload(); return; }
          message("Tether updated. Your document remains open.");
          if (!state.agentSkillReviewNeeded) return;
        }
      }
      render(state, force);
    } catch {
      if (installing && Date.now() - started > 300_000) message("Update is taking longer. Run tether to reconnect.");
      // Failed passive checks never interrupt work or erase an existing notice.
      else if (force) show("Couldn't reach Tether to check for updates. Run tether to reconnect. ", retry("Try again"), settle());
    } finally {
      pending = false;
      if (forceQueued) { forceQueued = false; void check(true); }
    }
  };
  if (menuCheck) menuCheck.onclick = () => void check(true);
  void check();
  setInterval(() => { if (installing) void check(); }, 2000);
  setInterval(() => void check(), 60_000);
  addEventListener("pageshow", () => void check());
  document.addEventListener("visibilitychange", () => void check());
}
