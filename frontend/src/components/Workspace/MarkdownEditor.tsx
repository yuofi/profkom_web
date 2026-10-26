import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { Glyph } from "./WorkspaceUI";
import { editorShortcut } from "../../utils/editorShortcuts";
import { insertMarkdown } from "../../utils/markdown";
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

function EditorTool({ label, title = label, className = "", disabled, onClick, children }: {
  label: string; title?: string; className?: string; disabled: boolean; onClick: () => void; children: ReactNode;
}) {
  return <button type="button" className={`${editor.tool} ${className}`} aria-label={label} title={title} disabled={disabled} onClick={onClick}>{children}</button>;
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
  const prefixLines = (prefix: (index: number) => string) => {
    if (disabled) return;
    const old = snapshot();
    remember(undo.current, old); redo.current = [];
    const start = old.start === 0 ? 0 : value.lastIndexOf("\n", old.start - 1) + 1;
    const endOfLine = value.indexOf("\n", old.end);
    const end = endOfLine < 0 ? value.length : endOfLine;
    const content = value.slice(start, end).split("\n").map((line, index) => prefix(index) + line).join("\n");
    setPreview(false);
    emit(value.slice(0, start) + content + value.slice(end), start, start + content.length);
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
        <button type="button" className={editor.tool} aria-label={preview ? "Редактирование" : "Предпросмотр"}
          aria-pressed={preview} title={preview ? "Вернуться к редактированию" : "Просмотр Markdown"} onClick={togglePreview}>
          <Glyph name={preview ? "edit" : "visibility"} />
        </button>
        {preview ? <span className={editor.mode}>Просмотр Markdown</span> : <>
          <span className={editor.separator} aria-hidden="true" />
          {<EditorTool label={"Отменить"} disabled={disabled} onClick={() => restore("undo")} title={"Отменить · Cmd/Ctrl+Z"}>{"↶"}</EditorTool>}
          {<EditorTool label={"Повторить"} disabled={disabled} onClick={() => restore("redo")} title={"Повторить · Cmd/Ctrl+Shift+Z"}>{"↷"}</EditorTool>}
          <span className={editor.separator} aria-hidden="true" />
          {<EditorTool label={"Жирный"} disabled={disabled} onClick={() => insert("**", "**")} title={"Жирный · Cmd/Ctrl+B"} className={editor.strong}>{"B"}</EditorTool>}
          {<EditorTool label={"Курсив"} disabled={disabled} onClick={() => insert("*", "*")} title={"Курсив · Cmd/Ctrl+I"} className={editor.italic}>{"I"}</EditorTool>}
          {<EditorTool label={"Зачёркнутый"} disabled={disabled} onClick={() => insert("~~", "~~")} title={"Зачёркнутый"} className={editor.strike}>{"S"}</EditorTool>}
          {<EditorTool label={"Заголовок"} disabled={disabled} onClick={() => prefixLines(() => "## ")}>{"H₂"}</EditorTool>}
          <span className={editor.separator} aria-hidden="true" />
          {<EditorTool label={"Маркированный список"} disabled={disabled} onClick={() => prefixLines(() => "- ")}>{"• ≡"}</EditorTool>}
          {<EditorTool label={"Нумерованный список"} disabled={disabled} onClick={() => prefixLines(index => `${index + 1}. `)}>{"1. ≡"}</EditorTool>}
          {<EditorTool label={"Чеклист"} disabled={disabled} onClick={() => prefixLines(() => "- [ ] ")}>{"☑"}</EditorTool>}
          {<EditorTool label={"Цитата"} disabled={disabled} onClick={() => prefixLines(() => "> ")}>{"❞"}</EditorTool>}
          {<EditorTool label={"Ссылка"} disabled={disabled} onClick={() => insert("[", "](https://example.com)")} title={"Ссылка · Cmd/Ctrl+K"}>{<Glyph name="share" />}</EditorTool>}
          {<EditorTool label={"Изображение"} disabled={disabled} onClick={() => insert("![", "](/avatars/default.svg)", "Описание изображения")}>{<Glyph name="image" />}</EditorTool>}
          {<EditorTool label={"Код в строке"} disabled={disabled} onClick={() => insert("`", "`", "код")} title={"Код в строке"} className={editor.code}>{"‹›"}</EditorTool>}
          {<EditorTool label={"Блок кода"} disabled={disabled} onClick={insertCodeBlock} title={"Блок кода"} className={editor.code}>{"{ }"}</EditorTool>}
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
      <small className={editor.hint}>Markdown · Cmd/Ctrl+B — жирный, I — курсив, K — ссылка{context === "material" && draft ? ", S — сохранить черновик." : "."}</small>
      <details className={s.details}>
        <summary>{context === "material" ? "Как оформить материал" : "Справка по Markdown"}</summary>
        <p>Выделите текст и выберите команду. Поддерживаются заголовки, списки, чеклисты, цитаты, ссылки, изображения, блоки кода и таблицы.</p>
        <p>Формула в строке: <code>{"$x^2$"}</code>. Отдельная формула: <code>{"$$\\sum_i x_i$$"}</code> на отдельных строках. Кнопка с глазом показывает текущий текст без отправки.</p>
        {context === "material" ? <>
          <p>«Галерея» вставляет блок gallery: укажите внутри ссылки на изображения, каждую с новой строки. «Контакт» вставляет блок chip с полями карточки.</p>
          <p>{draft ? "Сохранение обновляет только черновик; публикация выполняется отдельной кнопкой." : "Изменения публикуются только по явному нажатию кнопки публикации."}</p>
        </> : <p>Текст отправляется только по нажатию кнопки отправки или сохранения под редактором.</p>}
      </details>
    </div>
  );
}
