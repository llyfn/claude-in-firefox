(() => {
  if (globalThis.__cf?.form) return;
  const cf = (globalThis.__cf ??= {});
  const NUMERIC = new Set(["number", "range"]);

  const CONTROL = 'input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"])';

  const fire = (el, type) => el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));

  function controlsInside(root) {
    const found = [];
    const visit = (node) => {
      const shadow = node.openOrClosedShadowRoot ?? node.shadowRoot;
      for (const child of [...(shadow?.children ?? []), ...node.children]) {
        if (child.matches(CONTROL)) found.push(child);
        else visit(child);
      }
    };
    visit(root);
    return found;
  }

  // Widgets often wrap the real control in a label, a field container or a shadow root.
  function controlFor(el, ref) {
    if (el.matches(CONTROL)) return el;
    const inside = controlsInside(el);
    if (inside.length > 1) throw new Error(`${ref} contains ${inside.length} form controls; pass the ref of one of them`);
    return inside[0] ?? el;
  }

  function setValue({ ref, value, guard }) {
    const target = cf.tree.resolve(ref);
    const el = controlFor(target, ref);
    cf.dom.guardHost(guard);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const result = applyValue(el, value);
    return el === target ? result : `${result} (used the <${el.tagName.toLowerCase()}> inside ${ref})`;
  }

  function applyValue(el, value) {
    const tag = el.tagName.toUpperCase();
    const type = tag === "INPUT" ? el.type : "";
    const sensitive = cf.tree.isSensitive(el);
    const show = (v) => (sensitive ? "(hidden)" : JSON.stringify(String(v)));

    if (tag === "SELECT") return selectOption(el, value, sensitive);
    if (type === "checkbox") {
      if (typeof value !== "boolean") throw new Error("A checkbox needs true or false");
      const previous = el.checked;
      if (previous !== value) el.click();
      return `Set checkbox to ${el.checked} (previous: ${previous})`;
    }
    if (type === "radio") {
      if (!el.checked) el.click();
      return `Selected radio ${JSON.stringify(el.value)}`;
    }
    if (type === "file") throw new Error("Use file_upload for file inputs");
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const text = String(value);
      if (NUMERIC.has(type) && text !== "" && !Number.isFinite(Number(text))) throw new Error(`A ${type} input needs a numeric value`);
      const previous = el.value;
      el.focus();
      cf.dom.setNativeValue(el, text);
      fire(el, "input");
      fire(el, "change");
      return `Set ${type || "textarea"} value to ${show(el.value)} (previous: ${show(previous)})`;
    }
    if (cf.dom.isContentEditable(el)) {
      const previous = el.textContent;
      const doc = el.ownerDocument;
      el.focus();
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!doc.execCommand("insertText", false, String(value))) {
        el.textContent = String(value);
        fire(el, "input");
      }
      return `Set editable content to ${show(el.textContent)} (previous: ${show(previous)})`;
    }
    throw new Error(`<${tag.toLowerCase()}> is not a supported form input`);
  }

  function selectOption(el, value, sensitive) {
    const wanted = String(value);
    const options = [...el.options];
    const option = options.find((o) => o.value === wanted)
      ?? options.find((o) => o.text === wanted)
      ?? options.find((o) => o.text.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (!option && sensitive) throw new Error("No option matches (options of a sensitive field are not listed)");
    if (!option) throw new Error(`No option matches "${wanted}". Options: ${options.map((o) => `"${o.text.trim()}" = "${o.value}"`).join("; ")}`);
    const previous = el.selectedOptions[0]?.text.trim() ?? "";
    el.focus();
    option.selected = true;
    fire(el, "input");
    fire(el, "change");
    if (sensitive) return "Selected an option (sensitive field; values hidden)";
    return `Selected "${option.text.trim()}" (previous: "${previous}")`;
  }

  function setFiles({ ref, files, guard }) {
    const el = cf.tree.resolve(ref);
    if (el.tagName.toUpperCase() !== "INPUT" || el.type !== "file") throw new Error(`${ref} is not an <input type="file">`);
    cf.dom.guardHost(guard);
    const win = el.ownerDocument.defaultView;
    const transfer = new win.DataTransfer();
    for (const file of files) {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new win.File([bytes], file.name, { type: file.mimeType }));
    }
    el.files = transfer.files;
    fire(el, "input");
    fire(el, "change");
    return `Uploaded ${files.length} file(s) to ${ref}: ${files.map((f) => f.name).join(", ")}`;
  }

  cf.form = { setValue, setFiles };
})();
