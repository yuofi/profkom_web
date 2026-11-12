// @vitest-environment jsdom
import axios from "axios";
import { afterEach, expect, it } from "vitest";
import { liveLogin, liveParticipant, livePassword } from "../../test/liveApi";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { api } from "../../utils/api";
import { materialsApi } from "../../utils/api/materials.api";
import { membershipApi } from "../../utils/api/membership.api";
import { MaterialContent } from "../../components/Workspace/MaterialContent";
import { wireIssues } from "../../test/wireContract";
import { richText } from "../../utils/api/contract";
import type { JournalDocument, JournalRender } from "../../utils/api/journal";
import example from "../../test/fixtures/journal-tracker.json";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });

it("round-trips a journal over HTTP, preserves the published version, and enforces reader and revision boundaries", async () => {
  const reader = await liveParticipant("journal-guide-reader");
  const session = await liveLogin();
  const block = (await membershipApi.blocks()).find(item => item.capabilities.includes("edit_block"))!;
  let material = await materialsApi.create({ kind: "guide", owner_block_id: block.block_id, title: `Журнал ${crypto.randomUUID()}`, description: "Синтетический гайд", content: richText("Прежняя публикация") });
  material = await materialsApi.audience(material.material_id, "everyone", { expected_revision: material.revision });
  material = await materialsApi.publish(material.material_id, { expected_revision: material.revision });
  const document = structuredClone(example) as JournalDocument;
  // File ownership/MIME are tested by the backend suite; this real-HTTP fixture
  // needs no upload or external storage provider.
  document.sections.forEach(section => { section.blocks = section.blocks.filter(block => block.type !== "image"); });
  const content = { format: "journal-v1" as const, body: JSON.stringify(document) };
  const preview = await materialsApi.preview(material.material_id, { expected_revision: material.revision, content });
  expect(wireIssues("MaterialText", preview)).toEqual([]);
  expect(wireIssues("JournalRender", preview.render)).toEqual([]);
  expect(preview.render?.diagnostics).toEqual([]);
  expect((preview.render as JournalRender).document).toEqual(document);
  expect((await materialsApi.get(material.material_id)).revision).toBe(material.revision);

  const invalid = structuredClone(document);
  invalid.sections[1].id = invalid.sections[0].id;
  material = await materialsApi.update(material.material_id, { expected_revision: material.revision, content: { ...content, body: JSON.stringify(invalid) } });
  expect(material.draft_content?.render?.diagnostics.length).toBeGreaterThan(0);
  expect(material.published_content?.body).toBe("Прежняя публикация");
  await expect(materialsApi.publish(material.material_id, { expected_revision: material.revision })).rejects.toMatchObject({ status: 422 });
  const stale = material.revision;
  material = await materialsApi.update(material.material_id, { expected_revision: material.revision, content });
  await expect(materialsApi.update(material.material_id, { expected_revision: stale, content })).rejects.toMatchObject({ status: 409 });
  expect(material.source_content?.body).toBe(content.body);
  expect(material.published_content?.body).toBe("Прежняя публикация");
  material = await materialsApi.publish(material.material_id, { expected_revision: material.revision });
  expect(wireIssues("Material", material)).toEqual([]);
  expect(material.published_content?.body).toBe(content.body);
  expect(material.published_content?.render?.source_hash).toBe(preview.render?.source_hash);

  const readonly = axios.create({ baseURL: api.defaults.baseURL, timeout: 10000, validateStatus: () => true });
  const login = await readonly.post("/auth/login", { email: reader.email, password: livePassword });
  expect(login.status).toBe(200);
  readonly.defaults.headers.common.Authorization = `Bearer ${login.data.access_token}`;
  const visible = await readonly.get(`/materials/${material.material_id}`);
  expect(visible.status).toBe(200);
  expect(visible.data).not.toHaveProperty("draft_content");
  expect(visible.data).not.toHaveProperty("source_content");
  expect([403, 404]).toContain((await readonly.post(`/materials/${material.material_id}/preview`, { expected_revision: material.revision, content })).status);
  page = await mountWorkspace(<MaterialContent content={visible.data.published_content} materialId={material.material_id} title={material.title} />, { session });
  await waitForPage(page, () => !!page!.container.querySelector('[role="tablist"]'));
  expect(page.container.textContent).toContain("Позовите нужных людей.");
  expect(page.container.querySelectorAll("h1")).toHaveLength(1);
  expect(page.container.querySelector('a[href$="-create"]')).not.toBeNull();
});
