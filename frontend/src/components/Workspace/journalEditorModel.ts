import { z } from "zod";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "mdast";
import type { JournalBlock, JournalDocument, JournalSection } from "../../utils/api/journal";
import { createClientId } from "../../utils/clientId";

// Shape validation deliberately allows incomplete draft fields. Semantic validation
// belongs to the preview/compiler; unknown fields never disappear through editing.
const string = z.string(), number = z.number().finite();
const text = { body: string }, image = { file_id: string, alt: string, caption: string, width: number, height: number };
const block = z.discriminatedUnion("type", [
  z.strictObject({ id: string, type: z.literal("text"), ...text }),
  z.strictObject({ id: string, type: z.literal("note"), tone: z.enum(["neutral", "info", "success", "warning"]), title: string, ...text }),
  z.strictObject({ id: string, type: z.literal("comparison"), before_label: string, before: string, after_label: string, after: string }),
  z.strictObject({ id: string, type: z.literal("facts"), items: z.array(z.strictObject({ label: string, ...text })) }),
  z.strictObject({ id: string, type: z.literal("steps"), items: z.array(z.strictObject({ role: string, title: string, ...text })) }),
  z.strictObject({ id: string, type: z.literal("image"), ...image, collapsed: z.boolean() }),
  z.strictObject({ id: string, type: z.literal("disclosure"), title: string, ...text }),
  z.strictObject({ id: string, type: z.literal("switcher"), title: string, options: z.array(z.strictObject({ id: string, label: string, ...text })) }),
  z.strictObject({ id: string, type: z.literal("legacy"), ...text }),
]);
const schema = z.strictObject({ version: z.literal(1), eyebrow: string, intro: string,
  cover: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("poster"), eyebrow: string, title: string, caption: string, tone: z.enum(["yellow", "mint", "peach", "sky", "lilac"]) }), z.strictObject({ kind: z.literal("image"), ...image })]).nullable(),
  sections: z.array(z.strictObject({ id: string, label: string, title: string, blocks: z.array(block) })),
});

/** JSON.parse validates grammar but discards repeated keys before a reviver runs.
 * Scan the already-valid source as tokens, keeping a key set per object. Decode
 * key strings through JSON.parse so e.g. "intro" and "\u0069ntro" are identical.
 * The stack is iterative: a deeply nested invalid draft cannot exhaust recursion.
 */
