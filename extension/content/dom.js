(() => {
  if (globalThis.__cf?.dom) return;
  const cf = (globalThis.__cf ??= {});
  const VALUE_CLASSES = { INPUT: "HTMLInputElement", TEXTAREA: "HTMLTextAreaElement" };

  // The prototype setter bypasses value properties pages define on the element itself
  // (React's value tracker), so their input listeners see a real change.
  function setNativeValue(el, value) {
    const proto = el.ownerDocument.defaultView[VALUE_CLASSES[el.tagName.toUpperCase()]].prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function isContentEditable(el) {
    const host = el.closest("[contenteditable]");
    return !!host && host.getAttribute("contenteditable") !== "false";
  }

  function guardHost(guard) {
    if (guard && location.hostname !== guard.host) {
      throw new Error(`Page navigated to a different domain during ${guard.action}. Re-read the tab state before retrying.`);
    }
  }

  cf.dom = { setNativeValue, isContentEditable, guardHost };
})();
