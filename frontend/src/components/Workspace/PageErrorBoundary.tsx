import { Component, useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { isChunkLoadError, reloadOnceForStaleChunk } from "../../utils/chunkReload";
import { recordDiagnostic } from "../../utils/diagnostics";
import { FeedbackDialogContext } from "./feedbackDialog";
import s from "./Workspace.module.css";
import r from "./PageErrorBoundary.module.css";

const reload = () => window.location.reload();
/** What the user can do when a page could not be shown; no stack trace or server detail. */
function PageFailure({ error }: { error: unknown }) {
  const report = useContext(FeedbackDialogContext);
  const stale = isChunkLoadError(error);
  return <section className={s.page}>
    <div role="alert" className={s.error}>
      <h1 className={r.title}>{stale ? "Сайт обновился" : "Не удалось показать страницу"}</h1>
      <p>{stale
        ? "Эта страница относится к новой версии сайта. Обновите страницу, чтобы её открыть."
        : "Обновите страницу. Если ошибка повторится, сообщите о ней: это поможет её исправить."}</p>
      <div className={s.row}>
        <button type="button" className={s.button} onClick={reload}>Обновить страницу</button>
        <Link className={s.button} to="/">На главную</Link>
        {report && <button type="button" className={s.button} onClick={report}>Сообщить об ошибке</button>}
      </div>
    </div>
  </section>;
}

/** A page that fails to render or to load its code leaves the menu, the bell and the report
 *  button in place (GL-01). The layout keys it by the path, so another page starts clean. */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  componentDidCatch(error: unknown) {
    recordDiagnostic("error", isChunkLoadError(error) ? "stale_chunk" : "render_error", window.location.pathname);
    if (isChunkLoadError(error)) reloadOnceForStaleChunk();
  }
  render() {
    return this.state.failed ? <PageFailure error={this.state.error} /> : this.props.children;
  }
}

/** The last resort of the router: it replaces the providers too, so it uses none of them. */
export function AppErrorPage() {
  return <main className={r.app}>
    <div role="alert" className={s.error}>
      <h1 className={r.title}>Не удалось открыть сайт</h1>
      <p>Обновите страницу. Если ошибка повторится, напишите в поддержку.</p>
      <div className={s.row}>
        <button type="button" className={s.button} onClick={reload}>Обновить страницу</button>
        <a className={s.button} href="/">На главную</a>
      </div>
    </div>
  </main>;
}
