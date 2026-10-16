(() => {
  if (globalThis.__cf?.tree) return;
  const cf = (globalThis.__cf ??= {});

  const MAX_NODES = 10_000;
  const REDACTED = "[value redacted]";
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "NOSCRIPT", "TEMPLATE", "CLAUDE-FIREFOX-INDICATOR"]);
  const LANDMARK_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "NAV", "MAIN", "HEADER", "FOOTER", "SECTION", "ARTICLE", "ASIDE"]);
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem"]);
  const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "cell", "columnheader", "rowheader", "tooltip", "switch", "checkbox", "radio"]);
  const TAG_ROLES = {
    BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "image", NAV: "navigation", MAIN: "main", HEADER: "banner",
    FOOTER: "contentinfo", SECTION: "region", ARTICLE: "article", ASIDE: "complementary", FORM: "form", TABLE: "table",
    UL: "list", OL: "list", LI: "listitem", LABEL: "label", DIALOG: "dialog", DETAILS: "group", SUMMARY: "button",
    OPTION: "option", IFRAME: "iframe", FRAME: "iframe",
  };
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", file: "button", search: "searchbox", range: "slider", number: "spinbutton" };
  const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"]);
  const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/i;

  const refs = new Map();
  const refOf = new WeakMap();
  let counter = 0;

  const tagOf = (el) => el.tagName.toUpperCase();
  const clean = (value, max = 100) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  function isSensitive(el) {
    if (tagOf(el) === "INPUT" && (el.type === "password" || el.type === "hidden")) return true;
    return SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "");
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = tagOf(el);
    if (tag === "INPUT") return INPUT_ROLES[el.type] || "textbox";
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (/^H[1-6]$/.test(tag)) return "heading";
    return TAG_ROLES[tag] || "generic";
  }

  function textExcluding(node, skip) {
    let text = "";
    for (const child of node.childNodes) {
      if (child === skip) continue;
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1) text += ` ${textExcluding(child, skip)} `;
    }
    return text;
  }

  function directText(el) {
    let text = "";
    for (const child of el.childNodes) if (child.nodeType === 3) text += child.textContent;
    return text;
  }

  function labelText(el) {
    let text = "";
    if (el.id) for (const label of el.ownerDocument.querySelectorAll("label[for]")) if (label.htmlFor === el.id) text += ` ${textExcluding(label, el)}`;
    const wrapping = el.closest("label");
    if (wrapping) text += ` ${textExcluding(wrapping, el)}`;
    return text;
  }

  function nameOf(el, role) {
    const tag = tagOf(el);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = clean(labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" "));
      if (text) return text;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      const label = clean(labelText(el));
      if (label) return label;
    }
    for (const attr of ["placeholder", "title", "alt"]) {
      const value = clean(el.getAttribute(attr));
      if (value) return value;
    }
    if (tag === "SELECT") return isSensitive(el) ? REDACTED : clean(el.selectedOptions[0]?.textContent);
    if (tag === "INPUT") return ["submit", "button", "reset"].includes(el.type) ? clean(el.value) : "";
    if (tag === "TEXTAREA") return "";
    if (NAME_FROM_CONTENT.has(role)) return clean(el.textContent);
    const direct = clean(directText(el));
    return direct.length >= 3 ? direct : "";
  }

  function fieldValue(el) {
    const tag = tagOf(el);
    const textual = tag === "TEXTAREA" || (tag === "INPUT" && !NON_TEXT_INPUTS.has(el.type));
    if (!textual || !el.value) return null;
    return isSensitive(el) ? REDACTED : clean(el.value);
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_TAGS.has(tagOf(el))) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
    const editable = el.getAttribute("contenteditable");
    if (editable === "" || editable === "true" || editable === "plaintext-only") return true;
    return INTERACTIVE_ROLES.has(role);
  }

  function isVisible(el) {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return el.getClientRects().length > 0;
  }

  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    return rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
  }

  function refFor(el, prefix) {
    const known = refOf.get(el);
    if (known && refs.get(known)?.deref() === el) return known;
    const ref = `${prefix}ref_${++counter}`;
    refs.set(ref, new WeakRef(el));
    refOf.set(el, ref);
    return ref;
  }

  function resolve(ref) {
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) {
      refs.delete(ref);
      throw new Error(`Element ${ref} not found — it may have been removed. Call read_page or find again.`);
    }
    return el;
  }

  function describe(el, role, name, level, prefix, interactive) {
    const node = { level, role, ref: refFor(el, prefix) };
    if (name) node.name = name;
    if (interactive) node.interactive = true;
    if (el.checked === true || el.getAttribute("aria-checked") === "true") node.checked = true;
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") node.disabled = true;
    for (const attr of ["href", "type", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value && !(attr === "placeholder" && value === name)) node[attr] = clean(value, 200);
    }
    const value = fieldValue(el);
    if (value != null) node.value = value;
    return node;
  }

  function optionNode(option, level) {
    const node = { level, role: "option", name: clean(option.textContent) };
    if (option.selected) node.selected = true;
    if (option.value !== option.textContent.trim()) node.value = clean(option.value, 200);
    return node;
  }

  function childrenOf(el) {
    const root = el.openOrClosedShadowRoot ?? el.shadowRoot;
    return root ? [...root.children, ...el.children] : [...el.children];
  }

  function frameDocument(el) {
    try {
      return el.contentDocument;
    } catch {
      return null;
    }
  }

  function build({ filter = "all", depth = 15, refId = null, framePrefix = "" } = {}) {
    const root = refId ? resolve(refId) : document.body ?? document.documentElement;
    const nodes = [];
    let truncated = false;

    const visit = (el, level) => {
      if (nodes.length >= MAX_NODES) {
        truncated = true;
        return;
      }
      if (level > depth) return;
      const tag = tagOf(el);
      if (SKIP_TAGS.has(tag) || (tag === "INPUT" && el.type === "hidden")) return;
      const role = roleOf(el);
      const name = nameOf(el, role);
      const interactive = isInteractive(el, role);
      const isFrame = tag === "IFRAME" || tag === "FRAME";
      const include = isFrame || (refId != null && el === root) || (filter === "interactive"
        ? interactive && el.getAttribute("aria-hidden") !== "true" && isVisible(el) && (refId != null || inViewport(el))
        : interactive || LANDMARK_TAGS.has(tag) || el.hasAttribute("role") || name !== "" || (role !== "generic" && role !== "image"));
      let childLevel = level;
      if (include) {
        nodes.push(describe(el, role, name, level, framePrefix, interactive));
        childLevel = level + 1;
        if (tag === "SELECT") {
          if (!isSensitive(el)) for (const option of el.options) nodes.push(optionNode(option, childLevel));
          return;
        }
      }
      if (isFrame) {
        const doc = frameDocument(el);
        if (doc?.body) visit(doc.body, childLevel);
        else {
          const frameId = browser.runtime.getFrameId(el);
          if (frameId > 0) nodes[nodes.length - 1].frame = frameId;
        }
        return;
      }
      for (const child of childrenOf(el)) visit(child, childLevel);
    };

    visit(root, 0);
    for (const [ref, weak] of refs) {
      const el = weak.deref();
      if (!el || !el.isConnected) refs.delete(ref);
    }
    return { nodes, truncated, viewport: { width: innerWidth, height: innerHeight } };
  }

  cf.tree = { build, resolve, isSensitive };
})();
