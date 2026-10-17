(() => {
  if (globalThis.__cf?.text) return;
  const cf = (globalThis.__cf ??= {});
  const CONTENT = "main, [role=main], article";

  function pageText() {
    const longest = [...document.querySelectorAll(CONTENT)].reduce((best, el) => (!best || el.innerText.length > best.innerText.length ? el : best), null);
    const source = longest ?? document.body;
    const text = source.innerText.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { title: document.title, url: location.href, tag: source.tagName.toLowerCase(), text };
  }

  cf.text = { pageText };
})();
