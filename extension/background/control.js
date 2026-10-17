export const STOPPED_MESSAGE = "The user pressed Stop in Firefox. Stop using the browser and ask the user how to continue. Browser calls fail until they press Resume.";
export const IDLE_AFTER_MS = 20_000;

export function createControl({ sessions, onChange = async () => {}, idleAfterMs = IDLE_AFTER_MS }) {
  const controllers = new Map();
  const running = new Map();
  const idleTimers = new Map();

  function controllerOf(sessionId) {
    let controller = controllers.get(sessionId);
    if (!controller) controllers.set(sessionId, (controller = new AbortController()));
    return controller;
  }

  function begin(sessionId) {
    running.set(sessionId, (running.get(sessionId) ?? 0) + 1);
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
    sessions.setStatus(sessionId, "busy").catch(() => {});
  }

  function end(sessionId) {
    const left = (running.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      running.set(sessionId, left);
      return;
    }
    running.delete(sessionId);
    idleTimers.set(sessionId, setTimeout(() => {
      idleTimers.delete(sessionId);
      sessions.setStatus(sessionId, "idle").catch(() => {});
    }, idleAfterMs));
  }

  return {
    // The call's own work may continue after Stop, but its result is never delivered.
    async run(sessionId, fn) {
      if (await sessions.isStopped(sessionId)) throw new Error(STOPPED_MESSAGE);
      const { signal } = controllerOf(sessionId);
      begin(sessionId);
      try {
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error(STOPPED_MESSAGE));
          signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(() => fn(signal))
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
        });
      } finally {
        end(sessionId);
      }
    },

    async stop(sessionId) {
      await sessions.setStopped(sessionId, true);
      controllers.get(sessionId)?.abort();
      controllers.delete(sessionId);
      await onChange(sessionId);
    },

    async resume(sessionId) {
      await sessions.setStopped(sessionId, false);
      await onChange(sessionId);
    },
  };
}
