import { createActivity } from "./activity.js";
import { createContent } from "./content.js";
import { createDispatcher } from "./dispatch.js";
import { connectNative } from "./native.js";
import { createSessions } from "./sessions.js";
import { pageTools } from "./tools/page.js";
import { tabTools } from "./tools/tabs.js";

const api = browser;
const content = createContent(api);
const sessions = createSessions(api);
const activity = createActivity({ api, content });

api.tabs.onCreated.addListener((tab) => {
  sessions.adoptOpened(tab).catch(() => {});
});

const tools = {
  ...tabTools({ api, sessions }),
  ...pageTools({ content }),
};

let native = null;
const dispatch = createDispatcher({ tools, sessions, activity, send: (msg) => native.send(msg) });
native = connectNative({ api, name: "claude_firefox_bridge", onMessage: dispatch });
