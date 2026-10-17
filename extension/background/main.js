import { createActivity } from "./activity.js";
import { createCapture } from "./capture.js";
import { createContent } from "./content.js";
import { createControl } from "./control.js";
import { createDispatcher } from "./dispatch.js";
import { createLogStore, installLogListeners } from "./logs.js";
import { connectNative } from "./native.js";
import { createPresence } from "./presence.js";
import { createSessions } from "./sessions.js";
import { logTools } from "./tools/logs.js";
import { pageTools } from "./tools/page.js";
import { computerTool } from "./tools/computer.js";
import { tabTools } from "./tools/tabs.js";

const api = browser;
const content = createContent(api);
const sessions = createSessions(api);
const activity = createActivity({ api, content });
const capture = createCapture({ api, content });
const presence = createPresence({ api, content, sessions });
const control = createControl({ sessions, onChange: (sessionId) => presence.refreshSession(sessionId), onClosed: (tabs) => presence.refreshTabs(tabs) });
const store = createLogStore();
installLogListeners(api, store);
presence.install();

api.tabs.onCreated.addListener((tab) => {
  sessions.adoptOpened(tab).catch(() => {});
});
api.windows.onRemoved.addListener((windowId) => sessions.windowRemoved(windowId));
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "indicator.query" && sender.tab) return presence.stateFor(sender.tab).then((state) => ({ state }));
  if (msg?.type !== "control" || !sender.tab) return undefined;
  sessions.sessionOfTab(sender.tab).then((sessionId) => {
    if (!sessionId) return undefined;
    return msg.action === "resume" ? control.resume(sessionId) : control.stop(sessionId);
  }).catch(() => {});
  return undefined;
});

const tools = {
  ...tabTools({ api, sessions }),
  ...pageTools({ api, content }),
  ...computerTool({ api, content, capture }),
  ...logTools({ store }),
};

let native = null;
const dispatch = createDispatcher({ tools, sessions, activity, control, send: (msg) => native.send(msg) });
native = connectNative({ api, name: "claude_firefox_bridge", onMessage: dispatch });
