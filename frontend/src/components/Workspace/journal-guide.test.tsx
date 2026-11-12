// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { GuideNode, GuideRender, MaterialText } from "../../utils/api/contract";
import type { JournalDocument, JournalRender } from "../../utils/api/journal";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import source from "../../test/fixtures/journal-tracker.json";
import compiled from "../../test/fixtures/journal-compiled.json";
import { JournalGuide } from "./JournalGuide";
import { MaterialContent } from "./MaterialContent";
import { checkedJournalRender, validJournalDocument } from "./journalPolicy";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
function fixture(edit?: (document: JournalDocument) => void): MaterialText {
  const document = structuredClone(source) as JournalDocument;
  edit?.(document);
  const render: JournalRender = { schema_version: 2, policy_version: 1, source_hash: "a".repeat(64), document, legacy: [], diagnostics: [], file_ids: ["file-journal-task", "file-hidden", "file-detail"], image_file_ids: ["file-journal-task", "file-hidden", "file-detail"] };
  return { format: "journal-v1", body: JSON.stringify(document), render };
}
const shown = () => page!.container;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click();await new Promise(resolve => setTimeout(resolve, 0)); }); };

it("composes one title, a compact section TOC and persistent author-facing anchors", async () => {
  const content = fixture(doc => doc.sections[0].blocks.push({ id: "nested", type: "text", body: "# Подзаголовок\n\n[К результату](#finish)" }));
  page = await mountWorkspace(<JournalGuide content={content} materialId="example" title="Практический гайд" />);
  expect(shown().querySelectorAll("h1")).toHaveLength(1);
  expect(shown().querySelector("h1")?.textContent).toBe("Практический гайд");
  expect(shown().querySelectorAll("nav a")).toHaveLength(3);
  expect(shown().querySelector("h3")?.textContent).not.toBe("");
  expect(shown().querySelector('a[href="#guide-example-finish"]')).not.toBeNull();
  await click(shown().querySelector('nav a[href="#guide-example-create"]')!);
  expect(document.activeElement?.id).toBe("guide-example-create");
  const reordered = fixture(doc => doc.sections.reverse());
  expect(checkedJournalRender(reordered)?.document?.sections[2].id).toBe("create");
});

it("keeps author section anchors distinct from the title and switcher control ids", async () => {
  const content = fixture(doc => {
    for (const id of ["title", "bot-example-title", "bot-example-tab-people", "bot-example-panel-people"]) {
      doc.sections.push({ id, label: "Проверка", title: `Раздел ${id}`, blocks: [{ id: `body-${id}`, type: "text", body: `[К разделу](#${id})` }] });
    }
  });
  page = await mountWorkspace(<JournalGuide content={content} materialId="collision" title="Название материала" />);
  const ids = [...shown().querySelectorAll("[id]")].map(element => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  const section = document.getElementById("guide-collision-title");
  expect(section?.tagName).toBe("H2");
  await click(shown().querySelector('nav a[href="#guide-collision-title"]')!);
  expect(document.activeElement).toBe(section);
  const tab = shown().querySelector('[role="tab"][aria-selected="true"]')!;
  const panel = document.getElementById(tab.getAttribute("aria-controls")!);
  expect(panel?.getAttribute("role")).toBe("tabpanel");
  expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
});

it("defers collapsed screenshots, supports zoom and restores focus when it closes", async () => {
  page = await mountWorkspace(<JournalGuide content={fixture()} materialId="example" title="Гайд" />);
  expect(shown().querySelectorAll("img")).toHaveLength(0);
  await click([...shown().querySelectorAll("summary")].find(item => item.textContent?.includes("настоящую"))!);
  const image = shown().querySelector("img")!;
  expect(image.getAttribute("src")).toMatch(/\/api\/files\/file-journal-task\/content$/);
  expect(image.getAttribute("width")).toBe("1360");
  const opener = shown().querySelector('button[aria-label^="Увеличить"]') as HTMLButtonElement;
  opener.focus();await click(opener);
  expect(shown().querySelector("dialog[open]")).not.toBeNull();
  await click([...shown().querySelectorAll("dialog button")].find(button => button.textContent === "Закрыть")!);
  expect(shown().querySelector("dialog")).toBeNull();expect(document.activeElement).toBe(opener);
});

it("keeps hidden panel and disclosure files unmounted; switches locally with arrows, Home and End", async () => {
  const content = fixture(doc => {
    const switcher = doc.sections[1].blocks.find(block => block.type === "switcher")!;
    if (switcher.type === "switcher") switcher.options[1].body += "\n\n![Скрытая](file:file-hidden)";
    doc.sections[1].blocks.push({ id: "private-detail", type: "disclosure", title: "Детали снимка", body: "![Детали](file:file-detail)" });
  });
  page = await mountWorkspace(<JournalGuide content={content} materialId="example" title="Гайд" />);
  expect(shown().querySelectorAll("img")).toHaveLength(0);
  const tabs = [...shown().querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  tabs[0].focus();await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");expect(document.activeElement).toBe(tabs[1]);
  expect(shown().querySelector('img[alt="Скрытая"]')).not.toBeNull();
  await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(tabs[0].getAttribute("aria-selected")).toBe("true");expect(shown().querySelector("img")).toBeNull();
  await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  await click([...shown().querySelectorAll("summary")].find(item => item.textContent === "Детали снимка")!);
  expect(shown().querySelector('img[alt="Детали"]')).not.toBeNull();
});

it("prints every example branch and closed screenshot, then restores the reading state", async () => {
  page = await mountWorkspace(<JournalGuide content={fixture()} materialId="example" title="Гайд" />);
  expect(shown().textContent).not.toContain("Все участники чата");
  await act(async () => window.dispatchEvent(new Event("beforeprint")));
  expect(shown().textContent).toContain("Все участники чата");
  expect(shown().querySelectorAll('[role="tabpanel"][hidden]')).toHaveLength(0);
  expect(shown().querySelector("img")).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event("afterprint")));
  expect(shown().textContent).not.toContain("Все участники чата");
  expect(shown().querySelector("img")).toBeNull();
});

