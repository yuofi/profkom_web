// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { api } from "../../utils/api";
import { filesApi } from "../../utils/api/files.api";
import { materialsApi } from "../../utils/api/materials.api";
import { richText } from "../../utils/api/contract";
import { MaterialPage } from "./MaterialPages";
import { openMaterialEditor } from "../../test/materialEditor";

// FIX_PLAN 0.2 (A-MAT-1): editors work on the stored text. Readers used to get links
// signed for 5 minutes, now API addresses (decision 23); saving the shown text back
// used to replace file:<id> and old public links.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
// Seeded by live_api --integration-suite: links to an old public upload in the bucket.
const OLD = "https://global.s3.cloud.ru/synthetic/guides/%D0%A1%D1%82%D0%B0%D1%80%D1%8B%D0%B9.pdf";
const legacyGuide = async () => {
  const mapped = await materialsApi.resolveLegacyGuide(1), material = await materialsApi.get(mapped.material_id);
  expect(material.title).toMatch(/^Integration legacy guide/);return { ...material, ...mapped };
};
const pdf = () => new File([new TextEncoder().encode("%PDF-1.7 integration attachment\n")], "a.pdf", { type: "application/pdf" });
function button(label: string) {
  const found = Array.from(page!.container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}

it("0.2: saving and publishing without changes keeps file:<id> and the old link, never a signed URL", async () => {
  const session = await liveLogin();
  const id = (await legacyGuide()).material_id!;
  const attached = await filesApi.upload(pdf(), { owner_kind: "material", owner_id: id, purpose: "material" });
  const source = `Старый [файл](${OLD})\n\n[Вложение](file:${attached.file_id})`;
  let m = await materialsApi.get(id);
  m = await materialsApi.update(id, { expected_revision: m.revision, content: richText(source) });
  m = await materialsApi.publish(id, { expected_revision: m.revision });
  const shown = `/api/files/${attached.file_id}/content`;
  expect(m.published_content?.body).toBe(source.replace(`file:${attached.file_id}`, shown));
  page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, { path: `/materials/${id}`, session });
  await openMaterialEditor(page);
  expect(page.container.querySelector("textarea")!.value).toBe(source);
  await submit(button("Сохранить черновик").closest("form")!);
  await waitForPage(page, () => button("Опубликовать сохранённый черновик").disabled === false);
  expect((await materialsApi.get(id)).draft_content?.body).toBe(source);
  const publication = button("Опубликовать сохранённый черновик").closest("form")!;
  await submit(publication);
  await waitForPage(page, () => !!publication.textContent?.includes("Изменения сохранены"));
  const saved = await materialsApi.get(id);
  expect(saved.draft_content).toBeUndefined();
  expect(saved.source_content?.body).toBe(source);
  // The attachment stays readable for any participant once the material is published.
  await liveParticipant("storage-reader");
  expect((await filesApi.download(attached.file_id)).download_url).toBe(shown);
});

it("0.2: renaming an imported guide in the current editor preserves the exact stored source", async () => {
  const session = await liveLogin(), guide = await legacyGuide();
  const before = (await materialsApi.get(guide.material_id)).source_content?.body;
  expect(before).toContain(OLD);
  const sent: { url?: string; data: unknown }[] = [];
  const spy = api.interceptors.request.use(config => { sent.push({ url: config.url, data: config.data });return config; });
  try {
    page = await mountWorkspace(<Routes><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, { path: `/materials/${guide.material_id}`, session });
    await openMaterialEditor(page);
    const title = field(page.container, "title");expect(title.value).toBe(guide.title);
    await change(title, "Integration legacy guide (переименован)");
    await submit(title.closest("form")!);await waitForPage(page, () => !!page!.container.textContent?.includes("Изменения сохранены"));
  } finally { api.interceptors.request.eject(spy); }
  expect(sent.every(request => !request.url?.startsWith("/guides"))).toBe(true);
  const save = sent.find(request => request.url === `/materials/${guide.material_id}` && request.data);
  expect(save).toBeDefined();expect(save!.data).toMatchObject({ content: { body: before } });
  const after = await materialsApi.get(guide.material_id);
  expect(after.title).toBe("Integration legacy guide (переименован)");expect(after.source_content?.body).toBe(before);
});
