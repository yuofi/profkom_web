import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileRef } from "../../utils/api/contract";
import { filesApi } from "../../utils/api/files.api";
import { accessFingerprint, isActiveSession, useSession } from "../../utils/session";
import { userMessage } from "../../utils/api/messages";
import { MarkdownCode, MarkdownCodeBlock } from "./MarkdownCode";
import { Glyph } from "./WorkspaceUI";
import s from "./FilePreview.module.css";

const PdfPreview = lazy(() => import("./FilePdfPreview").then(module => ({ default: module.FilePdfPreview })));
const TEXT_LIMIT = 1024 * 1024, BINARY_LIMIT = 20 * 1024 * 1024;
const codeLanguages: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", json: "json", sh: "bash", bash: "bash", css: "css", html: "xml", htm: "xml", svg: "xml", xml: "xml",
  sql: "sql", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp", c: "cpp", java: "java", go: "go", rs: "rust",
  yaml: "yaml", yml: "yaml", diff: "diff", patch: "diff", md: "text", markdown: "text", txt: "text", csv: "text", log: "text",
};
function previewType(file: FileRef) {
  const mime = file.mime_type.split(";", 1)[0].trim().toLowerCase();
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (["image/png", "image/jpeg", "image/webp"].includes(mime)) return { kind: "image" as const, limit: BINARY_LIMIT };
  if (mime === "application/pdf") return { kind: "pdf" as const, limit: BINARY_LIMIT };
  if (mime.startsWith("text/") || ["application/json", "application/xml", "application/javascript", "image/svg+xml"].includes(mime) || codeLanguages[extension])
    return { kind: "text" as const, limit: TEXT_LIMIT, language: codeLanguages[extension] ?? "text" };
  return { kind: "unsupported" as const, limit: 0 };
}
type Loaded = { blob: Blob; text?: string; url?: string };
function PreviewBytes({ file }: { file: FileRef }) {
  const mode = previewType(file);
  const [loaded, setLoaded] = useState<Loaded | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();let objectUrl: string | undefined;
    if (mode.kind === "unsupported" || file.size_bytes > mode.limit) return () => controller.abort();
    void (async () => {
      try {
        const blob = await filesApi.content(file.file_id, controller.signal);
        if (controller.signal.aborted) return;
        if (blob.size > mode.limit) throw Error("Файл слишком большой для предпросмотра. Его можно скачать.");
        let text: string | undefined;
        if (mode.kind === "text") {
          try {
            const bytes = typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
              const reader = new FileReader();reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(Error("Invalid file"));reader.onerror = () => reject(reader.error);reader.readAsArrayBuffer(blob);
            });
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          }
          catch { throw Error("Не удалось прочитать текст в кодировке UTF-8. Файл можно скачать."); }
          if (text.includes("\0")) throw Error("Для этого двоичного файла предпросмотр недоступен. Его можно скачать.");
        } else if (mode.kind === "image") objectUrl = URL.createObjectURL(new Blob([blob], { type: file.mime_type }));
        if (controller.signal.aborted) { if (objectUrl) URL.revokeObjectURL(objectUrl);return; }
        setLoaded({ blob, text, url: objectUrl });
      } catch (caught) { if (!controller.signal.aborted) setError(userMessage(caught)); }
    })();
    return () => { controller.abort();if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.file_id, file.mime_type, file.size_bytes, mode.kind, mode.limit]);
  if (mode.kind === "unsupported") return <p>Для этого формата предпросмотр недоступен. Файл можно скачать.</p>;
  if (file.size_bytes > mode.limit) return <p>Файл слишком большой для предпросмотра. Его можно скачать.</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!loaded) return <p role="status">Открываем файл…</p>;
  return <>
    {mode.kind === "text" && <MarkdownCodeBlock language={mode.language}><MarkdownCode className={`language-${mode.language}`} source={loaded.text ?? ""} /></MarkdownCodeBlock>}
    {mode.kind === "image" && <img className={s.image} src={loaded.url} alt={file.name} onError={() => setError("Не удалось показать изображение. Файл можно скачать.")} />}
    {mode.kind === "pdf" && <Suspense fallback={<p role="status">Открываем PDF…</p>}><PdfPreview blob={loaded.blob} /></Suspense>}
  </>;
}

/** Private bytes are held only by this dialog, never by the shared query cache. */
export function FilePreview({ file, onClose, onDownload, downloading = false, downloadError }: {
  file: FileRef; onClose: () => void; onDownload: () => void; downloading?: boolean; downloadError?: string;
}) {
  const { session } = useSession();
  const active = isActiveSession(session), identity = accessFingerprint(session);
  const titleId = useId(), dialog = useRef<HTMLDialogElement>(null);
  const access = useQuery({
    queryKey: ["files", "preview-access", file.file_id, identity],
    queryFn: async () => { await filesApi.download(file.file_id);return true; },
    enabled: active,
    retry: false, staleTime: 0, gcTime: 0,
    refetchOnWindowFocus: "always", refetchInterval: 15_000,
  });
  const { refetch } = access;
  useEffect(() => {
    const recheck = () => { if (active) void refetch(); };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [active, refetch]);
  useEffect(() => {
    const node = dialog.current, previous = document.activeElement;
    if (node) { if (typeof node.showModal === "function") node.showModal();else node.setAttribute("open", ""); }
    return () => { if (node?.open && typeof node.close === "function") node.close();if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const allowed = active && access.isSuccess && !access.error;
  const checkedDownload = async () => { const checked = await access.refetch();if (!checked.error && checked.data) onDownload(); };
  return <dialog ref={dialog} className={s.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault();onClose(); }} onClick={event => { event.stopPropagation();if (event.target === event.currentTarget) onClose(); }}>
    <header className={s.header}><div><h2 id={titleId}>{file.name}</h2><span>{Math.ceil(file.size_bytes / 1024)} КБ</span></div><button type="button" aria-label="Закрыть просмотр файла" onClick={onClose}><Glyph name="close" /></button></header>
    <div className={s.body}>
      {!active ? <p role="alert">Сессия закончилась. Войдите снова.</p> : access.error ? <p role="alert">{userMessage(access.error)}</p> : access.isPending ? <p role="status">Проверяем доступ к файлу…</p> : <>
        {access.isFetching && <p role="status">Проверяем доступ к файлу…</p>}
        <div hidden={access.isFetching}><PreviewBytes key={JSON.stringify([file, identity])} file={file} /></div>
      </>}
      {downloadError && <p role="alert">{downloadError}</p>}
    </div>
    <footer className={s.footer}><button type="button" disabled={!allowed || access.isFetching || downloading} onClick={() => { void checkedDownload(); }}>{downloading ? "Скачиваем…" : "Скачать файл"}</button><button type="button" onClick={onClose}>Закрыть</button></footer>
  </dialog>;
}
