export function createReassembler({ now = () => Date.now(), maxAgeMs = 60_000 } = {}) {
  const pending = new Map();
  return {
    push(part) {
      for (const [id, entry] of pending) if (now() - entry.startedAt > maxAgeMs) pending.delete(id);
      let entry = pending.get(part.msgId);
      if (!entry) {
        entry = { chunks: new Array(part.total), received: 0, startedAt: now() };
        pending.set(part.msgId, entry);
      }
      if (entry.chunks[part.index] === undefined) {
        entry.chunks[part.index] = part.data;
        entry.received++;
      }
      if (entry.received < part.total) return null;
      pending.delete(part.msgId);
      return JSON.parse(entry.chunks.join(""));
    },
  };
}
