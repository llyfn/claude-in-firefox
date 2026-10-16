(() => {
  if (globalThis.__cf?.text) return;
  const cf = (globalThis.__cf ??= {});
  const SELECTORS = ["article", "main", '[class*="articleBody"]', '[class*="article-body"]', '[class*="post-content"]', '[class*="entry-content"]', '[class*="content-body"]', '[role="main"]', ".content", "#content"];

  function pageText() {
    let source = null;
    for (const selector of SELECTORS) {
      const matches = [...document.querySelectorAll(selector)];
      if (matches.length) {
        source = matches.reduce((best, el) => (el.innerText.length > best.innerText.length ? el : best));
        break;
      }
    }
    source ??= document.body;
    const text = source.innerText.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { title: document.title, url: location.href, tag: source.tagName.toLowerCase(), text };
  }

  cf.text = { pageText };
})();
