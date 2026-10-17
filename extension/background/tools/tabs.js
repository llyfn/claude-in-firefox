import { framesSettled, tabShowing, waitForNavigation } from "../navigation.js";

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
      run: ({ tab, args, signal }) => navigate(api, tab, args.url, signal),
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

async function navigate(api, tab, url, signal) {
  if (typeof url !== "string" || !url.trim()) throw new Error("navigate: url is required");
  const finished = waitForNavigation(api, tab.id, NAVIGATION_TIMEOUT_MS, url === "back" || url === "forward" || url.trim() === "about:blank", signal);
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
