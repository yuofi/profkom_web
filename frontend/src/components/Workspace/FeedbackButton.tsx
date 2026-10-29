import { useEffect, useId, useRef, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { isActiveSession, useSession } from "../../utils/session";
import { supportApi, type FeedbackInput, type FeedbackReceipt } from "../../utils/api/support.api";
import { userMessage } from "../../utils/api/messages";
import { clearDiagnostics, recordDiagnostic, snapshotDiagnostics } from "../../utils/diagnostics";
import { useConfirmedNavigation, useGuardedAction, useUnsavedChanges } from "./unsavedChangesHooks";
import { Glyph } from "./WorkspaceUI";
import { getTaskRoute } from "../../utils/routes";
import s from "./Workspace.module.css";
import f from "./FeedbackButton.module.css";

function BugIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="7" y="7" width="10" height="14" rx="5" /><path d="M9 7V5a3 3 0 0 1 6 0v2M3 10h4m10 0h4M3 15h4m10 0h4M5 21l3-3m8 0 3 3M12 8v12" /></svg>; }
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false), [diagnostics, setDiagnostics] = useState<FeedbackInput["diagnostics"]>(null);
  const location = useLocation();
  const { session } = useSession();
  useEffect(() => { clearDiagnostics(); }, [session?.user_id]);
  const start = () => { setDiagnostics(snapshotDiagnostics(location.pathname));setOpen(true); };
  useEffect(() => { recordDiagnostic("navigation", "route_open", location.pathname); }, [location.pathname]);
  useEffect(() => {
    const failure = () => recordDiagnostic("error", "unhandled_error", window.location.pathname);
    const click = (event: MouseEvent) => { if ((event.target as Element | null)?.closest?.("button,[role=button]")) recordDiagnostic("action", "button_click", window.location.pathname); };
    window.addEventListener("error", failure);window.addEventListener("unhandledrejection", failure);document.addEventListener("click", click);
    return () => { window.removeEventListener("error", failure);window.removeEventListener("unhandledrejection", failure);document.removeEventListener("click", click); };
  }, []);
  return <>{children}<button type="button" className={f.trigger} aria-label="Сообщить об ошибке или предложить улучшение" title="Сообщить об ошибке или предложить улучшение" onClick={start}><BugIcon /></button>{open && <FeedbackForm diagnostics={diagnostics} onClose={() => setOpen(false)} />}</>;
}
function FeedbackForm({ diagnostics, onClose }: { diagnostics: FeedbackInput["diagnostics"]; onClose: () => void }) {
  const { session } = useSession(), scope = useId(), leave = useGuardedAction(scope), navigate = useConfirmedNavigation(), dialog = useRef<HTMLDivElement>(null), restore = useRef<HTMLElement | null>(null);
  const canTrack = isActiveSession(session) && !session?.password_change_required;
  const context = useQuery({ queryKey: ["supportContext"], queryFn: supportApi.context, enabled: isActiveSession(session) && !session?.password_change_required });
  const [kind, setKind] = useState<"bug" | "feature">("bug"), [title, setTitle] = useState(""), [body, setBody] = useState(""), [contact, setContact] = useState(""), [include, setInclude] = useState(true), [screenshot, setScreenshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<FeedbackReceipt | null>(null);
  const [attempted, setAttempted] = useState(false);
  const payload = useRef<FeedbackInput | null>(null), nonce = useRef(crypto.randomUUID()), titleId = useId();
  const locked = busy || attempted;
  useUnsavedChanges({ scope, dirty: !result && !!(title || body || contact || screenshot), busy, label: "Обращение в поддержку" });
  const close = () => leave(onClose);
  useEffect(() => { restore.current = document.activeElement as HTMLElement;dialog.current?.querySelector<HTMLInputElement>("input[name=feedback-title]")?.focus();return () => { if (restore.current?.isConnected) restore.current.focus(); }; }, []);
  const loadScreenshot = (file?: File) => {
    if (!file) return;
    if (file.type !== "image/png" || file.size > 2 * 1024 * 1024) { setError("Выберите PNG до 2 МиБ");return; }
    setBusy(true);const reader = new FileReader();reader.onload = () => { setScreenshot(String(reader.result));setBusy(false); };reader.onerror = () => { setError("Не удалось прочитать изображение");setBusy(false); };reader.readAsDataURL(file);
  };
  return createPortal(<div className={f.overlay} onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div ref={dialog} className={f.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault();event.stopPropagation();if (!busy) close(); }
      if (event.key === "Tab") { const nodes = [...dialog.current!.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary")];const first = nodes[0], last = nodes.at(-1);if (event.shiftKey && document.activeElement === first) { event.preventDefault();last?.focus(); }else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first?.focus(); } }
    }}>
      <header className={f.header}><h2 id={titleId}>Обращение в поддержку</h2><button type="button" className={s.button} aria-label="Закрыть обращение" disabled={busy} onClick={close}><Glyph name="close" /></button></header>
      {result ? <div className={s.stack}><p role="status">{result.task_key ? `Создан тикет ${result.task_key}` : "Обращение сохранено. Тикет появится после подключения очереди поддержки."}</p>{result.task_id && canTrack && <Link to={getTaskRoute(result.task_id)} onClick={onClose}>Открыть тикет</Link>}<p className={s.muted}>Номер обращения: {result.report_id}</p><button className={s.button} onClick={onClose}>Готово</button></div> : <form className={s.stack} onSubmit={async event => {
        event.preventDefault();if (busy) return;setError("");setBusy(true);setAttempted(true);
        payload.current ??= { kind, title: title.trim(), body: body.trim(), contact: contact.trim() || null, idempotency_key: nonce.current, diagnostics: include ? diagnostics : null, screenshot };
        try { setResult(await supportApi.submit(payload.current)); }
        catch (failure) { setError(userMessage(failure)); }
        finally { setBusy(false); }
      }}>
        <label className={s.field}>Тип обращения<select value={kind} disabled={locked} onChange={event => setKind(event.target.value as typeof kind)}><option value="bug">Ошибка</option><option value="feature">Предложение</option></select></label>
        <label className={s.field}>Кратко о проблеме<input name="feedback-title" value={title} maxLength={240} required disabled={locked} onChange={event => setTitle(event.target.value)} /></label>
        <label className={s.field}>Описание<textarea value={body} rows={7} maxLength={16000} required disabled={locked} onChange={event => setBody(event.target.value)} placeholder="Что вы сделали, что ожидали и что произошло?" /></label>
        {!canTrack && <label className={s.field}>Контакт для ответа — необязательно<input value={contact} maxLength={300} disabled={locked} onChange={event => setContact(event.target.value)} /></label>}
        <label><input type="checkbox" checked={include} disabled={locked} onChange={event => setInclude(event.target.checked)} />Приложить техническую диагностику</label>
        {include && <details><summary>Что будет приложено</summary><p className={s.muted}>Версия, маршрут, размер окна и последние действия/коды ошибок. Значения полей, пароли и содержимое запросов не собираются. Хранение — 90 дней.</p><pre className={f.diagnostics}>{JSON.stringify(diagnostics, null, 2)}</pre></details>}
        {window.location.hostname !== "test.profcom-cmc.online" && <label className={s.field}>Изображение экрана — по желанию, PNG до 2 МиБ<input type="file" accept="image/png" disabled={locked} onChange={event => loadScreenshot(event.target.files?.[0])} /></label>}
        {screenshot && <><img className={f.preview} src={screenshot} alt="Предварительный просмотр приложения к обращению" /><button type="button" className={s.button} disabled={locked} onClick={() => setScreenshot(null)}>Убрать изображение</button></>}
        {error && <p role="alert" className={s.error}>{error} Повторная отправка использует тот же номер запроса.</p>}
        <button type="submit" className={`${s.button} ${s.primary}`} disabled={busy}>{busy ? "Отправляем…" : attempted ? "Повторить отправку" : "Отправить обращение"}</button>
        {(context.data?.can_configure || context.data?.can_triage) && <Link to="/support" onClick={event => { event.preventDefault();navigate("/support", onClose); }}>Управление поддержкой сайта</Link>}
        {canTrack && !context.data?.can_configure && !context.data?.can_triage && <Link to="/support" onClick={event => { event.preventDefault();navigate("/support", onClose); }}>Мои обращения</Link>}
      </form>}
    </div>
  </div>, document.body);
}
