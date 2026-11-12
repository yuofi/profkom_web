import { expect, it } from "vitest";
import type { JournalBlock } from "../../utils/api/journal";
import { duplicateJournalSection, importJournal, journalBlockNames, journalHistoryChange, journalHistoryStep, journalSource, moveJournalItem, newJournalBlock, parseJournalDraft } from "./journalEditorModel";

it("round-trips all structured fields and allows incomplete drafts without rebuilding IDs", () => {
  const document = importJournal("## Раздел\nТекст", "markdown");
  document.cover = { kind: "image", file_id: "image", alt: "Схема", caption: "Подпись", width: 100, height: 50 };
  document.sections[0].blocks = (Object.keys(journalBlockNames) as JournalBlock["type"][]).map(newJournalBlock);
  const source = journalSource(document);
  expect(parseJournalDraft(source).document).toEqual(document);
  expect(journalSource(parseJournalDraft(source).document!)).toBe(source);
});

it("imports H2 sections outside fenced code and keeps empty sections and all example code", () => {
  const code = "```md\n## Пример, не раздел\n```\n";
  const result = importJournal(`Вступление\n\n## Создать\n${code}## Пустой\n## Завершить\nГотово`, "markdown");
  expect(result.sections.map(section => section.title)).toEqual(["Начало", "Создать", "Пустой", "Завершить"]);
  expect(result.sections[1].blocks).toMatchObject([{ body: code }]);
  expect(result.sections[2].blocks).toMatchObject([{ body: "" }]);
  expect(result.sections[3].blocks).toMatchObject([{ body: "Готово" }]);
});

it("preserves the complete old HTML/Markdown source as one editable legacy block", () => {
  const source = "## Заголовок\n\n```profkom-html id=old\n<p>Текст</p>\n```\n";
  expect(importJournal(source, "markdown-embeds-v1").sections[0].blocks).toMatchObject([{ type: "legacy", body: source }]);
});

it("keeps anchors stable on reorder and regenerates section, block and switch option IDs only on duplication", () => {
  const document = importJournal("## Первая\n[Далее](#section-2)\n## Вторая\nТекст", "markdown");
  document.sections[0].blocks.push(newJournalBlock("switcher"));
  const moved = moveJournalItem(document.sections, 0, 1);
  expect(moved[1]).toBe(document.sections[0]);expect(moved[1].id).toBe("section-1");
  const copy = duplicateJournalSection(document.sections[0]);
  expect(copy.id).not.toBe(document.sections[0].id);
  expect(copy.blocks.map(block => block.id).some(id => document.sections[0].blocks.some(block => block.id === id))).toBe(false);
  const oldSwitch = document.sections[0].blocks[1], nextSwitch = copy.blocks[1];
  if (oldSwitch.type !== "switcher" || nextSwitch.type !== "switcher") throw Error("wrong fixture");
  expect(nextSwitch.options.map(option => option.id)).not.toEqual(oldSwitch.options.map(option => option.id));
  expect(nextSwitch.options.map(option => option.body)).toEqual(oldSwitch.options.map(option => option.body));
});

it("does not erase malformed JSON, unknown fields or duplicate IDs; undo/redo restores exact source", () => {
  const source = journalSource(importJournal("## Начало\nТекст", "markdown")), bad = source.slice(0, -1);
  expect(parseJournalDraft(bad).error).toContain("JSON");
  const document = JSON.parse(source);document.sections[0].blocks[0].futureField = "must not be lost";
  expect(parseJournalDraft(JSON.stringify(document)).error).toContain("Структура");
  delete document.sections[0].blocks[0].futureField;document.sections[0].blocks.push(document.sections[0].blocks[0]);
  expect(parseJournalDraft(JSON.stringify(document)).error).toContain("повторяются");
  const edited = journalHistoryChange({ past: [], present: source, future: [] }, bad), undone = journalHistoryStep(edited);
  expect(undone.present).toBe(source);expect(journalHistoryStep(undone, true).present).toBe(bad);
});

