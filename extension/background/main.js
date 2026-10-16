import { createActivity } from "./activity.js";
import { createCapture } from "./capture.js";
import { createContent } from "./content.js";
import { createDispatcher } from "./dispatch.js";
import { connectNative } from "./native.js";
import { createSessions } from "./sessions.js";
import { pageTools } from "./tools/page.js";
import { computerTool } from "./tools/computer.js";
import { javascriptTool } from "./tools/javascript.js";
import { tabTools } from "./tools/tabs.js";

const api = browser;
const content = createContent(api);
const sessions = createSessions(api);
const activity = createActivity({ api, content });
const capture = createCapture({ api, content });

api.tabs.onCreated.addListener((tab) => {
  sessions.adoptOpened(tab).catch(() => {});
});

const tools = {
  ...tabTools({ api, sessions }),
  ...pageTools({ api, content }),
  ...javascriptTool({ api }),
  ...computerTool({ api, content, capture }),
};

let native = null;
const dispatch = createDispatcher({ tools, sessions, activity, send: (msg) => native.send(msg) });
native = connectNative({ api, name: "claude_firefox_bridge", onMessage: dispatch });
