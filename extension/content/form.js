(() => {
  if (globalThis.__cf?.form) return;
  const cf = (globalThis.__cf ??= {});
  const NUMERIC = new Set(["number", "range"]);

  const fire = (el, type) => el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));

  function setValue({ ref, value, guard }) {
    const el = cf.tree.resolve(ref);
    cf.dom.guardHost(guard);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const tag = el.tagName.toUpperCase();
    const type = tag === "INPUT" ? el.type : "";
    const sensitive = cf.tree.isSensitive(el);
    const show = (v) => (sensitive ? "[redacted]" : JSON.stringify(String(v)));

    if (tag === "SELECT") return selectOption(el, value, sensitive);
    if (type === "checkbox") {
      if (typeof value !== "boolean") throw new Error("Checkbox requires a boolean value (true/false)");
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
    if (!option && sensitive) throw new Error("Option not found (options of this field are not listed because it is sensitive)");
    if (!option) throw new Error(`Option "${wanted}" not found. Available options: ${options.map((o) => `"${o.text.trim()}" (value: "${o.value}")`).join(", ")}`);
    const previous = el.selectedOptions[0]?.text.trim() ?? "";
    el.focus();
    option.selected = true;
    fire(el, "input");
    fire(el, "change");
    if (sensitive) return "Selected [redacted] (previous: [redacted])";
    return `Selected "${option.text.trim()}" (previous: "${previous}")`;
  }

  cf.form = { setValue };
})();
