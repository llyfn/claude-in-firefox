export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const domainChangedMessage = (action) => `Page navigated to a different domain during ${action}. Re-read the tab state before retrying.`;

export async function assertSameHost(api, tab, action) {
  const now = await api.tabs.get(tab.id);
  if (hostOf(now.url) !== hostOf(tab.url)) throw new Error(domainChangedMessage(action));
}

// Frame 0 checks its own location right before dispatching. Other frames cannot read the
// top-level URL, so the background checks it just before sending them the operation.
export async function guardFor(api, tab, frameId, action) {
  if (frameId === 0) return { host: hostOf(tab.url), action };
  await assertSameHost(api, tab, action);
  return null;
}
