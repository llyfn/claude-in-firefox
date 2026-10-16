const tabId = { type: "integer", description: "ID of a tab in this session's tab group (see tabs_context)." };
const point = (description) => ({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description });

export const TOOLS = [
  {
    name: "tabs_context",
    description: "List the tabs in this session's Firefox tab group. Call this first in every conversation to learn which tab IDs you may use. Each Claude Code session gets its own group, and tabs outside it cannot be controlled. Pass createIfEmpty: true to create the group (with one blank tab) when this session has none yet.",
    inputSchema: { type: "object", properties: { createIfEmpty: { type: "boolean", description: "Create the tab group with a blank tab if this session has none yet." } } },
  },
  {
    name: "tabs_create",
    description: "Open a new blank tab in this session's tab group and return its tab ID. Prefer a fresh tab per task over reusing tabs the user is looking at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabs_close",
    description: "Close a tab in this session's tab group.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "navigate",
    description: 'Load a URL in a tab, or go "back" / "forward" in its history. Waits up to 15 seconds for the page to finish loading and returns the final URL and title. URLs without a scheme get https://.',
    inputSchema: { type: "object", properties: { url: { type: "string", description: 'URL to load, or "back" / "forward".' }, tabId }, required: ["url", "tabId"] },
  },
  {
    name: "computer",
    description: [
      "Use the mouse and keyboard in a tab and take screenshots. Input is synthesized inside the page (Firefox gives extensions no OS-level input): CSS :hover styles do not apply, native <select> popups and file pickers cannot be opened (use form_input / file_upload), and a page that ignores script-generated events will not react.",
      "* Take a screenshot before clicking by coordinate; coordinates are pixels in the most recent screenshot of that tab.",
      "* Prefer ref targets from read_page or find over coordinates when you have them.",
      "* Click the center of elements.",
      '* key takes space-separated keys or chords, e.g. "Enter", "Tab", "shift+Tab", "cmd+a", "Page_Down". Use "cmd" on macOS.',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["left_click", "right_click", "double_click", "triple_click", "type", "key", "screenshot", "wait", "scroll", "scroll_to", "hover", "left_click_drag", "zoom"],
          description: [
            "left_click / right_click / double_click / triple_click: click at coordinate or ref.",
            "type: type text into the focused element.",
            "key: press keys or chords given in text.",
            "screenshot: capture the visible part of the page.",
            "wait: pause for duration seconds.",
            "scroll: scroll at coordinate (or ref) in scroll_direction by scroll_amount ticks; returns a screenshot.",
            "scroll_to: scroll the element with ref into view.",
            "hover: move the pointer to coordinate or ref without clicking.",
            "left_click_drag: drag from start_coordinate to coordinate.",
            "zoom: capture region at higher resolution for close inspection.",
          ].join("\n"),
        },
        coordinate: point("[x, y] in screenshot pixels: the click, hover or scroll target, or the end point of left_click_drag."),
        start_coordinate: point("[x, y] start point for left_click_drag."),
        ref: { type: "string", description: 'Element ref from read_page or find (e.g. "ref_12"). Alternative to coordinate for clicks, hover and scroll; required for scroll_to.' },
        text: { type: "string", description: "Text to type (type) or keys to press (key)." },
        modifiers: { type: "string", description: 'Modifier keys held during a click, joined with "+": ctrl, shift, alt, cmd.' },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "integer", minimum: 1, maximum: 10, description: "Scroll wheel ticks of 100 px. Default 3." },
        duration: { type: "number", minimum: 0, maximum: 10, description: "Seconds to wait (wait action)." },
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] in screenshot pixels (zoom action)." },
        repeat: { type: "integer", minimum: 1, maximum: 100, description: "Repeat the key sequence this many times (key action). Default 1." },
        scale: { type: "number", minimum: 0.1, maximum: 1, description: "Shrink the returned screenshot or zoom image by this factor to save tokens. Coordinates always refer to the full-size frame reported with the image." },
        tabId,
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "read_page",
    description: 'Return an accessibility-tree outline of the page. Each element gets a stable ref (e.g. ref_12) usable with computer, form_input and file_upload. filter "interactive" lists only visible on-screen controls; the default "all" also includes off-screen and hidden content. Output is limited to max_chars (default 50000) and truncated at a line boundary with a note; narrow it with depth or ref_id. Password and payment field values are redacted. Cross-origin iframe contents are included with refs like f7_ref_3.',
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        filter: { type: "string", enum: ["interactive", "all"] },
        depth: { type: "integer", minimum: 1, description: "Maximum tree depth (default 15)." },
        ref_id: { type: "string", description: "Only return this element and its descendants." },
        max_chars: { type: "integer", minimum: 100, description: "Maximum output characters (default 50000)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "find",
    description: 'Find elements whose text, label, role or attributes match keywords in the query (keyword scoring, not semantic search). Returns up to 20 refs, best match first. Use words that appear on the page, e.g. "search box" or "add to cart button".',
    inputSchema: { type: "object", properties: { query: { type: "string" }, tabId }, required: ["query", "tabId"] },
  },
  {
    name: "form_input",
    description: "Set a form control by ref: text inputs and textareas (string), selects (option value or visible text), checkboxes (boolean), radio buttons (any value selects it), date/number/range inputs, and contenteditable elements. Fires input and change events so frameworks such as React notice the change.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, value: { type: ["string", "boolean", "number"] }, tabId }, required: ["ref", "value", "tabId"] },
  },
  {
    name: "get_page_text",
    description: "Return the page's readable text, preferring the main article or content element. Good for reading long pages without screenshots. Limited to max_chars (default 50000) with a truncation note.",
    inputSchema: { type: "object", properties: { tabId, max_chars: { type: "integer", minimum: 100 } }, required: ["tabId"] },
  },
  {
    name: "javascript_tool",
    description: "Run JavaScript in the page and return the value of the last expression (REPL style; promises are awaited). Code that uses top-level await or return is retried wrapped in an async function, so use return there to produce a value. If the page's Content Security Policy forbids eval, the code runs in the extension's isolated sandbox instead: page globals are then reachable through window.wrappedJSObject and the result must be JSON-serializable.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["javascript_exec"] }, text: { type: "string", description: "JavaScript source." }, tabId }, required: ["action", "text", "tabId"] },
  },
  {
    name: "read_console_messages",
    description: "Read console output (log/info/warn/error/debug, uncaught errors, unhandled rejections) captured from the tab since its current origin loaded. Provide a pattern to keep the output focused.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        onlyErrors: { type: "boolean", description: "Only errors and uncaught exceptions." },
        clear: { type: "boolean", description: "Clear the buffer after reading." },
        pattern: { type: "string", description: "Case-insensitive regular expression filter." },
        limit: { type: "integer", minimum: 1, description: "Maximum messages, most recent first kept (default 100)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "read_network_requests",
    description: "List HTTP requests made by the tab since its current origin loaded (method, URL, status). The buffer resets when the tab navigates to a different origin.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        urlPattern: { type: "string", description: "Only requests whose URL contains this substring." },
        clear: { type: "boolean", description: "Clear the buffer after reading." },
        limit: { type: "integer", minimum: 1, description: "Maximum requests, most recent kept (default 100)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "resize_window",
    description: "Resize the Firefox window that contains the tab.",
    inputSchema: { type: "object", properties: { width: { type: "integer", minimum: 100, maximum: 7680 }, height: { type: "integer", minimum: 100, maximum: 4320 }, tabId }, required: ["width", "height", "tabId"] },
  },
  {
    name: "file_upload",
    description: 'Put local files into an <input type="file"> identified by ref, as if the user had picked them. Do not click file inputs: the native file picker cannot be operated. Paths are read by the MCP server (relative paths resolve against its working directory); total size up to 10 MB.',
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1 }, ref: { type: "string" }, tabId }, required: ["paths", "ref", "tabId"] },
  },
  {
    name: "browser_batch",
    description: "Run several browser tool calls in order in one round trip, stopping at the first error. Use it whenever you can predict the next steps, e.g. click → type → key Enter → screenshot. Coordinates refer to the latest screenshot of the tab, including one taken earlier in the same batch.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name", "input"] },
        },
      },
      required: ["actions"],
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
