// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, settle } from "../../test/workspace";
import { api, apiUrl } from "../../utils/api";
import { filesApi } from "../../utils/api/files.api";
import { Avatar } from "../Avatar/Avatar";
import { Attachments } from "./Attachments";
import { MarkdownContent } from "./MarkdownContent";

// Step 8 of release 1: files come by API addresses that the server checks on every
// request (decision 23); in development the API has its own origin.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
const base = api.defaults.baseURL;
afterEach(async () => {
  await page?.cleanup(); page = undefined;
  api.defaults.baseURL = base; vi.restoreAllMocks();
});
const content = "/api/files/file-1/content";

it("decision 23: an API address goes to the API origin, other addresses stay", () => {
  api.defaults.baseURL = "http://localhost:18000/api";
  expect(apiUrl(content)).toBe("http://localhost:18000/api/files/file-1/content");
  api.defaults.baseURL = "/api";
  expect(apiUrl(content)).toBe(content);
  expect(apiUrl("/avatars/leaf.svg")).toBe("/avatars/leaf.svg");
  expect(apiUrl("https://global.s3.cloud.ru/bucket/avatars/a.png")).toBe("https://global.s3.cloud.ru/bucket/avatars/a.png");
  expect(apiUrl(undefined)).toBeUndefined();
});

it("decision 23: pictures and links of a material load from the API, the caption stays (A-MAT-3)", async () => {
  api.defaults.baseURL = "http://localhost:18000/api";
  page = await mountWorkspace(<MarkdownContent body={`![Схема](${content})\n\n[План](/api/files/file-2/content)\n\n\`\`\`gallery\n/api/files/file-3/content|Подпись\n\`\`\``} />);
  const images = Array.from(page.container.querySelectorAll("img")).map((i) => i.getAttribute("src"));
  expect(images).toContain("http://localhost:18000/api/files/file-1/content");
  expect(images).toContain("http://localhost:18000/api/files/file-3/content");
  expect(page.container.querySelector("a")?.getAttribute("href")).toBe("http://localhost:18000/api/files/file-2/content");
  expect(page.container.querySelector("figcaption")?.textContent).toBe("Подпись");
});

it("decision 23: an avatar the reader may no longer open falls back to the default", async () => {
  api.defaults.baseURL = "http://localhost:18000/api";
  page = await mountWorkspace(<Avatar src={content} />);
  const img = page.container.querySelector("img")!;
  expect(img.getAttribute("src")).toBe("http://localhost:18000/api/files/file-1/content");
  await act(async () => { img.dispatchEvent(new Event("error")); });
  expect(img.getAttribute("src")).toBe("/avatars/default.svg");
});

it("decision 23: a download asks the API first, then follows the checked address", async () => {
  const asked = vi.spyOn(filesApi, "download").mockResolvedValue({ download_url: content, expires_at: null });
  const clicked: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
  page = await mountWorkspace(<Attachments files={[{ file_id: "file-1", name: "Отчёт.pdf", mime_type: "application/pdf", size_bytes: 2048 }]} />);
  const button = page.container.querySelector("button")!;
  await act(async () => button.click());
  await settle();
  expect(asked).toHaveBeenCalledWith("file-1");
  expect(clicked).toEqual([{ href: new URL(apiUrl(content), window.location.origin).href, download: "Отчёт.pdf" }]);
});
