import { useEffect, useId, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import s from "./MaterialContent.module.css";

/** Derive navigation from the actual safe Markdown output, including setext headings. */
export function MaterialContent({ body }: { body: string }) {
  const root = useRef<HTMLDivElement>(null), prefix = useId();
  const [headings, setHeadings] = useState<{ id: string; title: string; level: number }[]>([]);
  useEffect(() => {
    const items = [...root.current!.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].map((element, index) => {
      element.id = `${prefix}-section-${index}`;
      element.tabIndex = -1;
      return { id: element.id, title: element.textContent ?? "Раздел", level: Number(element.tagName.slice(1)) };
    });
    setHeadings(items);
  }, [body, prefix]);
  return <div className={s.layout}>
    {headings.length > 1 && <nav className={s.toc} aria-label="Содержание материала"><details open><summary>Содержание</summary><ol>{headings.map(item => <li key={item.id} style={{ paddingInlineStart: `${Math.max(0, item.level - 1) * 10}px` }}><a href={`#${item.id}`} onClick={event => { event.preventDefault();const target = document.getElementById(item.id);target?.scrollIntoView({ block: "start", behavior: "smooth" });target?.focus({ preventScroll: true }); }}>{item.title}</a></li>)}</ol></details></nav>}
    <div ref={root} className={s.body}><MarkdownContent body={body} /></div>
  </div>;
}
