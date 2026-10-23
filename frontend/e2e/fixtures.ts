import { test as base, expect } from "@playwright/test";

const local = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Every page may reach only localhost; other requests are aborted and listed in `external`. */
export const test = base.extend<{ external: string[] }>({
  external: async ({ context }, provide) => {
    const external: string[] = [];
    await context.route(
      (url) => !["data:", "blob:"].includes(url.protocol) && !local.has(url.hostname),
      (route) => { external.push(new URL(route.request().url()).origin); return route.abort(); },
    );
    await provide(external);
  },
});
export { expect };
