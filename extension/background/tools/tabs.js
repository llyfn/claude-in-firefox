const NAVIGATION_TIMEOUT_MS = 15_000;
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:about|data|javascript|view-source|moz-extension|file):)/i;

export const withScheme = (url) => (HAS_SCHEME.test(url) ? url : `https://${url}`);

export function tabTools({ api, sessions }) {
  return {
    tabs_context: {
      tabScoped: false,
      async run({ sessionId, args }) {
        const context = await sessions.context(sessionId, { createIfEmpty: args.createIfEmpty === true });
        return context ? JSON.stringify(context) : "This session has no tab group yet. Call tabs_context with createIfEmpty: true to create one.";
      },
    },
    tabs_create: {
      tabScoped: false,
      async run({ sessionId }) {
        const tab = await sessions.createTab(sessionId);
        return `Created tab ${tab.id}`;
      },
    },
    tabs_close: {
      tabScoped: true,
      async run({ tab }) {
        await api.tabs.remove(tab.id);
        return `Closed tab ${tab.id}`;
      },
    },
    navigate: {
      tabScoped: true,
      run: ({ tab, args }) => navigate(api, tab, args.url),
    },
    resize_window: {
      tabScoped: true,
      async run({ tab, args }) {
        const width = Math.round(Number(args.width));
        const height = Math.round(Number(args.height));
        if (!(width >= 100 && width <= 7680 && height >= 100 && height <= 4320)) throw new Error("resize_window: width must be 100-7680 and height 100-4320");
        await api.windows.update(tab.windowId, { state: "normal", width, height });
        return `Resized window to ${width}x${height}`;
      },
    },
  };
}

async function navigate(api, tab, url) {
  if (typeof url !== "string" || !url.trim()) throw new Error("navigate: url is required");
  const finished = waitForNavigation(api, tab.id, NAVIGATION_TIMEOUT_MS, url === "back" || url === "forward" || url.trim() === "about:blank");
  if (url === "back") await api.tabs.goBack(tab.id);
  else if (url === "forward") await api.tabs.goForward(tab.id);
  else await api.tabs.update(tab.id, { url: withScheme(url) });
  const loadedUrl = await finished;
  if (!loadedUrl) {
    const now = await api.tabs.get(tab.id);
    return `Navigation to ${now.url} started but the page is still loading after 15s`;
  }
  const now = await tabShowing(api, tab.id, loadedUrl);
  await framesSettled(api, tab.id);
  return `Navigated to ${now.url} — "${now.title}"`;
}

// The tab's url and title update shortly after the webNavigation events that report the load.
async function tabShowing(api, tabId, url) {
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

function waitForNavigation(api, tabId, timeoutMs, acceptBlank) {
  const { onBeforeNavigate, onCompleted, onErrorOccurred, onHistoryStateUpdated, onReferenceFragmentUpdated } = api.webNavigation;
  return new Promise((resolve) => {
    // Events from the page loaded before this navigation can still be in flight (a new tab's about:blank load), so loads only count after their onBeforeNavigate and a blank page only counts when blank was requested. Firefox aborts and restarts the load when it switches process, reporting NS_BINDING_ABORTED in between.
    let started = false;
    const mine = (details) => details.tabId === tabId && details.frameId === 0 && (acceptBlank || details.url !== "about:blank");
    const onStart = (details) => { if (mine(details)) started = true; };
    const onSameDocument = (details) => { if (mine(details)) finish(details.url); };
    const onLoadEnd = (details) => { if (started && mine(details)) finish(details.url); };
    const onError = (details) => { if (details.error !== "NS_BINDING_ABORTED") onLoadEnd(details); };
    const listeners = [[onBeforeNavigate, onStart], [onHistoryStateUpdated, onSameDocument], [onReferenceFragmentUpdated, onSameDocument], [onCompleted, onLoadEnd], [onErrorOccurred, onError]];
    const finish = (value) => {
      clearTimeout(timer);
      for (const [event, listener] of listeners) event.removeListener(listener);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    for (const [event, listener] of listeners) event.addListener(listener);
  });
}
