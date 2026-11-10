import type { RegistrationApplication } from "../../utils/api/contract";
import { displayDate } from "../../utils/dates";
import { Glyph } from "./WorkspaceUI";
import s from "./RegistrationDecision.module.css";

/** Shared by the applicant and reviewers. A pending applicant cannot open staff profiles. */
export function RegistrationDecision({ application }: { application: RegistrationApplication }) {
  if (application.status === "pending") return null;
  const approved = application.status === "approved";
  const decision = application.decision?.outcome === application.status ? application.decision : null;
  return <section className={s.decision} data-outcome={application.status} aria-label="Решение по заявке">
    <Glyph name={approved ? "check" : "close"} className={s.icon} />
    <div className={s.body}>
      <strong className={s.title}>{approved ? "Регистрация одобрена" : "Регистрация отклонена"}</strong>
      <div className={s.meta}>
        <span>Решение принял: <strong>{decision?.actor?.display_name ?? "Не указан"}</strong></span>
        {decision?.at ? <time dateTime={decision.at}>{displayDate(decision.at)} МСК</time> : <span>Дата и время не сохранены</span>}
      </div>
    </div>
  </section>;
}
