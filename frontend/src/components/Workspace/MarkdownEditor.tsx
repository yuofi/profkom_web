import { useLayoutEffect, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { Glyph } from "./WorkspaceUI";
import { editorShortcut } from "../../utils/editorShortcuts";
import { insertMarkdown, transformMarkdownLines } from "../../utils/markdown";
import { FormattingTool as EditorTool, FormattingMenu, EditorIcon } from "./MarkdownTools";
import s from "./Workspace.module.css";
import editor from "./MarkdownEditor.module.css";

type Snapshot = { value: string; start: number; end: number };
export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  draft?: boolean;
  label?: string;
  name?: string;
  rows?: number;
  context?: "material" | "comment" | "result" | "task";
  placeholder?: string;
  disabled?: boolean;
}

/** The source stays Markdown: inserting a command never rewrites the rest of a document. */
export function MarkdownEditor({
  value, onChange, draft = true, label = "Содержимое в Markdown", name, rows = 18,
  context = "material", placeholder, disabled = false,
}: MarkdownEditorProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number; scrollTop?: number } | null>(null);
  const beforeInput = useRef<Snapshot | null>(null);
  const undo = useRef<Snapshot[]>([]);
  const redo = useRef<Snapshot[]>([]);
  const [preview, setPreview] = useState(false);
  const remember = (stack: Snapshot[], item: Snapshot) => { stack.push(item); if (stack.length > 100) stack.shift(); };
  const snapshot = (): Snapshot => ({ value, start: input.current?.selectionStart ?? value.length, end: input.current?.selectionEnd ?? value.length });
  const emit = (next: string, start: number, end = start) => {
    beforeInput.current = null;
    selection.current = { start, end };
    onChange(next);
  };
  useLayoutEffect(() => {
    const next = selection.current;
    if (!next || !input.current) return;
    selection.current = null;
    input.current.focus();
    input.current.setSelectionRange(next.start, next.end);
    if (next.scrollTop !== undefined) input.current.scrollTop = next.scrollTop;
  }, [value, preview]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    // Native beforeinput runs before the DOM caret moves; onChange already sees the new caret.
    const capture = () => { beforeInput.current = { value, start: node.selectionStart, end: node.selectionEnd }; };
    node.addEventListener("beforeinput", capture);
    return () => node.removeEventListener("beforeinput", capture);
  }, [value, preview]);
  const insert = (before: string, after = "", fallback = "") => {
    if (disabled) return;
    const old = snapshot();
    remember(undo.current, old); redo.current = [];
    const selected = value.slice(old.start, old.end);
    const middle = selected || fallback;
    setPreview(false);
    emit(insertMarkdown(value, old.start, old.end, before + (selected ? "" : fallback), after), old.start + before.length, old.start + before.length + middle.length);
  };
  const editLines = (transform: (line: string, index: number) => string) => {
    if (disabled) return;
    const old = snapshot();
    const next = transformMarkdownLines(value, old.start, old.end, transform);
    if (next.value === value) { input.current?.focus();input.current?.setSelectionRange(old.start, old.end);return; }
    remember(undo.current, old);redo.current = [];
    setPreview(false);emit(next.value, next.start, next.end);
  };
  const prefixLines = (prefix: (index: number) => string) => editLines((line, index) => prefix(index) + line);
  const heading = (level: number) => editLines(line => line.replace(/^([ \t]{0,3})(?:#{1,6}[ \t]+)?(.*)$/, (_all, indent: string, text: string) => indent + "#".repeat(level) + (level ? " " : "") + text));
  const list = (ordered: boolean) => editLines((line, index) => {
    const bare = line.replace(/^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, "$1");
    return bare.replace(/^([ \t]*)(.*)$/, (_all, indent: string, text: string) => `${indent}${ordered ? `${index + 1}.` : "-"} ${text}`);
  });
  const indent = (out = false) => {
    const firstIndex = value.slice(0, input.current?.selectionStart ?? value.length).split("\n").length - 1;
    const lines = value.split("\n");
    const width = (space: string) => space.replace(/\t/g, "    ").length;
    const item = (line: string) => {
      const match = line.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)(.*)$/);
      return match ? { space: match[1], depth: width(match[1]), marker: match[2], gap: match[3], ordered: /^\d/.test(match[2]) } : null;
    };
    const first = item(lines[firstIndex]);
    if (!first) { editLines(line => out ? line.replace(/^(?: {1,2}|\t)/, "") : "  " + line);return; }
    let predecessor: { index: number; entry: NonNullable<ReturnType<typeof item>> } | null = null;
    for (let index = firstIndex - 1; index >= 0; index--) {
      if (!lines[index].trim()) continue;
      const entry = item(lines[index]);
      if (entry && (out ? entry.depth < first.depth : entry.depth <= first.depth)) { predecessor = { index, entry };break; }
      if (!entry && width(lines[index].match(/^[ \t]*/)?.[0] ?? "") <= first.depth) break;
    }
    // A first item has no parent to nest under; indenting it would only create a code block.
    if ((!out && (!predecessor || predecessor.entry.depth !== first.depth)) || (out && first.depth === 0)) {
      input.current?.focus();return;
    }
    const target = out ? predecessor?.entry.depth ?? Math.max(0, first.depth - 4)
      : predecessor!.entry.depth + Math.max(4, predecessor!.entry.marker.length + width(predecessor!.entry.gap));
    const delta = target - first.depth;
    let ordinal = out && predecessor?.entry.ordered ? Number.parseInt(predecessor.entry.marker, 10) + 1 : 1;
    if (!out && predecessor) {
      for (let index = predecessor.index + 1; index < firstIndex; index++) {
        const child = item(lines[index]);
        if (child?.ordered && child.depth === target) ordinal = Number.parseInt(child.marker, 10) + 1;
      }
    }
    editLines(line => {
      const current = item(line);
      let next = line;
      if (current?.ordered && current.depth === first.depth) next = line.replace(/^(\s*)\d+([.)])/, (_all, space: string, delimiter: string) => `${space}${ordinal++}${delimiter}`);
      if (delta >= 0) return " ".repeat(delta) + next;
      let remaining = -delta, index = 0;
      while (remaining > 0 && /[ \t]/.test(next[index] ?? "")) { remaining -= next[index] === "\t" ? 4 : 1;index++; }
      return " ".repeat(Math.max(0, -remaining)) + next.slice(index);
    });
  };
  const insertCodeBlock = () => {
    const selected = value.slice(input.current?.selectionStart ?? value.length, input.current?.selectionEnd ?? value.length);
    const longest = Math.max(2, ...Array.from(selected.matchAll(/`+/g), match => match[0].length));
    const fence = "`".repeat(longest + 1);
    insert(`\n${fence}text\n`, `\n${fence}\n`, "Код");
  };
  const restore = (direction: "undo" | "redo") => {
    if (disabled) return;
    const from = direction === "undo" ? undo.current : redo.current;
    const to = direction === "undo" ? redo.current : undo.current;
    const previous = from.pop();
    if (!previous) return;
    remember(to, snapshot());
    setPreview(false);
    emit(previous.value, previous.start, previous.end);
  };
  const togglePreview = () => {
    if (input.current) selection.current = { start: input.current.selectionStart, end: input.current.selectionEnd, scrollTop: input.current.scrollTop };
    setPreview(!preview);
  };
  return (
    <div className={editor.editor}>
      <div className={editor.toolbar} role="toolbar" aria-label="Форматирование Markdown">
        <EditorTool label={preview ? "Редактирование" : "Предпросмотр"} disabled={false}
          aria-pressed={preview} hint={preview ? "Вернуться к редактированию" : "Просмотр Markdown"} onClick={togglePreview}>
          <Glyph name={preview ? "edit" : "visibility"} />
        </EditorTool>
        {preview ? <span className={editor.mode}>Просмотр Markdown</span> : <>
          <span className={editor.separator} aria-hidden="true" />
          {<EditorTool label={"Отменить"} disabled={disabled} onClick={() => restore("undo")} hint={"Отменить · Cmd/Ctrl+Z"}><EditorIcon name="undo" /></EditorTool>}
          {<EditorTool label={"Повторить"} disabled={disabled} onClick={() => restore("redo")} hint={"Повторить · Cmd/Ctrl+Shift+Z"}><EditorIcon name="redo" /></EditorTool>}
          <span className={editor.separator} aria-hidden="true" />
          {<EditorTool label={"Жирный"} disabled={disabled} onClick={() => insert("**", "**")} hint={"Жирный · Cmd/Ctrl+B"} className={editor.strong}>{"B"}</EditorTool>}
          {<EditorTool label={"Курсив"} disabled={disabled} onClick={() => insert("*", "*")} hint={"Курсив · Cmd/Ctrl+I"} className={editor.italic}>{"I"}</EditorTool>}
          {<EditorTool label={"Зачёркнутый"} disabled={disabled} onClick={() => insert("~~", "~~")} hint={"Зачёркнутый"} className={editor.strike}>{"S"}</EditorTool>}
          <FormattingMenu label="Заголовок" disabled={disabled} items={Array.from({ length: 7 }, (_, level) => ({ label: level ? `Заголовок ${level}` : "Текст", icon: level ? `H${level}` : "T", shortcut: `⌥⌘${level}`, action: () => heading(level) }))}><span>H</span></FormattingMenu>
          <span className={editor.separator} aria-hidden="true" />
          <FormattingMenu label="Список" disabled={disabled} items={[
            { label: "Маркированный список", icon: <EditorIcon name="bullets" />, shortcut: "⇧⌘L", action: () => list(false) },
            { label: "Нумерованный список", icon: <EditorIcon name="numbered" />, shortcut: "⇧⌘M", action: () => list(true) },
            { label: "Увеличить отступ", icon: <EditorIcon name="indent" />, action: () => indent() },
            { label: "Уменьшить отступ", icon: <EditorIcon name="outdent" />, action: () => indent(true) },
          ]}><EditorIcon name="bullets" /></FormattingMenu>
          {<EditorTool label={"Чеклист"} disabled={disabled} onClick={() => prefixLines(() => "- [ ] ")}>{"☑"}</EditorTool>}
          {<EditorTool label={"Цитата"} disabled={disabled} onClick={() => prefixLines(() => "> ")}>{"❞"}</EditorTool>}
          {<EditorTool label={"Ссылка"} disabled={disabled} onClick={() => insert("[", "](https://example.com)")} hint={"Ссылка · Cmd/Ctrl+K"}><EditorIcon name="link" /></EditorTool>}
          {<EditorTool label={"Изображение"} disabled={disabled} onClick={() => insert("![", "](/avatars/default.svg)", "Описание изображения")}>{<Glyph name="image" />}</EditorTool>}
          {<EditorTool label={"Код в строке"} disabled={disabled} onClick={() => insert("`", "`", "код")} hint={"Код в строке"} className={editor.code}>{"‹›"}</EditorTool>}
          {<EditorTool label={"Блок кода"} disabled={disabled} onClick={insertCodeBlock} hint={"Блок кода"} className={editor.code}>{"{ }"}</EditorTool>}
          {<EditorTool label={"Таблица"} disabled={disabled} onClick={() => insert("\n\n| Заголовок 1 | Заголовок 2 | Заголовок 3 |\n| --- | --- | --- |\n| Ячейка 1 | Ячейка 2 | Ячейка 3 |\n| Ячейка 4 | Ячейка 5 | Ячейка 6 |\n\n")}>{"▦"}</EditorTool>}
          {<EditorTool label={"Формула в строке"} disabled={disabled} onClick={() => insert("$", "$", "x^2")}>{"𝑥²"}</EditorTool>}
          {<EditorTool label={"Формула отдельным блоком"} disabled={disabled} onClick={() => insert("\n$$\n", "\n$$\n", "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}")}>{"∑"}</EditorTool>}
          {<EditorTool label={"Разделитель"} disabled={disabled} onClick={() => insert("\n\n---\n\n")}>{"—"}</EditorTool>}
          {context === "material" && <>
            {<EditorTool label={"Галерея"} disabled={disabled} onClick={() => insert("\n```gallery\n", "\n```\n")}>{<Glyph name="layers" />}</EditorTool>}
            {<EditorTool label={"Контакт"} disabled={disabled} onClick={() => insert("\n```chip\nФамилия: \nИмя: \nПочта: \n", "\n```\n")}>{<Glyph name="contacts" />}</EditorTool>}
          </>}
        </>}
      </div>
      {!preview && <label className={editor.label}>
        {label}
        <textarea ref={input} name={name} className={editor.input} value={value} rows={rows} placeholder={placeholder} disabled={disabled}
          onChange={(event) => {
            remember(undo.current, beforeInput.current ?? snapshot()); redo.current = [];
            beforeInput.current = null;
            onChange(event.target.value);
          }}
          onKeyDown={(event) => {
            const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
            if (!disabled && !composing) {
              const digit = event.code?.match(/^Digit([0-6])$/)?.[1] ?? (/^[0-6]$/.test(event.key) ? event.key : undefined);
              if ((event.metaKey || event.ctrlKey) && event.altKey && digit !== undefined) { event.preventDefault();heading(Number(digit));return; }
              if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && ["KeyL", "KeyM"].includes(event.code)) { event.preventDefault();list(event.code === "KeyM");return; }
              if (event.key === "Tab" && (input.current?.selectionStart !== input.current?.selectionEnd || /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(value.slice(value.lastIndexOf("\n", (input.current?.selectionStart ?? 0) - 1) + 1)))) { event.preventDefault();indent(event.shiftKey);return; }
            }
            const key = editorShortcut(event);
            if (!key || disabled) return;
            if (["b", "i", "k", "z", "y"].includes(key)) event.preventDefault();
            if (key === "b") insert("**", "**");
            if (key === "i") insert("*", "*");
            if (key === "k") insert("[", "](https://example.com)");
            if (key === "z") restore(event.shiftKey ? "redo" : "undo");
            if (key === "y") restore("redo");
          }} />
      </label>}
      {preview && <div className={editor.preview} role="region" aria-label={`Просмотр: ${label}`}>
        {value.trim() ? <MarkdownContent body={value} /> : <p className={editor.empty}>Здесь появится отформатированный текст.</p>}
      </div>}
      {context !== "comment" && <details className={s.details}>
        <summary>{context === "material" ? "Как оформить материал" : "Справка по Markdown"}</summary>
        <p>Выделите текст и выберите команду. Поддерживаются заголовки, списки, чеклисты, цитаты, ссылки, изображения, блоки кода и таблицы.</p>
        <p>Формула в строке: <code>{"$x^2$"}</code>. Отдельная формула: <code>{"$$\\sum_i x_i$$"}</code> на отдельных строках. Кнопка с глазом показывает текущий текст без отправки.</p>
        {context === "material" ? <>
          <p>«Галерея» вставляет блок gallery: укажите внутри ссылки на изображения, каждую с новой строки. «Контакт» вставляет блок chip с полями карточки.</p>
          <p>{draft ? "Сохранение обновляет только черновик; публикация выполняется отдельной кнопкой." : "Изменения публикуются только по явному нажатию кнопки публикации."}</p>
        </> : <p>Текст отправляется только по нажатию кнопки отправки или сохранения под редактором.</p>}
      </details>}
    </div>
  );
}
