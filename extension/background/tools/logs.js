export function logTools({ store }) {
  return {
    read_console_messages: {
      tabScoped: true,
      run: async ({ tab, args }) => store.readConsole(tab.id, { onlyErrors: args.onlyErrors === true, pattern: args.pattern, limit: args.limit ?? 100, clear: args.clear === true }),
    },
    read_network_requests: {
      tabScoped: true,
      run: async ({ tab, args }) => store.readNetwork(tab.id, { urlPattern: args.urlPattern, limit: args.limit ?? 100, clear: args.clear === true }),
    },
  };
}