it("routes journal content through its lazy reader without rewriting section ids", async () => {
  page = await mountWorkspace(<MaterialContent content={fixture()} materialId="lazy" title="Название материала" />);
  await waitForPage(page, () => !!shown().querySelector("[data-journal-guide]"));
  expect(shown().querySelector("h1")?.textContent).toBe("Название материала");
  expect(shown().querySelector("#guide-lazy-create")?.tagName).toBe("H2");
  expect(shown().querySelector("#guide-lazy-section-1")).toBeNull();
});

it.each([
  (doc: JournalDocument) => Object.assign(doc, { unexpected: true }),
  (doc: JournalDocument) => { doc.sections[1].id = doc.sections[0].id; },
  (doc: JournalDocument) => { doc.sections[0].blocks[0].id = doc.sections[0].id; },
  (doc: JournalDocument) => { doc.intro = "[Не существует](#missing)"; },
  (doc: JournalDocument) => { doc.intro = "![Внешнее](https://example.org/photo.png)"; },
  (doc: JournalDocument) => { doc.intro = "[Опасный переход](javascript:alert%281%29)"; },
  (doc: JournalDocument) => { doc.intro = "[API](/api/session)"; },
  (doc: JournalDocument) => { doc.intro = "```gallery\nhttps://example.org/photo.png | Фото\n```"; },
  (doc: JournalDocument) => { doc.sections[0].blocks.push({ id: "too-many", type: "switcher", title: "Выбор", options: Array.from({ length: 5 }, (_, index) => ({ id: `item-${index}`, label: "Пункт", body: "Текст" })) }); },
])("rejects unsafe or incompatible document shapes before mounting", mutate => {
  const content = fixture(mutate);expect(validJournalDocument((content.render as JournalRender).document)).toBe(false);expect(checkedJournalRender(content)).toBeNull();
});

it("rejects stale compiled sources and files absent from the artifact; keeps bad JSON inert", async () => {
  const stale = fixture();stale.body = stale.body.replace("Сначала", "Иначе");expect(checkedJournalRender(stale)).toBeNull();
  const missing = fixture();(missing.render as JournalRender).file_ids = [];expect(checkedJournalRender(missing)).toBeNull();
  const invalid = fixture();invalid.body = '<script>window.bad=true</script>';
  page = await mountWorkspace(<JournalGuide content={invalid} materialId="invalid" title="Сохранённый заголовок" />);
  expect(shown().querySelector('script')).toBeNull();expect(shown().querySelector('[role="alert"]')?.textContent).toContain("не прошло проверку");
  expect(shown().querySelector('h1')?.textContent).toBe("Сохранённый заголовок");
});

it("accepts reordered JSON keys, inert code examples and private reference images", () => {
  const content = fixture(doc => { doc.intro = '[Ссылка](https://example.org/help)\n\n`![Код](https://example.org/never.png)`\n\n![Снимок][picture]\n\n[picture]: file:file-journal-task'; });
  const parsed = JSON.parse(content.body);content.body = JSON.stringify({ sections: parsed.sections, cover: parsed.cover, intro: parsed.intro, eyebrow: parsed.eyebrow, version: 1 });
  expect(checkedJournalRender(content)).not.toBeNull();
});

