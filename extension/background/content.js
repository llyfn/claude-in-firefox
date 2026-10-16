const NO_LISTENER = /Receiving end does not exist|Could not establish connection/i;

export function createContent(api, { timeoutMs = 25_000 } = {}) {
  async function inject(tabId, frameId) {
    const [main, topOnly] = api.runtime.getManifest().content_scripts;
    const files = [...main.js, ...(frameId === 0 && topOnly ? topOnly.js : [])];
    for (const file of files) await api.tabs.executeScript(tabId, { file: `/${file}`, frameId, runAt: "document_start" });
  }

  async function attempt(tabId, frameId, op, args) {
    const send = () => api.tabs.sendMessage(tabId, { op, args }, { frameId });
    let response;
    try {
      response = await send();
    } catch (err) {
      if (!NO_LISTENER.test(err?.message ?? "")) throw err;
      try {
        await inject(tabId, frameId);
      } catch {
        const tab = await api.tabs.get(tabId);
        throw new Error(`Cannot access this page (${tab.url}): Firefox does not allow extensions here.`);
      }
      response = await send();
    }
    if (response === undefined) throw new Error(`The page did not answer ${op}`);
    if (response.error) throw new Error(response.error);
    return response.value;
  }

  return {
    async call(tabId, frameId, op, args = {}) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The page did not respond to ${op} within ${timeoutMs / 1000}s`)), timeoutMs);
      });
      try {
        return await Promise.race([attempt(tabId, frameId, op, args), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
