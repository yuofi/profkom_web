import { lazy, Suspense, useCallback, useLayoutEffect, useId, useRef, useState } from "react";
import type { MaterialText } from "../../utils/api/contract";
import { MarkdownContent } from "./MarkdownContent";
import s from "./MaterialContent.module.css";
const GuideEmbeds = lazy(() => import("./GuideEmbeds").then(module => ({ default: module.GuideEmbeds })));
const JournalGuide = lazy(() => import("./JournalGuide").then(module => ({ default: module.JournalGuide })));

export function MaterialContent({ body = "", content, materialId, title = "Гайд", description, showToc = true }: { body?: string; content?: MaterialText; materialId?: string; title?: string; description?: string; showToc?: boolean }) {
  const instance = useId(), id = materialId ?? instance;
  return content?.format === "journal-v1" ? <Suspense fallback={<p role="status">Подготавливаем оформление…</p>}><JournalGuide content={content} materialId={id} title={title} description={description} showToc={showToc} /></Suspense>
    : <StandardMaterialContent body={body} content={content} materialId={id} showToc={showToc} />;
}

/** Derive navigation from the actual safe Markdown output, including setext headings. */
function StandardMaterialContent({ body = "", content, materialId, showToc = true }: { body?: string; content?: MaterialText; materialId?: string; showToc?: boolean }) {
  const root = useRef<HTMLDivElement>(null), instance = useId();
  const text = content?.body ?? body, id = materialId ?? instance;
  const prefix = `guide-${encodeURIComponent(id).replace(/%/g, "_")}`;
  const [headings, setHeadings] = useState<{ id: string; title: string; level: number }[]>([]);
  const readHeadings = useCallback(() => {
      if (!root.current) return;
      let markdown = 0;
      const items = [...root.current!.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")].map(element => {
        if (!element.closest("[data-guide-embed]")) element.id = `${prefix}-section-${++markdown}`;
        element.tabIndex = -1;
        return { id: element.id, title: element.textContent ?? "Раздел", level: Number(element.tagName.slice(1)) };
      });
      setHeadings(previous => JSON.stringify(previous) === JSON.stringify(items) ? previous : items);
  }, [prefix]);
  useLayoutEffect(() => {
    readHeadings();
    const observer = new MutationObserver(readHeadings);
    observer.observe(root.current!, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [text, readHeadings]);
  return <div className={s.layout}>
    {showToc && headings.length > 1 && <nav className={s.toc} aria-label="Содержание материала"><details open><summary>Содержание</summary><ol>{headings.map(item => <li key={item.id} style={{ paddingInlineStart: `${Math.max(0, item.level - 1) * 10}px` }}><a href={`#${item.id}`} onClick={event => { event.preventDefault();const target = document.getElementById(item.id);target?.scrollIntoView({ block: "start", behavior: "smooth" });target?.focus({ preventScroll: true }); }}>{item.title}</a></li>)}</ol></details></nav>}
    <div ref={root} className={s.body}>{content?.format === "markdown-embeds-v1" ? <Suspense fallback={<p role="status">Подготавливаем оформление…</p>}><GuideEmbeds content={content} materialId={id} onReady={readHeadings} /></Suspense> : <MarkdownContent body={text} anchorPrefix={prefix} />}</div>
  </div>;
}
