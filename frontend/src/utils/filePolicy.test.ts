import { expect, it } from "vitest";
import { fileAccept, fileMetadata } from "./filePolicy";
it("accepts browser code MIME variants as sealed plain text", () => {
  for (const [name, type] of [["script.py", "text/x-python"], ["client.ts", "video/mp2t"], ["view.tsx", "text/typescript"], ["script.js", "application/javascript"], ["settings.json", "application/json"], ["notes.md", "text/markdown"], ["main.rs", ""], ["script.sh", "application/x-sh"]]) {
    expect(fileMetadata("task", { name, type, size: 15 })).toEqual({ name, mime_type: "text/plain", size_bytes: 15 });
    expect(fileAccept("task").split(",")).toContain(`.${name.split(".").at(-1)}`);
  }
});
it("retains context restrictions and refuses executable document types and MIME mismatch", () => {
  for (const [kind, name, type] of [["avatar", "script.py", "text/x-python"], ["pgas", "settings.json", "application/json"], ["task", "page.html", "text/html"], ["task", "vector.svg", "image/svg+xml"], ["task", "script.py", "application/pdf"], ["task", "photo.png", "text/x-python"]]) {
    expect(() => fileMetadata(kind, { name, type, size: 15 })).toThrow();
  }
});
