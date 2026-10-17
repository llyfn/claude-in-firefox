export const SETTLE_START_MS = 500;
export const SETTLE_LOAD_MS = 10_000;

// The tab's url and title update shortly after the webNavigation events that report the load.
export async function tabShowing(api, tabId, url) {
  let tab = await api.tabs.get(tabId);
  for (let waited = 0; waited < 2000 && (tab.url !== url || tab.status !== "complete"); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    tab = await api.tabs.get(tabId);
  }
  return tab;
}

// Out-of-process iframes register their frame ids after the top-level load event.
export async function framesSettled(api, tabId) {
  const counted = await api.tabs.executeScript(tabId, { frameId: 0, code: 'document.querySelectorAll("iframe, frame").length' }).catch(() => null);
  const expected = counted?.[0];
  if (!(expected > 0)) return;
  for (let waited = 0; waited < 1000; waited += 50) {
    const frames = await api.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (!frames || frames.filter((f) => f.parentFrameId === 0).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  let wake = () => {};
  const top = (details) => details.tabId === tabId && details.frameId === 0;
  const onSameDocument = (details) => { if (top(details)) { sameDocument = details.url; wake(); } };
  const listeners = [
    [onBeforeNavigate, (details) => { if (top(details) && details.url !== "about:blank") { started = details.url; wake(); } }],
    [onHistoryStateUpdated, onSameDocument],
    [onReferenceFragmentUpdated, onSameDocument],
    [onCompleted, (details) => { if (top(details) && started) { finished = details.url; wake(); } }],
    [onErrorOccurred, (details) => { if (top(details) && started && details.error !== "NS_BINDING_ABORTED") { finished = details.url; wake(); } }],
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
        await until(() => started || sameDocument, startMs);
        if (!started) return sameDocument ? `→ URL changed to ${sameDocument}` : "";
        await until(() => finished, loadMs);
        if (!finished) return `→ Still loading after ${loadMs / 1000}s: ${started}`;
        const tab = await tabShowing(api, tabId, finished);
        await framesSettled(api, tabId);
        return `→ Navigated to ${tab.url} — "${tab.title}"`;
      } finally {
        stop();
      }
    },
  };
}
