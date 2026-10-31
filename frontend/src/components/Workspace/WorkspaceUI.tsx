import { useContext, type ReactNode } from "react";
import clsx from "clsx";
import { Link } from "react-router-dom";
import { QueryClientContext, type Query } from "@tanstack/react-query";
import { canRetainData, normalizeApiError } from "../../utils/api/request";
import { errorDetail, userMessage } from "../../utils/api/messages";
import type { IconName } from "../icons";
import { PageNavContext, SectionContext, toneStyle, type Tone } from "./sections";
import s from "./Workspace.module.css";
import { SectionHomeLink } from "./SectionHomeLink";
/** An icon beside a text: it comes from CSS, so it is not part of the text. */
export const Glyph = ({ name, className }: { name: IconName; className?: string }) => (
  <span className={clsx("material-symbols-rounded", s.glyph, className)} data-icon={name} aria-hidden="true" />
);
export function Page({
  title,
  description,
  children,
  actions,
  className,
  headerClassName,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  const section = useContext(SectionContext);
  const nav = useContext(PageNavContext);
  return (
    <section className={clsx(s.page, className)}>
      <header className={clsx(s.header, headerClassName)}>
        <div>
          {/* Where the page is; the section's own page says the section in its title. */}
          <SectionHomeLink to={section?.to} label={section?.label} />
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
/** A refusal or a missing object still has its page: a title and a way on (GL-21). */
export function DeniedPage({ title, back, children }: { title: string; back?: { to: string; label: string }; children: ReactNode }) {
  return <Page title={title} actions={back && <RouteLink to={back.to}>{back.label}</RouteLink>}><Empty>{children}</Empty></Page>;
}
export const Card = ({
  title,
  children,
  icon,
  tone,
  wide = false,
  className,
}: {
  title?: string;
  children: ReactNode;
  /** The card's icon beside the title, in the card's tone. */
  icon?: IconName;
  tone?: Tone;
  /** In a grid of cards: the whole row. */
  wide?: boolean;
  className?: string;
}) => (
  <section className={clsx(s.card, className, tone && s.toned, wide && s.wide)} style={toneStyle(tone)}>
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
  // Without an own retry, «Обновить данные» rereads the page's failed queries (GL-38).
  const client = useContext(QueryClientContext);
  const failed = { type: "active" as const, predicate: (query: Query) => query.state.status === "error" };
  const reread = !retry && error && client?.getQueryCache().findAll(failed).length ? () => void client.refetchQueries(failed) : undefined;
  if (loading) return <Loading />;
  return <>
    {error && <ErrorState error={error} retry={retry ?? reread} />}
    {(!error || (keepDataOnError && canRetainData(error))) ? children : null}
  </>;
}