function parseUniqueJson(source: string): unknown {
  const value: unknown = JSON.parse(source);
  const stack: ({ keys: Set<string>; keyExpected: boolean } | null)[] = [];
  for (let offset = 0; offset < source.length; offset++) {
    const token = source[offset];
    if (token === "{") stack.push({ keys: new Set(), keyExpected: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") { const current = stack.at(-1);if (current) current.keyExpected = true; }
    else if (token === '"') {
      let end = offset + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      const current = stack.at(-1);
      if (current?.keyExpected) {
        const key: string = JSON.parse(source.slice(offset, end + 1));
        if (current.keys.has(key)) throw Error("Повторяющееся поле JSON");
        current.keys.add(key);current.keyExpected = false;
      }
      offset = end;
    }
  }
  return value;
}
export function parseJournalDraft(source: string): { document: JournalDocument; error?: never } | { document?: never; error: string } {
  try {
    if (source.length > 262144 || new TextEncoder().encode(source).byteLength > 262144) return { error: "Исходник превышает 256 КиБ. Сократите его перед редактированием полей; текст сохранён целиком." };
    const result = schema.safeParse(parseUniqueJson(source));
    if (result.success) {
      if (result.data.sections.length > 20 || result.data.sections.some(section => section.blocks.length > 20) || result.data.sections.reduce((total, section) => total + section.blocks.length, 0) > 60) return { error: "В журнале может быть до 20 разделов, до 20 блоков в каждом и до 60 блоков всего. Сократите исходник; все данные сохранены." };
      const ids = result.data.sections.flatMap(section => [section.id, ...section.blocks.map(item => item.id)]);
      if (new Set(ids).size !== ids.length || result.data.sections.some(section => section.blocks.some(item => item.type === "switcher" && new Set(item.options.map(option => option.id)).size !== item.options.length))) return { error: "В исходнике повторяются номера разделов или блоков. Исправьте их в исходнике; содержание сохранено." };
      return { document: result.data };
    }
    return { error: "Структура журнала не распознана. Исправьте исходник или отмените последнее изменение. Все поля сохранены." };
  } catch (error) { return { error: error instanceof Error && error.message === "Повторяющееся поле JSON"
    ? "В исходнике повторяются поля JSON. Исправьте их или отмените последнее изменение. Ваш текст не потерян."
    : "В исходнике ошибка JSON. Исправьте её или отмените последнее изменение. Ваш текст не потерян." }; }
}
export const journalId = (prefix = "block") => `${prefix}-${createClientId()}`;
export const journalSource = (document: JournalDocument) => JSON.stringify(document, null, 2);
export const journalBlockNames: Record<JournalBlock["type"], string> = { text: "Текст", note: "Плашка", comparison: "Сравнение", facts: "Коротко о главном", steps: "Шаги", image: "Изображение", disclosure: "Подробности", switcher: "Варианты примера", legacy: "Прежние HTML-вставки" };
export function newJournalBlock(type: JournalBlock["type"]): JournalBlock {
  const id = journalId();
  switch (type) {
    case "text": case "legacy": return { id, type, body: "" };
    case "note": return { id, type, tone: "info", title: "Обратите внимание", body: "" };
    case "comparison": return { id, type, before_label: "Было", before: "", after_label: "Стало", after: "" };
    case "facts": return { id, type, items: [{ label: "Первое", body: "" }, { label: "Второе", body: "" }] };
    case "steps": return { id, type, items: [{ role: "", title: "Первый шаг", body: "" }, { role: "", title: "Второй шаг", body: "" }] };
    case "image": return { id, type, file_id: "", alt: "", caption: "", width: 960, height: 640, collapsed: false };
    case "disclosure": return { id, type, title: "Подробнее", body: "" };
    case "switcher": return { id, type, title: "Выберите пример", options: [{ id: journalId("option"), label: "Вариант 1", body: "" }, { id: journalId("option"), label: "Вариант 2", body: "" }] };
  }
}
export const newJournalSection = (): JournalSection => ({ id: journalId("section"), label: "", title: "Новый раздел", blocks: [newJournalBlock("text")] });
export function duplicateJournalBlock(block: JournalBlock): JournalBlock {
  const copy = structuredClone(block);copy.id = journalId();
  if (copy.type === "switcher") copy.options = copy.options.map(option => ({ ...option, id: journalId("option") }));
  return copy;
}
export function duplicateJournalSection(section: JournalSection): JournalSection {
  return { ...section, id: journalId("section"), title: `${section.title} — копия`, blocks: section.blocks.map(duplicateJournalBlock) };
}
export function moveJournalItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const result = [...items], [item] = result.splice(from, 1);result.splice(to, 0, item);return result;
}
const markdownParser = unified().use(remarkParse);
const nodeText = (node: RootContent): string => "value" in node && typeof node.value === "string" ? node.value : "children" in node ? node.children.map(child => nodeText(child as RootContent)).join("") : "";
/** Parse actual CommonMark headings: fences, indented code and literal trailing
 * hashes are not heading syntax. References have document-wide definitions; keep
 * such a source together rather than silently changing links or file ownership.
 */
export function importJournal(source: string, format: "markdown" | "markdown-embeds-v1"): JournalDocument {
  if (format === "markdown-embeds-v1") return { version: 1, eyebrow: "Гайд", intro: "", cover: null, sections: [{ id: journalId("section"), label: "", title: "Материал", blocks: [{ id: journalId(), type: "legacy", body: source }] }] };
  const tree = markdownParser.parse(source), ordinals = new Map<RootContent, number>();
  let heading = 0, references = false, formattedFences = false;
  const walk = (node: Root | RootContent) => {
    if (node.type === "definition") references = true;
    if (node.type === "code" && node.lang === "profkom-html") formattedFences = true;
    if (node.type === "heading") ordinals.set(node, ++heading);
    if ("children" in node) node.children.forEach(child => walk(child as RootContent));
  };
  walk(tree);
  if (references) {
    // The legacy reader retains old #section-N anchors and long Markdown sources.
    // When the source contains an inert profkom-html example, keep it in a text
    // block instead: conversion must never turn example code into active markup.
    return { version: 1, eyebrow: "Гайд", intro: "", cover: null, sections: [{ id: journalId("section"), label: "", title: "Материал", blocks: [{ id: journalId(), type: formattedFences ? "text" : "legacy", body: source }] }] };
  }
  const headings = tree.children.filter(node => node.type === "heading" && node.depth === 2);
  const sections: JournalSection[] = [];
  let cursor = 0, title = headings.length ? "Начало" : "Материал", sectionId = journalId("section");
  for (const node of headings) {
    const start = node.position!.start.offset!, end = node.position!.end.offset!;
    if (start > cursor || sections.length || cursor > 0) sections.push({ id: sectionId, label: "", title, blocks: [{ id: journalId(), type: "text", body: source.slice(cursor, start) }] });
    title = nodeText(node);sectionId = `section-${ordinals.get(node)}`;cursor = end;
    if (source.slice(cursor, cursor + 2) === "\r\n") cursor += 2;
    else if (source[cursor] === "\n") cursor++;
  }
  sections.push({ id: sectionId, label: "", title, blocks: [{ id: journalId(), type: "text", body: source.slice(cursor) }] });
  return { version: 1, eyebrow: "Гайд", intro: "", cover: null, sections };
}
export interface JournalHistory { past: string[]; present: string; future: string[] }
export function journalHistoryChange(history: JournalHistory, present: string): JournalHistory {
  return present === history.present ? history : { past: [...history.past.slice(-49), history.present], present, future: [] };
}
export function journalHistoryStep(history: JournalHistory, redo = false): JournalHistory {
  if (redo) { const [present, ...future] = history.future;return present === undefined ? history : { past: [...history.past, history.present], present, future }; }
  const present = history.past.at(-1);return present === undefined ? history : { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] };
}
