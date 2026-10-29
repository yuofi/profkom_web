// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import axios from "axios";
import Cookies from "js-cookie";
import { liveLogin, liveParticipant, liveLegacyGuide, livePassword } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { api, apiUrl } from "../../utils/api";
import { filesApi } from "../../utils/api/files.api";
import { materialsApi } from "../../utils/api/materials.api";
import { richText } from "../../utils/api/contract";
import { LegacyMaterialRedirect } from "./LegacyMaterialRedirect";
import { MaterialPage } from "./MaterialPages";

// Step 8 of release 1 against the live local API: a file comes by its API address, which
// the server checks on every request (decision 23, АВ-9), with its own name (A-MAT-15);
// a gallery keeps its caption (A-MAT-3); an HTML guide shows as Markdown (A-MAT-14).
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; Cookies.remove("access_token"); });
const until = (predicate: () => boolean) => waitForPage(page!, predicate);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x73, 0x79, 0x6e);
// Node's HTTP client, not jsdom's XHR: like a browser it may send the cookie, and it reads
// every header of the answer.
const node = axios.create({ adapter: "http", validateStatus: () => true, responseType: "arraybuffer" });
const bearer = async (email: string) =>
  (await axios.post(`${api.defaults.baseURL}/auth/login`, { email, password: livePassword })).data.access_token as string;

async function publishedWith(body: (fileId: string) => string, file: File) {
  const draft = await materialsApi.create({ kind: "general", title: `Файлы ${crypto.randomUUID().slice(0, 6)}`, description: "", content: richText("Черновик") });
  const attached = await filesApi.upload(file, { owner_kind: "material", owner_id: draft.material_id, purpose: "material" });
  let m = await materialsApi.get(draft.material_id);
  m = await materialsApi.update(m.material_id, { expected_revision: m.revision, content: richText(body(attached.file_id)) });
  await materialsApi.publish(m.material_id, { expected_revision: m.revision });
  return { id: m.material_id, fileId: attached.file_id };
}

it("decision 23, A-MAT-3: a gallery picture loads by the checked address and keeps its caption", async () => {
  await liveLogin();
  const { id, fileId } = await publishedWith((f) => "```gallery\nfile:" + f + "|Подпись\n```", new File([PNG], "Схема.png", { type: "image/png" }));
  const reader = await liveParticipant("files-reader");
  const session = await liveLogin(reader.email);
  page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, { path: `/materials/${id}`, session });
  await until(() => !!page!.container.querySelector("figcaption"));
  expect(page.container.querySelector("figcaption")!.textContent).toBe("Подпись");
  const src = page.container.querySelector("figure img")!.getAttribute("src")!;
  expect(src).toBe(apiUrl(`/api/files/${fileId}/content`));
  // The <img> request carries the session cookie only.
  const cookie = { Cookie: `access_token=${Cookies.get("access_token")}` };
  const shown = await node.get(src, { headers: cookie });
  expect(shown.status).toBe(200);
  expect(new Uint8Array(shown.data)).toEqual(PNG);
  expect(shown.headers["content-type"]).toBe("image/png");
  expect(shown.headers["content-disposition"]).toBe(`inline; filename="_____.png"; filename*=UTF-8''${encodeURIComponent("Схема.png")}`);
  expect((await node.get(src)).status).toBe(401);
  // Archived: the very same request stops at once.
  const chair = axios.create({ baseURL: api.defaults.baseURL, headers: { Authorization: `Bearer ${await bearer("chair@example.com")}` } });
  await chair.post(`/accounts/${reader.user_id}/archive`, { reason: "Интеграционная проверка" });
  expect([401, 403]).toContain((await node.get(src, { headers: cookie })).status);
});

it("A-MAT-15: a download gets the name it was uploaded with", async () => {
  await liveLogin();
  const name = 'Отчёт "итог".pdf';
  const { fileId } = await publishedWith((f) => `[Отчёт](file:${f})`, new File([new TextEncoder().encode("%PDF-1.7 integration\n")], name, { type: "application/pdf" }));
  const reader = await liveParticipant("files-download");
  const link = (await filesApi.download(fileId)).download_url;
  expect(link).toBe(`/api/files/${fileId}/content`);
  const got = await node.get(apiUrl(link), { headers: { Authorization: `Bearer ${await bearer(reader.email)}` } });
  expect(got.status).toBe(200);
  expect(got.headers["content-disposition"]).toBe(
    `attachment; filename="_____ ____.pdf"; filename*=UTF-8''${encodeURIComponent("Отчёт итог.pdf")}`,
  );
  expect(got.headers["cache-control"]).toBe("private, no-cache");
});

it("A-MAT-14: an HTML guide opens at /docs/:id as formatted Markdown", async () => {
  const session = await liveLogin();
  const guide = await liveLegacyGuide({ title: `HTML-гайд ${crypto.randomUUID().slice(0, 6)}`, owner_block: "none", text: "<p>Абзац <strong>Жирный</strong></p>" });
  page = await mountWorkspace(<Routes><Route path="/docs/:id" element={<LegacyMaterialRedirect />} /><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, { path: `/docs/${guide.guide_id}`, session });
  await until(() => !!page!.container.querySelector("strong"));
  expect(page.container.querySelector("strong")!.textContent).toBe("Жирный");
  expect(page.container.textContent).not.toContain("<p>");
});
