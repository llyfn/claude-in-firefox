import { formatFind, parseRef, renderTree, scoreNodes } from "../tree.js";

const prefixFor = (frameId) => (frameId ? `f${frameId}_` : "");

export async function collectTree(content, tabId, { filter, depth, refId }) {
  const target = refId ? parseRef(refId) : { frameId: 0, ref: null };
  const root = await content.call(tabId, target.frameId, "tree.build", { filter, depth, refId: target.ref, framePrefix: prefixFor(target.frameId) });
  const nodes = await expandFrames(content, tabId, root.nodes, { filter, depth });
  return { nodes, truncated: root.truncated, viewport: root.viewport };
}

async function expandFrames(content, tabId, nodes, options) {
  const out = [];
  for (const node of nodes) {
    out.push(node);
    if (!node.frame) continue;
    let sub;
    try {
      sub = await content.call(tabId, node.frame, "tree.build", { ...options, refId: null, framePrefix: prefixFor(node.frame) });
    } catch (err) {
      out.push({ level: node.level + 1, role: "note", name: `frame contents unavailable: ${err.message}` });
      continue;
    }
    for (const child of await expandFrames(content, tabId, sub.nodes, options)) out.push({ ...child, level: child.level + node.level + 1 });
  }
  return out;
}

export function pageTools({ content }) {
  return {
    read_page: {
      tabScoped: true,
      async run({ tab, args }) {
        const filter = args.filter === "interactive" ? "interactive" : "all";
        const { nodes, truncated, viewport } = await collectTree(content, tab.id, { filter, depth: args.depth ?? 15, refId: args.ref_id ?? null });
        const text = renderTree(nodes, { maxChars: args.max_chars ?? 50_000, truncatedNodes: truncated, focused: !!args.ref_id });
        return `${text}\n\nViewport: ${viewport.width}x${viewport.height}`;
      },
    },
    find: {
      tabScoped: true,
      async run({ tab, args }) {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("find: query is required");
        const { nodes } = await collectTree(content, tab.id, { filter: "all", depth: 100, refId: null });
        return formatFind(scoreNodes(nodes, query), query);
      },
    },
  };
}
