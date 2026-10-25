import { useContext, type ReactNode } from "react";
import clsx from "clsx";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import { errorDetail, userMessage } from "../../utils/api/messages";
import type { RichText } from "../../utils/api/contract";
import type { IconName } from "../icons";
import { PageNavContext, SectionContext, toneStyle, type Tone } from "./sections";
import s from "./Workspace.module.css";
/** An icon beside a text: it comes from CSS, so it is not part of the text. */
export const Glyph = ({ name, className }: { name: IconName; className?: string }) => (
  <span className={clsx("material-symbols-rounded", s.glyph, className)} data-icon={name} aria-hidden="true" />
);
export function Page({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const section = useContext(SectionContext);
  const nav = useContext(PageNavContext);
  return (
    <section className={s.page}>
      <header className={s.header}>
        <div>
          {/* Where the page is; the section's own page says the section in its title. */}
          <p className={s.eyebrow}>{section && section.label !== title ? section.label : "Профком ВМК"}</p>
          <h1 className={s.title}>{title}</h1>
          {description && <p className={s.description}>{description}</p>}
        </div>
        {actions}
      </header>
      {nav}
      {children}
    </section>
  );
}
export const Card = ({
  title,
  children,
  icon,
  tone,
  wide = false,
}: {
  title?: string;
  children: ReactNode;
  /** The card's icon beside the title, in the card's tone. */
  icon?: IconName;
  tone?: Tone;
  /** In a grid of cards: the whole row. */
  wide?: boolean;
}) => (
  <section className={clsx(s.card, tone && s.toned, wide && s.wide)} style={toneStyle(tone)}>
    {title && <h2>{icon && <Glyph name={icon} className={s.cardIcon} />}{title}</h2>}
    {children}
  </section>
);
export const Empty = ({
  children = "Пока ничего нет",
}: {
  children?: ReactNode;
}) => (
  <p className={s.empty}>{children}</p>
);
export const Loading = () => (
  <p role="status" className={s.muted}>
    Загружаем данные…
  </p>
);
/** The server's technical detail, collapsed and outside the alert (FIX_PLAN 2.13). */
export const ErrorDetail = ({ error }: { error: unknown }) => {
  const detail = errorDetail(error);
  return detail ? (
    <details className={s.muted}>
      <summary>Подробнее</summary>
      <code>{detail}</code>
    </details>
  ) : null;
};
/** Rereading does not help when the object is gone or the access is (2.13). */
const FINAL = new Set([401, 403, 404]);
export const ErrorState = ({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) => (
  <>
    <div role="alert" className={s.error}>
      <p>{userMessage(error)}</p>
      {retry && !FINAL.has(normalizeApiError(error).status) && (
        <button className={s.button} onClick={retry}>
          Обновить данные
        </button>
      )}
    </div>
    <ErrorDetail error={error} />
  </>
);
export const RouteLink = ({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) => (
  <Link className={s.linkButton} to={to}>
    {children}
  </Link>
);
export const Markdown = ({
  content,
  preview = false,
}: {
  content: RichText | string | null | undefined;
  /** Only the beginning, for a card in a list. */
  preview?: boolean;
}) => (
  <div className={clsx(s.markdown, preview && s.preview)}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
      {typeof content === "string" ? content : (content?.body ?? "")}
    </ReactMarkdown>
  </div>
);
/** A label; the tone tells its meaning at a glance, the text tells it fully. */
export const Badge = ({ children, tone }: { children: ReactNode; tone?: Tone }) => (
  <span className={clsx(s.badge, tone && s.toned)} style={toneStyle(tone)}>{children}</span>
);
export function QueryState({
  loading,
  error,
  children,
  retry,
  keepDataOnError = false,
}: {
  loading: boolean;
  error: unknown;
  children: ReactNode;
  retry?: () => void;
  keepDataOnError?: boolean;
}) {
  if (loading) return <Loading />;
  return <>
    {error && <ErrorState error={error} retry={retry} />}
    {(!error || (keepDataOnError && canRetainData(error))) ? children : null}
  </>;
}
