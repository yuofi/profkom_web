import { vi } from "vitest";

//Object.defineProperty(document, "cookie", {
//  writable: true,
//  value: "",
//});


vi.mock("js-cookie", () => {
  const store = new Map<string, string>();
  return {
    default: {
      get: vi.fn((key: string) => store.get(key)),
      set: vi.fn((key: string, value: string) => { store.set(key, value); }),
      remove: vi.fn((key: string) => { store.delete(key); }),
    },
  };
});