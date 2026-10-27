// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { liveLogin, liveParticipant } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { api } from "../../utils/api";
import { authApi } from "../../utils/api/auth.api";
import { filesApi } from "../../utils/api/files.api";
import { guidesApi } from "../../utils/api/guides.api";
import { materialsApi } from "../../utils/api/materials.api";
import { richText } from "../../utils/api/contract";
import { UserContext } from "../../utils/me";
import { GuidesManagement } from "../Admin/panels/GuidesManagement";
import { MaterialPage } from "./MaterialPages";
import { openMaterialEditor } from "../../test/materialEditor";

// FIX_PLAN 0.2 (A-MAT-1): editors work on the stored text. Readers used to get links
// signed for 5 minutes, now API addresses (decision 23); saving the shown text back
// used to replace file:<id> and old public links.
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
// Seeded by live_api --integration-suite: links to an old public upload in the bucket.
const OLD = "https://global.s3.cloud.ru/synthetic/guides/%D0%A1%D1%82%D0%B0%D1%80%D1%8B%D0%B9.pdf";
const legacyGuide = async () => (await guidesApi.getAll()).find(g => g.title.startsWith("Integration legacy guide"))!;
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

it("0.2: renaming a guide in Admin → Гайды sends no text and keeps the source byte for byte", async () => {
  const session = await liveLogin();
  const me = (await authApi.getMe()).data;
  const guide = await legacyGuide();
  const before = (await materialsApi.get(guide.material_id!)).source_content?.body;
  expect(before).toContain(OLD);
  const sent: unknown[] = [];
  const spy = api.interceptors.request.use(config => {
    if (config.url === `/guides/${guide.guide_id}`) sent.push(config.data);
    return config;
  });
  try {
    page = await mountWorkspace(<UserContext.Provider value={me}><GuidesManagement /></UserContext.Provider>, { path: "/admin", session });
    await waitForPage(page, () => !!page!.container.textContent?.includes(guide.title));
    const row = Array.from(page.container.querySelectorAll("tr")).find(r => r.querySelector("td")?.textContent === guide.title);
    const edit = row?.querySelector<HTMLButtonElement>('button[title="Изменить настройки гайда"]');
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await waitForPage(page, () => !!page!.container.querySelector('input[name="title"]'));
    const title = field(page.container, "title") as HTMLInputElement;
    expect(title.value).toBe(guide.title);
    await change(title, "Integration legacy guide (переименован)");
    await submit(title.closest("form")!);
    await waitForPage(page, () => sent.length > 0);
  } finally {
    api.interceptors.request.eject(spy);
  }
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty("text");
  const after = await materialsApi.get(guide.material_id!);
  expect(after.title).toBe("Integration legacy guide (переименован)");
  expect(after.source_content?.body).toBe(before);
});
