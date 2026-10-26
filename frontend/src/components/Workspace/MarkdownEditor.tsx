import { useLayoutEffect, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { insertMarkdown } from "../../utils/markdown";
import s from "./Workspace.module.css";

type Snapshot = { value: string; start: number; end: number };
export function MarkdownEditor({ value, onChange, draft = true }: { value: string; onChange: (value: string) => void; draft?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const undo = useRef<Snapshot[]>([]);
  const redo = useRef<Snapshot[]>([]);
  const [preview, setPreview] = useState(false);
  const remember = (stack: Snapshot[], item: Snapshot) => { stack.push(item); if (stack.length > 100) stack.shift(); };
  const snapshot = (): Snapshot => ({ value, start: input.current?.selectionStart ?? value.length, end: input.current?.selectionEnd ?? value.length });
  const emit = (next: string, start: number, end = start) => {
    selection.current = { start, end };
    onChange(next);
  };
  useLayoutEffect(() => {
    const next = selection.current;
    if (!next || !input.current) return;
    selection.current = null;
    input.current.focus();
    input.current.setSelectionRange(next.start, next.end);
  }, [value, preview]);
  const insert = (before: string, after = "") => {
    const old = snapshot();
    remember(undo.current, old); redo.current = [];
    setPreview(false);
    emit(insertMarkdown(value, old.start, old.end, before, after), old.start + before.length, old.end + before.length);
  };
  const restore = (direction: "undo" | "redo") => {
    const from = direction === "undo" ? undo.current : redo.current;
    const to = direction === "undo" ? redo.current : undo.current;
    const previous = from.pop();
    if (!previous) return;
    remember(to, snapshot());
    setPreview(false);
    emit(previous.value, previous.start, previous.end);
  };
  return (
    <div className={s.form}>
      <div className={s.toolbar} role="group" aria-label="Режим редактора">
        <button type="button" className={s.button} aria-pressed={!preview} onClick={() => setPreview(false)}>Редактирование</button>
        <button type="button" className={s.button} aria-pressed={preview} onClick={() => setPreview(true)}>Предпросмотр</button>
      </div>
      {!preview && <>
        <div className={s.toolbar} role="toolbar" aria-label="Форматирование Markdown">
          <button type="button" className={s.button} title="Жирный · Cmd/Ctrl+B" onClick={() => insert("**", "**")}>Жирный</button>
          <button type="button" className={s.button} title="Курсив · Cmd/Ctrl+I" onClick={() => insert("*", "*")}>Курсив</button>
          <button type="button" className={s.button} onClick={() => insert("\n- ")}>Список</button>
          <button type="button" className={s.button} title="Ссылка · Cmd/Ctrl+K" onClick={() => insert("[", "](https://example.com)")}>Ссылка</button>
          <button type="button" className={s.button} onClick={() => insert("\n```gallery\n", "\n```\n")}>Галерея</button>
          <button type="button" className={s.button} onClick={() => insert("\n```chip\nФамилия: \nИмя: \nПочта: \n", "\n```\n")}>Контакт</button>
          <button type="button" className={s.button} title="Отменить · Cmd/Ctrl+Z" onClick={() => restore("undo")}>Отменить</button>
          <button type="button" className={s.button} title="Повторить · Cmd/Ctrl+Shift+Z" onClick={() => restore("redo")}>Повторить</button>
        </div>
        <label className={s.field}>
          Содержимое в Markdown
          <textarea ref={input} value={value} rows={18}
            onChange={(event) => {
              remember(undo.current, snapshot()); redo.current = [];
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
              const key = event.key.toLowerCase();
              if (["b", "i", "k", "z", "y"].includes(key)) event.preventDefault();
              if (key === "b") insert("**", "**");
              if (key === "i") insert("*", "*");
              if (key === "k") insert("[", "](https://example.com)");
              if (key === "z") restore(event.shiftKey ? "redo" : "undo");
              if (key === "y") restore("redo");
            }} />
        </label>
        <small className={s.muted}>Cmd/Ctrl+B — жирный, I — курсив, K — ссылка{draft ? ", S — сохранить черновик." : "."}</small>
      </>}
      {preview && <div className={s.previewBox}><MarkdownContent body={value} /></div>}
      <details className={s.details}>
        <summary>Как оформить материал</summary>
        <p>Выделите текст и выберите команду. Если выделения нет, начните писать внутри вставленной разметки. Список начинается с «- ».</p>
        <p>«Галерея» вставляет блок gallery: укажите внутри ссылки на изображения, каждую с новой строки. «Контакт» вставляет блок chip с полями карточки.</p>
        <p>Предпросмотр показывает текущий текст. {draft ? "Сохранение обновляет только черновик; публикация выполняется отдельной кнопкой." : "Изменения публикуются только по явному нажатию кнопки публикации."}</p>
      </details>
    </div>
  );
}
