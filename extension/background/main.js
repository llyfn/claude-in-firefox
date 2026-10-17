import { createActivity } from "./activity.js";
import { createCapture } from "./capture.js";
import { createContent } from "./content.js";
import { createControl } from "./control.js";
import { createDialogLog } from "./dialogs.js";
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
const sessions = createSessions(api, { onLoaded: (sessionId) => { presence.refreshSession(sessionId).catch(() => {}); } });
const activity = createActivity({ api, content });
const capture = createCapture({ api, content });
const presence = createPresence({ api, content, sessions });
const control = createControl({ sessions, onChange: (sessionId) => presence.refreshSession(sessionId), onClosed: (tabs) => presence.refreshTabs(tabs) });
const store = createLogStore();
const dialogs = createDialogLog();
installLogListeners(api, store);
presence.install();

api.tabs.onCreated.addListener((tab) => {
  sessions.adoptOpened(tab).catch(() => {});
});
api.tabs.onRemoved.addListener((tabId) => dialogs.removeTab(tabId));
api.windows.onRemoved.addListener((windowId) => {
  sessions.windowRemoved(windowId).then((tabs) => presence.refreshTabs(tabs)).catch(() => {});
});
api.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return undefined;
  if (msg?.type === "dialog") {
    sessions.sessionOfTab(sender.tab).then((sessionId) => {
      if (sessionId) dialogs.add(sender.tab.id, sessionId, msg);
    }).catch(() => {});
  }
  if (msg?.type === "dialogs.query") return presence.dialogsEnabled(sender.tab).then((on) => ({ on }));
  if (msg?.type === "indicator.query") return presence.stateFor(sender.tab).then((state) => ({ state }));
  if (msg?.type === "control") {
    sessions.sessionOfTab(sender.tab).then((sessionId) => {
      if (!sessionId) return undefined;
      return msg.action === "resume" ? control.resume(sessionId) : control.stop(sessionId);
    }).catch(() => {});
  }
  return undefined;
});

const tools = {
  ...tabTools({ api, sessions }),
  ...pageTools({ api, content }),
  ...computerTool({ api, content, capture }),
  ...logTools({ store }),
};

let native = null;
const dispatch = createDispatcher({ tools, sessions, activity, control, dialogs, send: (msg) => native.send(msg) });
native = connectNative({ api, name: "claude_firefox_bridge", onMessage: dispatch });
