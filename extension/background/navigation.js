export const SETTLE_START_MS = 500;
export const SETTLE_LOAD_MS = 10_000;
const TAB_CLOSED = "→ The tab closed";

// The tab's url and title update shortly after the webNavigation events that report the load.
export async function tabShowing(api, tabId, url) {
  let tab = await api.tabs.get(tabId);
  for (let waited = 0; waited < 2000 && (tab.url !== url || tab.status !== "complete"); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    tab = await api.tabs.get(tabId);
  }
  return tab;
}

// Evaluates to [frames, navigating]: the page's frames, and those expected to leave the initial about:blank. Frames without a src stay blank, and lazy ones load only when scrolled into view.
const COUNT_FRAMES = `(() => {
  const frames = [...document.querySelectorAll("iframe, frame")];
  const navigating = frames.filter((f) => f.getAttribute("loading")?.toLowerCase() !== "lazy" && (f.hasAttribute("srcdoc") || !/^\\s*(about:blank)?\\s*$/i.test(f.getAttribute("src") ?? "")));
  return [frames.length, navigating.length];
})()`;

// The content router answers every op, unknown ones with an error, once the frame's content scripts run.
function answers(api, tabId, frameId, timeoutMs) {
  let timer;
  return Promise.race([
    api.tabs.sendMessage(tabId, { op: "ping" }, { frameId }).then(() => true, () => false),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, false); }),
  ]).finally(() => clearTimeout(timer));
}

// Out-of-process iframes register their frame ids after the top-level load event, can still show the initial about:blank then,
// and once loaded, can take a moment before their content scripts listen. Until then nothing can be injected into them.
export async function framesSettled(api, tabId) {
  const counted = await api.tabs.executeScript(tabId, { frameId: 0, code: COUNT_FRAMES }).catch(() => null);
  const [expected, navigating] = counted?.[0] ?? [];
  if (!(expected > 0)) return;
  for (const end = Date.now() + 1000; Date.now() < end;) {
    const frames = await api.webNavigation.getAllFrames({ tabId }).catch(() => null);
    const children = frames?.filter((f) => f.parentFrameId === 0);
    if (!children) return;
    if (children.length >= expected) {
      const loaded = children.filter((f) => f.url !== "about:blank");
      const timeoutMs = Math.min(250, end - Date.now());
      const ready = await Promise.all(loaded.map((f) => answers(api, tabId, f.frameId, timeoutMs)));
      if (ready.filter(Boolean).length >= navigating) return;
    }
    const left = end - Date.now();
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, left)));
  }
}

export function waitForNavigation(api, tabId, timeoutMs, acceptBlank, signal) {
  const { onBeforeNavigate, onCompleted, onErrorOccurred, onHistoryStateUpdated, onReferenceFragmentUpdated } = api.webNavigation;
  return new Promise((resolve) => {
    // Events from the page loaded before this navigation can still be in flight (a new tab's about:blank load), so loads only count after their onBeforeNavigate and a blank page only counts when blank was requested. Firefox aborts and restarts the load when it switches process, reporting NS_BINDING_ABORTED in between.
    let started = false;
    const mine = (details) => details.tabId === tabId && details.frameId === 0 && (acceptBlank || details.url !== "about:blank");
    const onStart = (details) => { if (mine(details)) started = true; };
    const onSameDocument = (details) => { if (mine(details)) finish(details.url); };
    const onLoadEnd = (details) => { if (started && mine(details)) finish(details.url); };
    const onError = (details) => { if (details.error !== "NS_BINDING_ABORTED") onLoadEnd(details); };
    const onAbort = () => finish(null);
    const listeners = [[onBeforeNavigate, onStart], [onHistoryStateUpdated, onSameDocument], [onReferenceFragmentUpdated, onSameDocument], [onCompleted, onLoadEnd], [onErrorOccurred, onError]];
    const finish = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const [event, listener] of listeners) event.removeListener(listener);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    for (const [event, listener] of listeners) event.addListener(listener);
    if (signal?.aborted) finish(null);
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Listening starts before the action runs, so a navigation the action triggers synchronously is not missed.
export function watchNavigation(api, tabId, { signal, startMs = SETTLE_START_MS, loadMs = SETTLE_LOAD_MS } = {}) {
  const { onBeforeNavigate, onCompleted, onErrorOccurred, onHistoryStateUpdated, onReferenceFragmentUpdated } = api.webNavigation;
  let started = null;
  let finished = null;
  let sameDocument = null;
  let closed = false;
  let wake = () => {};
  const top = (details) => details.tabId === tabId && details.frameId === 0;
  const onSameDocument = (details) => { if (top(details)) { sameDocument = details.url; wake(); } };
  const listeners = [
    [onBeforeNavigate, (details) => { if (top(details) && details.url !== "about:blank") { started = details.url; wake(); } }],
    [onHistoryStateUpdated, onSameDocument],
    [onReferenceFragmentUpdated, onSameDocument],
    [onCompleted, (details) => { if (top(details) && started) { finished = details.url; wake(); } }],
    [onErrorOccurred, (details) => { if (top(details) && started && details.error !== "NS_BINDING_ABORTED") { finished = details.url; wake(); } }],
    [api.tabs.onRemoved, (removedId) => { if (removedId === tabId) { closed = true; wake(); } }],
  ];
  for (const [event, listener] of listeners) event.addListener(listener);
  const stop = () => { for (const [event, listener] of listeners) event.removeListener(listener); };

  const until = (ready, ms) => new Promise((resolve) => {
    if (ready() || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      wake = () => {};
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake = () => { if (ready()) done(); };
    signal?.addEventListener("abort", done, { once: true });
  });

  return {
    stop,
    async settle() {
      try {
        await until(() => started || sameDocument || closed, startMs);
        if (closed) return TAB_CLOSED;
        if (!started) return sameDocument ? `→ URL changed to ${sameDocument}` : "";
        await until(() => finished || closed, loadMs);
        if (closed) return TAB_CLOSED;
        if (!finished) return `→ Still loading after ${loadMs / 1000}s: ${started}`;
        const tab = await tabShowing(api, tabId, finished).catch(() => null);
        if (!tab) return TAB_CLOSED;
        await framesSettled(api, tabId);
        return `→ Navigated to ${tab.url} — "${tab.title}"`;
      } finally {
        stop();
      }
    },
  };
}