it("retains imported v1 content while deferring its details and keeping one page title", async () => {
  const source = '<details><summary>Старый пример</summary><img src="file:file-detail" alt="Старый снимок" width="800" height="600"></details>\n';
  const content = fixture(doc => { doc.sections[0].blocks.push({ id: "old-guide", type: "legacy", body: `# Старый заголовок\n\n[К заголовку](#section-1)\n\n\`\`\`profkom-html id=old-panel\n${source}\`\`\`` }); });
  const text = (value: string): GuideNode => ({ tag: "text", attrs: {}, children: [], text: value });
  const legacy: GuideRender = { schema_version: 1, policy_version: 1, source_hash: "b".repeat(64), blocks: [{ id: "old-panel", source, text: "Старый пример", nodes: [{ tag: "details", attrs: {}, text: "", children: [{ tag: "summary", attrs: {}, text: "", children: [text("Старый пример")] }, { tag: "img", attrs: { src: "file:file-detail", alt: "Старый снимок", width: 800, height: 600 }, text: "", children: [] }] }] }], diagnostics: [], file_ids: ["file-detail"] };
  (content.render as JournalRender).legacy = [{ block_id: "old-guide", render: legacy }];
  page = await mountWorkspace(<JournalGuide content={content} materialId="example" title="Новый заголовок" />);
  await waitForPage(page, () => !!shown().querySelector("[data-guide-embed]"));
  expect(shown().querySelectorAll("h1")).toHaveLength(1);
  expect(shown().querySelector("img")).toBeNull();
  const heading = [...shown().querySelectorAll("h3")].find(item => item.textContent === "Старый заголовок")!;
  expect(heading.id).toMatch(/old-guide-section-1$/);
  await click([...shown().querySelectorAll("summary")].find(item => item.textContent === "Старый пример")!);
  expect(shown().querySelector('img[alt="Старый снимок"]')).not.toBeNull();
});

it("keeps bare contacts and chip fences inert in journal Markdown, with Unicode limits matching Python", async () => {
  const content = fixture(doc => {
    doc.intro = "😀".repeat(600);
    doc.sections[0].blocks.push({ id: "inert-contact", type: "text", body: "www.example.com\n\nchair@example.com\n\nhttp://example.com\n\n```chip\nФото: https://example.com/tracking.png\n```" });
  });
  expect(checkedJournalRender(content)).not.toBeNull();
  page = await mountWorkspace(<JournalGuide content={content} materialId="safe" title="Гайд" />);
  expect(shown().querySelectorAll("img")).toHaveLength(0);
  expect(shown().querySelector('a[href^="http"], a[href^="mailto"]')).toBeNull();
  expect(shown().querySelector("pre")?.textContent).toContain("Фото: https://example.com/tracking.png");
});

it("loads a replacement image after the previous file failed, without changing its block id", async () => {
  function Preview() {
    const [replacement, replace] = useState(false);
    const content = fixture(doc => { const image = doc.sections[0].blocks.find(block => block.type === "image")!;if (image.type === "image") { image.collapsed = false;image.file_id = replacement ? "file-hidden" : "file-journal-task"; } });
    return <><button type="button" onClick={() => replace(true)}>Другой файл</button><JournalGuide content={content} materialId="preview" title="Предпросмотр" /></>;
  }
  page = await mountWorkspace(<Preview />);
  await act(async () => shown().querySelector("img")!.dispatchEvent(new Event("error")));
  expect(shown().querySelector("img")).toBeNull();
  expect(shown().querySelector('[role="img"]')).not.toBeNull();
  await click([...shown().querySelectorAll("button")].find(button => button.textContent === "Другой файл")!);
  expect(shown().querySelector("img")?.getAttribute("src")).toMatch(/\/file-hidden\/content$/);
});

it.each(compiled)("matches the real Python compiler and renders safe output: $name", async example => {
  const content = example.content as MaterialText;
  expect(checkedJournalRender(content) !== null).toBe(example.valid);
  page = await mountWorkspace(<JournalGuide content={content} materialId="corpus" title="Проверенный гайд" />);
  if (example.valid) {
    await waitForPage(page);
    expect(shown().querySelector("[data-journal-guide]")).not.toBeNull();
    expect(shown().querySelectorAll("h1")).toHaveLength(1);
    expect(shown().querySelector('[role="alert"]')).toBeNull();
    expect([...shown().querySelectorAll("img")].every(image => /^http:\/\/127\.0\.0\.1:\d+\/api\/files\/file-[A-Za-z0-9_-]+\/content$/.test(image.src))).toBe(true);
    expect(shown().querySelector('a[href^="mailto:"]')).toBeNull();
  } else expect(shown().querySelector('[role="alert"]')).not.toBeNull();
});
