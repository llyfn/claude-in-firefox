const REF_PATTERN = /^(?:f(\d+)_)?ref_\d+$/;
const STOPWORDS = new Set(["the", "a", "an", "to", "of", "for", "in", "on", "with", "and", "or"]);
const ROLE_WORDS = {
  button: ["button", "btn"],
  link: ["link", "anchor"],
  textbox: ["textbox", "input", "field", "box", "bar", "text"],
  searchbox: ["searchbox", "search", "input", "field", "box", "bar"],
  combobox: ["combobox", "dropdown", "select", "menu"],
  checkbox: ["checkbox", "check", "tick"],
  radio: ["radio", "option"],
  heading: ["heading", "title", "header"],
  image: ["image", "img", "picture", "icon"],
  menuitem: ["menu", "item"],
};

export function parseRef(ref) {
  const match = REF_PATTERN.exec(String(ref ?? ""));
  if (!match) throw new Error(`Invalid ref "${ref}" — use a ref from read_page or find, e.g. "ref_12".`);
  return { frameId: match[1] ? Number(match[1]) : 0, ref: match[0] };
}

const quote = (value) => String(value).replace(/"/g, '\\"');

export function renderNode(node) {
  let line = `${" ".repeat(node.level)}${node.role}`;
  if (node.name) line += ` "${quote(node.name)}"`;
  if (node.ref) line += ` [${node.ref}]`;
  if (node.checked) line += " (checked)";
  if (node.selected) line += " (selected)";
  if (node.disabled) line += " (disabled)";
  for (const key of ["href", "type", "placeholder", "value"]) if (node[key] != null) line += ` ${key}="${quote(node[key])}"`;
  if (node.frame) line += ` [frame ${node.frame}]`;
  return line;
}

export function truncateAtLine(text, maxChars, hint) {
  if (text.length <= maxChars) return text;
  let cut = text.lastIndexOf("\n", maxChars);
  if (cut <= 0) cut = maxChars;
  return `${text.slice(0, cut)}\n[output truncated at ${cut} of ${text.length} characters. ${hint}]`;
}

export function renderTree(nodes, { maxChars = 50_000, truncatedNodes = false, focused = false } = {}) {
  if (!nodes.length) return "(no elements matched)";
  const text = truncateAtLine(nodes.map(renderNode).join("\n"), maxChars, "Pass a larger max_chars, or use ref_id or a smaller depth to focus.");
  if (!truncatedNodes) return text;
  return `${text}\n[truncated at 10000 elements — use ${focused ? "a smaller depth or a more specific ref_id" : "ref_id or a smaller depth"} to focus]`;
}

const tokenize = (text) => String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOPWORDS.has(t));

export function scoreNodes(nodes, query) {
  const phrase = String(query ?? "").toLowerCase().trim();
  const tokens = tokenize(query);
  const hits = [];
  nodes.forEach((node, index) => {
    if (!node.ref) return;
    const name = (node.name ?? "").toLowerCase();
    const extra = [node.placeholder, node.href, node.type, node.value].filter(Boolean).join(" ").toLowerCase();
    const roleWords = ROLE_WORDS[node.role] ?? [node.role];
    let score = phrase && name.includes(phrase) ? 5 : 0;
    for (const token of tokens) {
      if (name.includes(token)) score += 3;
      if (roleWords.includes(token)) score += 2;
      if (extra.includes(token)) score += 1;
    }
    if (score > 0 && node.interactive) score += 1;
    if (score > 0) hits.push({ node, score, index });
  });
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 20);
}

export function formatFind(hits, query) {
  if (!hits.length) return `No elements matched "${query}". Try other words that appear on the page, or use read_page.`;
  const lines = hits.map(({ node }) => `- ${node.ref}: ${renderNode({ ...node, level: 0, ref: undefined })}`);
  return `Found ${hits.length} element(s) matching "${query}", best first:\n\n${lines.join("\n")}`;
}
