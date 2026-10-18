import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { normalizeApiError } from "../../utils/api/request";
import type { RichText } from "../../utils/api/contract";
import s from "./Workspace.module.css";
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
  return (
    <section className={s.page}>
      <header className={s.header}>
        <div>
          <p className={s.eyebrow}>Профком ВМК</p>
          <h1 className={s.title}>{title}</h1>
          {description && <p className={s.description}>{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
export const Card = ({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) => (
  <section className={s.card}>
    {title && <h2>{title}</h2>}
    {children}
  </section>
);
export const Empty = ({
  children = "Пока ничего нет",
}: {
  children?: ReactNode;
}) => (
  <div className={s.card}>
    <p className={s.muted}>{children}</p>
  </div>
);
export const Loading = () => (
  <p role="status" className={s.muted}>
    Загружаем данные…
  </p>
);
export const ErrorState = ({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) => (
  <div role="alert" className={s.error}>
    <p>{normalizeApiError(error).message}</p>
    {retry && (
      <button className={s.button} onClick={retry}>
        Обновить данные
      </button>
    )}
  </div>
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
}: {
  content: RichText | string | null | undefined;
}) => (
  <div className={s.markdown}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
      {typeof content === "string" ? content : (content?.body ?? "")}
    </ReactMarkdown>
  </div>
);
export const Badge = ({ children }: { children: ReactNode }) => (
  <span className={s.badge}>{children}</span>
);
export function QueryState({
  loading,
  error,
  children,
  retry,
}: {
  loading: boolean;
  error: unknown;
  children: ReactNode;
  retry?: () => void;
}) {
  return loading ? (
    <Loading />
  ) : error ? (
    <ErrorState error={error} retry={retry} />
  ) : (
    children
  );
}
