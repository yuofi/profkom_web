import clsx from "clsx";
import type { NotificationDetails } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { Glyph } from "./WorkspaceUI";
import s from "./ServiceSignIn.module.css";

/** Which notices these parts lay out: `signInDetails` (utils/serviceSignIn.ts). */
type Parts = { kind: string; details: NotificationDetails; className?: string };
/** A service-account sign-in (owner 2026-11-08, item 25, variant Б), in the bell and on the page of notifications:
 *  a shield before the title; failed attempts in a row take the danger colour, a warning and their number. */
export function ServiceSignInTitle({ kind, details, className }: Parts) {
  const failed = kind === "service_login_failed";
  return <span className={clsx(className, s.title)} data-failed={failed || undefined}>
    <Glyph name={failed ? "error" : "security"} className={s.icon} />
    {failed ? `Неудачные попытки входа в сервисный аккаунт${details.failures ? ` · ${details.failures} подряд` : ""}` : "Вход в сервисный аккаунт"}
  </span>;
}
/** Its muted line in place of the notice's date: when (the last attempt of a failed streak), from which IP, in which browser.
 *  The time reads as every other notice's date in the same list (displayDate). */
export function ServiceSignInFacts({ kind, details, className }: Parts) {
  const moment = details.at && !Number.isNaN(Date.parse(details.at)) ? displayDate(details.at) : null;
  return <span className={clsx(className, s.facts)}>
    {kind === "service_login_failed" && "последняя "}{moment ? <time dateTime={details.at!}>{moment}</time> : "время неизвестно"} · IP {details.ip ?? "неизвестен"} · {details.browser ?? "неизвестный браузер"}
  </span>;
}