it("keeps document-wide reference links and images with their definitions without enabling HTML examples", () => {
  const source = '## Сначала\n![Схема][picture]\n[Трекер][tasks]\n\n```profkom-html id=inert-example\n<p>Пример кода, не вставка</p>\n```\n\n## Потом\n[picture]: file:file-import-image "Схема"\n[tasks]: /tasks\n';
  const document = importJournal(source, "markdown");
  expect(document.sections).toHaveLength(1);
  expect(document.sections[0].blocks).toMatchObject([{ type: "text", body: source }]);
  expect(journalSource(parseJournalDraft(journalSource(document)).document!)).toBe(journalSource(document));
});

it("keeps profkom-html examples inert in ordinary Markdown without reference definitions", () => {
  const example = '```profkom-html id=inert-example\n<p>Остаётся примером кода</p>\n```\n';
  const document = importJournal('## Первый\n' + example + '## Второй\nТекст', "markdown");
  expect(document.sections.map(section => section.title)).toEqual(["Первый", "Второй"]);
  expect(document.sections[0].blocks).toMatchObject([{ type: "text", body: example }]);
  expect(document.sections.flatMap(section => section.blocks).every(block => block.type === "text")).toBe(true);
});

it("retains old section anchors and long reference-style Markdown in one compatible block", () => {
  const source = '## First\n[Next][next]\n![Image][picture]\n' + 'Text. '.repeat(1500) + '\n\n## Second\n[next]: #section-2\n[picture]: file:file-import-image\n';
  const document = importJournal(source, "markdown");
  expect(document.sections).toHaveLength(1);
  expect(document.sections[0].blocks).toMatchObject([{ type: "legacy", body: source }]);
});

it("recognises CommonMark heading syntax and preserves literal hashes, escaped hashes and setext headings", () => {
  const document = importJournal('## C#\nПервый\n## C\\#\nВторой\n## Закрывающие ###\nТретий\n\nSetext\n------\nЧетвёртый\n', "markdown");
  expect(document.sections.map(section => section.title)).toEqual(["C#", "C#", "Закрывающие", "Setext"]);
  expect(document.sections.map(section => section.id)).toEqual(["section-1", "section-2", "section-3", "section-4"]);
});

it("keeps fenced/indented examples intact and does not treat their definitions as document references", () => {
  const source = '## Реальный\n\n````markdown\n## Не раздел\n```\n[picture]: file:file-example\n````\n\n    ## Тоже код\n    [other]: /tasks\n\n## Следующий\nТекст\n';
  const document = importJournal(source, "markdown");
  expect(document.sections.map(section => section.title)).toEqual(["Реальный", "Следующий"]);
  expect(document.sections[0].blocks).toMatchObject([{ body: '\n````markdown\n## Не раздел\n```\n[picture]: file:file-example\n````\n\n    ## Тоже код\n    [other]: /tasks\n\n' }]);
});

it.each([
  ['"intro":""', '"intro":"СОХРАНИТЬ ЭТО","intro":""'],
  ['"intro":""', '"intro":"СОХРАНИТЬ ЭТО","\\u0069ntro":""'],
  ['"body":"Текст"', '"body":"СОХРАНИТЬ ЭТО","body":"Текст"'],
  ['"body":"Текст"', '"body":"СОХРАНИТЬ ЭТО","bo\\u0064y":"Текст"'],
])("refuses repeated JSON object keys before field editing, including escaped keys (%s)", (before, after) => {
  const original = importJournal("## Раздел\nТекст", "markdown"), source = JSON.stringify(original).replace(before, after);
  expect(source).toContain("СОХРАНИТЬ ЭТО");
  const parsed = parseJournalDraft(source);expect(parsed.document).toBeUndefined();expect(parsed.error).toContain("повторяются поля JSON");
  const history = journalHistoryChange({ past: [], present: JSON.stringify(original), future: [] }, source);
  expect(journalHistoryStep(journalHistoryStep(history), true).present).toBe(source);
});

it("accepts escaped quotes, backslashes and JSON-looking body strings without false duplicate warnings", () => {
  const document = importJournal("## Раздел\nТекст", "markdown");
  document.intro = 'Пример: {"intro":"один","intro":"два"}. Путь C:\\docs\\file. Символ \\".';
  const block = document.sections[0].blocks[0];if (block.type !== "text") throw Error("Wrong fixture");
  const escapedValues = JSON.stringify(["}", "\\", '"']);
  block.body = '```json\n{"ключ": "один", "ключ": "два", "массив": ' + escapedValues + '}\n```';
  const source = journalSource(document);expect(parseJournalDraft(source).document).toEqual(document);
});
