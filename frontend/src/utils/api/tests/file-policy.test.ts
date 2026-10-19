import { expect, it } from "vitest";
import { fileAccept, fileMetadata } from "../../filePolicy";

it.each([
  ["avatar", "photo.JPG", "image/jpg", "image/jpeg"],
  ["avatar", "photo.png", "", "image/png"],
  ["pgas", "statement.pdf", "application/octet-stream", "application/pdf"],
  ["report", "archive.zip", "application/x-zip-compressed", "application/zip"],
])("normalizes browser metadata %s %s", (kind, name, type, mime_type) => {
  expect(fileMetadata(kind, { name, type, size: 100 }).mime_type).toBe(mime_type);
});
it.each([
  ["report", "animation.gif", "image/gif"], ["avatar", "photo.png", "image/jpeg"],
  ["pgas", "archive.zip", "application/zip"], ["report", "../a.pdf", "application/pdf"],
  ["report", "no-extension", "application/pdf"],
])("rejects unsupported or mismatched %s %s", (kind, name, type) => {
  expect(() => fileMetadata(kind, { name, type, size: 100 })).toThrow();
});
it.each([["avatar", 10], ["pgas", 20], ["report", 20]] as const)("enforces the inclusive %s size boundary", (kind, limit) => {
  const file = { name: "a.png", type: "image/png", size: limit * 1024 * 1024 };
  expect(fileMetadata(kind, file).size_bytes).toBe(file.size);
  expect(() => fileMetadata(kind, { ...file, size: file.size + 1 })).toThrow(/размер/);
  expect(() => fileMetadata(kind, { ...file, size: 0 })).toThrow(/размер/);
  expect(fileAccept(kind)).not.toContain(".gif");
});
