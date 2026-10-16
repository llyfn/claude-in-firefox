(() => {
  if (globalThis.__cf?.input) return;
  const cf = (globalThis.__cf ??= {});

  const MODIFIERS = { ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt", cmd: "meta", meta: "meta", command: "meta", super: "meta", win: "meta", windows: "meta" };
  // [key, code, keyCode] using Firefox's keyCodes (Meta 224, "-" 173, "=" 61, ";" 59).
  const NAMED_KEYS = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], kpenter: ["Enter", "NumpadEnter", 13],
    tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
    space: [" ", "Space", 32], insert: ["Insert", "Insert", 45],
    up: ["ArrowUp", "ArrowUp", 38], arrowup: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40], arrowdown: ["ArrowDown", "ArrowDown", 40],
    left: ["ArrowLeft", "ArrowLeft", 37], arrowleft: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39], arrowright: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33], prior: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34], next: ["PageDown", "PageDown", 34],
    shift: ["Shift", "ShiftLeft", 16], ctrl: ["Control", "ControlLeft", 17], control: ["Control", "ControlLeft", 17],
    alt: ["Alt", "AltLeft", 18], option: ["Alt", "AltLeft", 18],
    cmd: ["Meta", "MetaLeft", 224], meta: ["Meta", "MetaLeft", 224], command: ["Meta", "MetaLeft", 224], super: ["Meta", "MetaLeft", 224],
    minus: ["-", "Minus", 173], plus: ["+", "Equal", 61], equal: ["=", "Equal", 61], comma: [",", "Comma", 188], period: [".", "Period", 190],
    slash: ["/", "Slash", 191], backslash: ["\\", "Backslash", 220], semicolon: [";", "Semicolon", 59], apostrophe: ["'", "Quote", 222],
    quote: ["'", "Quote", 222], grave: ["`", "Backquote", 192], bracketleft: ["[", "BracketLeft", 219], bracketright: ["]", "BracketRight", 221],
  };
  // [code, keyCode, needs shift]
  const PUNCTUATION = {
    "-": ["Minus", 173], "=": ["Equal", 61], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 59],
    "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
    "_": ["Minus", 173, true], "+": ["Equal", 61, true], "{": ["BracketLeft", 219, true], "}": ["BracketRight", 221, true], "|": ["Backslash", 220, true],
    ":": ["Semicolon", 59, true], '"': ["Quote", 222, true], "<": ["Comma", 188, true], ">": ["Period", 190, true], "?": ["Slash", 191, true], "~": ["Backquote", 192, true],
    "!": ["Digit1", 49, true], "@": ["Digit2", 50, true], "#": ["Digit3", 51, true], "$": ["Digit4", 52, true], "%": ["Digit5", 53, true],
    "^": ["Digit6", 54, true], "&": ["Digit7", 55, true], "*": ["Digit8", 56, true], "(": ["Digit9", 57, true], ")": ["Digit0", 48, true],
  };
  const TEXT_SELECTION_TYPES = new Set(["text", "search", "url", "tel", "password"]);
  const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"]);
  const ACTIVATABLE_INPUTS = new Set(["checkbox", "radio", "submit", "button", "reset", "image"]);
  const ACTIVATABLE_ROLES = new Set(["button", "checkbox", "switch", "radio"]);
  const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';

  const tagOf = (el) => el.tagName.toUpperCase();
  const isTextField = (el) => tagOf(el) === "TEXTAREA" || (tagOf(el) === "INPUT" && !NON_TEXT_INPUTS.has(el.type));
  const supportsSelection = (el) => tagOf(el) === "TEXTAREA" || (tagOf(el) === "INPUT" && TEXT_SELECTION_TYPES.has(el.type));
  const isEditable = (el) => isTextField(el) || cf.dom.isContentEditable(el);
  const describeElement = (el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>`;

  function keyForChar(ch) {
    if (/^[a-z]$/i.test(ch)) {
      const upper = ch.toUpperCase();
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), printable: true, shift: ch !== ch.toLowerCase() };
    }
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), printable: true, shift: false };
    if (ch === " ") return { key: " ", code: "Space", keyCode: 32, printable: true, shift: false };
    const punct = PUNCTUATION[ch];
    if (punct) return { key: ch, code: punct[0], keyCode: punct[1], printable: true, shift: !!punct[2] };
    return { key: ch, code: "", keyCode: 0, printable: true, shift: false };
  }

  function keyForName(name) {
    if ([...name].length === 1) return keyForChar(name);
    const fn = /^f([1-9]|1[0-2])$/i.exec(name);
    if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]), printable: false, shift: false };
    const named = NAMED_KEYS[name.toLowerCase().replace(/_/g, "")];
    if (!named) throw new Error(`Unknown key: ${name}`);
    return { key: named[0], code: named[1], keyCode: named[2], printable: named[0].length === 1, shift: false };
  }

  function parseChord(token) {
    const plusKey = token.endsWith("+");
    const parts = plusKey ? token.slice(0, -1).split("+").filter(Boolean) : token.split("+");
    const keyName = plusKey ? "+" : parts.pop();
    const mods = { ctrl: false, shift: false, alt: false, meta: false };
    for (const part of parts) {
      const mod = MODIFIERS[part.toLowerCase()];
      if (!mod) throw new Error(`Unknown modifier "${part}" in "${token}"`);
      mods[mod] = true;
    }
    if (!keyName) throw new Error(`Missing key in "${token}"`);
    const key = keyForName(keyName);
    if (mods.shift && /^[a-z]$/.test(key.key)) key.key = key.key.toUpperCase();
    return { key: key.key, code: key.code, keyCode: key.keyCode, printable: key.printable, mods: { ...mods, shift: mods.shift || key.shift } };
  }

  function parseKeySpec(spec) {
    const tokens = String(spec ?? "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error("No keys given");
    return tokens.map(parseChord);
  }

  const charChord = (ch) => {
    const key = keyForChar(ch);
    return { key: key.key, code: key.code, keyCode: key.keyCode, printable: true, mods: { ctrl: false, shift: key.shift, alt: false, meta: false } };
  };
  const isZoomChord = (c) => (c.mods.ctrl || c.mods.meta) && ["=", "+", "-", "0"].includes(c.key);
  const isReloadChord = (c) => c.key === "F5" || ((c.mods.ctrl || c.mods.meta) && c.key.toLowerCase() === "r");

  function activeTarget() {
    let el = document.activeElement ?? document.body ?? document.documentElement;
    for (;;) {
      const tag = tagOf(el);
      if (tag === "IFRAME" || tag === "FRAME") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (!doc) return { redirect: { frameId: browser.runtime.getFrameId(el) } };
        el = doc.activeElement ?? doc.body;
        continue;
      }
      const root = el.openOrClosedShadowRoot ?? el.shadowRoot;
      if (root?.activeElement) {
        el = root.activeElement;
        continue;
      }
      return { el };
    }
  }

  function keyInit(c) {
    return { key: c.key, code: c.code, keyCode: c.keyCode, which: c.keyCode, ctrlKey: c.mods.ctrl, shiftKey: c.mods.shift, altKey: c.mods.alt, metaKey: c.mods.meta, bubbles: true, cancelable: true, composed: true };
  }

  function pressChord(c) {
    const { el } = activeTarget();
    const win = el.ownerDocument.defaultView;
    const init = keyInit(c);
    let proceed = el.dispatchEvent(new win.KeyboardEvent("keydown", init));
    if (proceed && c.printable && !c.mods.ctrl && !c.mods.meta) proceed = el.dispatchEvent(new win.KeyboardEvent("keypress", { ...init, charCode: c.key.codePointAt(0), keyCode: 0 }));
    if (proceed) defaultAction(el, c);
    const after = activeTarget().el ?? el;
    after.dispatchEvent(new after.ownerDocument.defaultView.KeyboardEvent("keyup", init));
  }

  function defaultAction(el, c) {
    const doc = el.ownerDocument;
    if (c.mods.ctrl || c.mods.meta) {
      switch (c.key.toLowerCase()) {
        case "a": if (supportsSelection(el)) el.select(); else doc.execCommand("selectAll"); return;
        case "c": doc.execCommand("copy"); return;
        case "x": doc.execCommand("cut"); return;
        case "z": doc.execCommand(c.mods.shift ? "redo" : "undo"); return;
        case "y": doc.execCommand("redo"); return;
        default: return;
      }
    }
    switch (c.key) {
      case "Enter":
        pressEnter(el, c.mods.shift);
        return;
      case "Tab":
        moveFocus(el, c.mods.shift ? -1 : 1);
        return;
      case "Backspace":
        if (isEditable(el) && !doc.execCommand("delete")) deleteInField(el, -1);
        return;
      case "Delete":
        if (isEditable(el) && !doc.execCommand("forwardDelete")) deleteInField(el, 1);
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        if (isEditable(el)) moveCaret(el, c.key, c.mods.shift);
        else scrollByKey(el, c.key);
        return;
      case "ArrowUp":
      case "ArrowDown":
        if (cf.dom.isContentEditable(el)) doc.getSelection().modify(c.mods.shift ? "extend" : "move", c.key === "ArrowUp" ? "backward" : "forward", "line");
        else if (!isEditable(el)) scrollByKey(el, c.key);
        return;
      case "PageUp":
      case "PageDown":
        scrollByKey(el, c.key);
        return;
      case " ":
        if (isEditable(el)) break;
        if (isActivatable(el)) el.click();
        else scrollByKey(el, c.mods.shift ? "PageUp" : "PageDown");
        return;
      default:
        break;
    }
    if (c.printable && isEditable(el)) insertText(el, c.key);
  }

  function isActivatable(el) {
    const tag = tagOf(el);
    return tag === "BUTTON" || tag === "SUMMARY" || (tag === "INPUT" && ACTIVATABLE_INPUTS.has(el.type)) || ACTIVATABLE_ROLES.has(el.getAttribute("role"));
  }

  function insertText(el, text) {
    const doc = el.ownerDocument;
    if (doc.execCommand("insertText", false, text)) return;
    if (!isTextField(el)) return;
    const length = el.value.length;
    const start = supportsSelection(el) ? el.selectionStart : length;
    const end = supportsSelection(el) ? el.selectionEnd : length;
    cf.dom.setNativeValue(el, el.value.slice(0, start) + text + el.value.slice(end));
    if (supportsSelection(el)) el.setSelectionRange(start + text.length, start + text.length);
    el.dispatchEvent(new doc.defaultView.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function deleteInField(el, direction) {
    if (!isTextField(el)) return;
    const length = el.value.length;
    let start = supportsSelection(el) ? el.selectionStart : length;
    let end = supportsSelection(el) ? el.selectionEnd : length;
    if (start === end) {
      if (direction < 0 && start > 0) start--;
      else if (direction > 0 && end < length) end++;
      else return;
    }
    cf.dom.setNativeValue(el, el.value.slice(0, start) + el.value.slice(end));
    if (supportsSelection(el)) el.setSelectionRange(start, start);
    el.dispatchEvent(new el.ownerDocument.defaultView.InputEvent("input", { bubbles: true, inputType: direction < 0 ? "deleteContentBackward" : "deleteContentForward" }));
  }

  function pressEnter(el, shift) {
    const tag = tagOf(el);
    if (tag === "TEXTAREA") {
      insertText(el, "\n");
      return;
    }
    if (cf.dom.isContentEditable(el)) {
      el.ownerDocument.execCommand(shift ? "insertLineBreak" : "insertParagraph");
      return;
    }
    if (tag === "INPUT" && isTextField(el)) {
      if (el.form) submitImplicitly(el.form);
      return;
    }
    if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || el.getAttribute("role") === "button" || (tag === "INPUT" && ["submit", "button", "reset", "image"].includes(el.type))) el.click();
  }

  function submitImplicitly(form) {
    const button = [...form.elements].find((e) => (tagOf(e) === "BUTTON" && e.type === "submit") || (tagOf(e) === "INPUT" && (e.type === "submit" || e.type === "image")));
    if (button) {
      if (!button.disabled) button.click();
      return;
    }
    form.requestSubmit();
  }

  function moveFocus(el, direction) {
    const doc = el.ownerDocument;
    const candidates = [...doc.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && n.tabIndex >= 0 && !(tagOf(n) === "INPUT" && n.type === "hidden") && n.checkVisibility());
    const order = [...candidates.filter((n) => n.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...candidates.filter((n) => n.tabIndex === 0)];
    if (!order.length) return;
    const index = order.indexOf(el);
    const next = index === -1 ? order[direction > 0 ? 0 : order.length - 1] : order[(index + direction + order.length) % order.length];
    next.focus();
    if (supportsSelection(next)) next.select();
  }

  function moveCaret(el, key, shift) {
    if (cf.dom.isContentEditable(el)) {
      const direction = key === "ArrowLeft" || key === "Home" ? "backward" : "forward";
      el.ownerDocument.getSelection().modify(shift ? "extend" : "move", direction, key === "Home" || key === "End" ? "lineboundary" : "character");
      return;
    }
    if (!supportsSelection(el)) return;
    const length = el.value.length;
    const backward = el.selectionDirection === "backward";
    const anchor = backward ? el.selectionEnd : el.selectionStart;
    const focus = backward ? el.selectionStart : el.selectionEnd;
    const collapsed = el.selectionStart === el.selectionEnd;
    let target = { ArrowLeft: focus - 1, ArrowRight: focus + 1, Home: 0, End: length }[key];
    if (!shift && !collapsed && key === "ArrowLeft") target = el.selectionStart;
    if (!shift && !collapsed && key === "ArrowRight") target = el.selectionEnd;
    target = Math.max(0, Math.min(length, target));
    if (!shift) el.setSelectionRange(target, target);
    else if (target < anchor) el.setSelectionRange(target, anchor, "backward");
    else el.setSelectionRange(anchor, target, "forward");
  }

  function canScroll(node, dx, dy) {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    const scrollable = (overflow) => overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    if (dy && scrollable(style.overflowY)) return dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0;
    if (dx && scrollable(style.overflowX)) return dx > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0;
    return false;
  }

  function scrollFrom(el, dx, dy) {
    const doc = el.ownerDocument;
    for (let node = el; node && node !== doc.documentElement && node !== doc.body; node = node.parentElement ?? node.getRootNode().host) {
      if (canScroll(node, dx, dy)) {
        node.scrollBy({ left: dx, top: dy, behavior: "instant" });
        return;
      }
    }
    doc.defaultView.scrollBy({ left: dx, top: dy, behavior: "instant" });
  }

  function scrollByKey(el, key) {
    const page = el.ownerDocument.defaultView.innerHeight * 0.875;
    const deltas = { ArrowUp: [0, -40], ArrowDown: [0, 40], ArrowLeft: [-40, 0], ArrowRight: [40, 0], PageUp: [0, -page], PageDown: [0, page], Home: [0, -1e7], End: [0, 1e7] };
    const [dx, dy] = deltas[key];
    scrollFrom(el, dx, dy);
  }

  function viewport() {
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY };
  }

  function type({ text, guard = null }) {
    const target = activeTarget();
    if (target.redirect) return target;
    cf.dom.guardHost(guard);
    if (!isEditable(target.el)) throw new Error(`No editable element is focused (focus is on ${describeElement(target.el)}). Click the field first.`);
    for (const ch of String(text)) {
      if (ch === "\r") continue;
      pressChord(ch === "\n" ? parseChord("Enter") : charChord(ch));
    }
    return {};
  }

  function keys({ spec, repeat = 1, guard = null }) {
    const chords = parseKeySpec(spec);
    if (chords.some(isZoomChord)) throw new Error("Page zoom shortcuts are not supported. Use the zoom action to magnify a region.");
    if (chords.length === 1 && isReloadChord(chords[0])) return { reload: { bypassCache: chords[0].mods.shift } };
    const target = activeTarget();
    if (target.redirect) return target;
    cf.dom.guardHost(guard);
    for (let i = 0; i < repeat; i++) for (const chord of chords) pressChord(chord);
    return {};
  }

  cf.input = { viewport, type, keys, parseKeySpec };
})();
