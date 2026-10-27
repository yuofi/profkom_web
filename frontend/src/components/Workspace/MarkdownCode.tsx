import { useMemo, type ReactNode } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import cpp from "highlight.js/lib/languages/cpp";
import java from "highlight.js/lib/languages/java";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import s from "./MarkdownContent.module.css";

for (const [name, grammar] of Object.entries({ javascript, typescript, python, bash, json, css, xml, sql, cpp, java, go, rust, yaml, diff })) hljs.registerLanguage(name, grammar);

/** No language guessing or remote grammar loading; unknown/large snippets stay literal. */
export function MarkdownCode({ className, source }: { className?: string; source: string }) {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const highlighted = useMemo(() => {
    if (!language || !hljs.getLanguage(language) || source.length > 50000) return null;
    try { return hljs.highlight(source, { language, ignoreIllegals: true }).value; } catch { return null; }
  }, [source, language]);
  // highlight.js escapes source before adding its own span markup. Raw Markdown HTML is disabled separately.
  return highlighted === null ? <code className={className}>{source}</code> : <code className={`${className ?? ""} ${s.highlighted}`} dangerouslySetInnerHTML={{ __html: highlighted }} />;
}

/** A language caption belongs to a block, never to inline code or custom gallery/chip fences. */
export function MarkdownCodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const normalized = language?.toLowerCase();
  const label = !normalized || ["text", "txt", "plaintext"].includes(normalized) ? "Текст" : hljs.getLanguage(normalized)?.name ?? language;
  return <figure className={s.codeBlock} aria-label={`Блок кода: ${label}`}><figcaption className={s.codeLanguage}>{label}</figcaption><pre>{children}</pre></figure>;
}
