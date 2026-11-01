// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const execCommand = document.execCommand;
afterEach(() => { vi.unstubAllGlobals();document.execCommand = execCommand; });
it("uses the Clipboard API when the context provides it", async () => {
  const writeText = vi.fn(async () => undefined);vi.stubGlobal("navigator", { clipboard: { writeText } });
  await expect(copyText("http://127.0.0.1/tasks/1")).resolves.toBe(true);expect(writeText).toHaveBeenCalledWith("http://127.0.0.1/tasks/1");
});
it("copies a selected hidden field on an insecure origin and restores focus", async () => {
  vi.stubGlobal("navigator", {});const button = document.body.appendChild(document.createElement("button"));button.focus();
  let selected = "";document.execCommand = vi.fn(() => { selected = (document.activeElement as HTMLTextAreaElement).value;return true; });
  await expect(copyText("http://stand/tasks/1")).resolves.toBe(true);
  expect(selected).toBe("http://stand/tasks/1");expect(document.querySelector("textarea")).toBeNull();expect(document.activeElement).toBe(button);button.remove();
});
it("reports failure when neither way copies, so the link can be shown instead", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });document.execCommand = vi.fn(() => false);
  await expect(copyText("x")).resolves.toBe(false);
});
