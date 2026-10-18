import { useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { insertMarkdown } from '../../utils/markdown';
import s from './Workspace.module.css';
export function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLTextAreaElement>(null); const [preview, setPreview] = useState(false);
  const insert = (before: string, after?: string) => { const target = input.current; onChange(insertMarkdown(value, target?.selectionStart ?? value.length, target?.selectionEnd ?? value.length, before, after)); target?.focus(); };
  return <div className={s.form}><div className={s.row} role="toolbar" aria-label="Форматирование Markdown"><button type="button" className={s.button} onClick={() => insert('**', '**')}>Жирный</button><button type="button" className={s.button} onClick={() => insert('*', '*')}>Курсив</button><button type="button" className={s.button} onClick={() => insert('\n- ')}>Список</button><button type="button" className={s.button} onClick={() => insert('[', '](https://example.com)')}>Ссылка</button><button type="button" className={s.button} onClick={() => insert('\n```gallery\n', '\n```\n')}>Галерея</button><button type="button" className={s.button} onClick={() => insert('\n```chip\nФамилия: \nИмя: \nПочта: \n', '\n```\n')}>Контакт</button></div><label className={s.field}>Содержимое в Markdown<textarea ref={input} value={value} rows={18} onChange={e => onChange(e.target.value)} /></label><button type="button" className={s.button} aria-expanded={preview} onClick={() => setPreview(!preview)}>Предпросмотр текущего текста</button>{preview && <MarkdownContent body={value} />}</div>;
}
