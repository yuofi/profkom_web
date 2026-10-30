import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { profileFeaturesApi, type ActivityFact } from "../../utils/api/profileFeatures.api";
import { displayDate } from "../../utils/dates";
import { canRetainData } from "../../utils/api/request";
import { Card, Empty, Glyph, QueryState } from "./WorkspaceUI";
import { InteractiveChip } from "./InteractiveChip";
import s from "./ProfileFeatures.module.css";
const roles: Record<string, string> = { chair: "Председатель", deputy_chair: "Заместитель председателя", master: "Мастер", deputy_master: "Заместитель мастера", event_leader: "Главорг", deputy_event_leader: "Заместитель главорга", subevent_leader: "Ответственный", deputy_subevent_leader: "Заместитель ответственного", organizer: "Организатор", member: "Участник блока" };
function TeamFact({ fact }: { fact: ActivityFact }) {
  return <InteractiveChip kind="display" label={fact.scope.name} icon={<Glyph name={fact.scope.kind === "block" ? "groups" : "event"} />} />;
}
export function ProfileActivity({ userId, hideCurrent = false }: { userId: number; hideCurrent?: boolean }) {
  const query = useQuery({ queryKey: ["profileActivity", userId], queryFn: () => profileFeaturesApi.activity(userId) });
  const [historyOpen, setHistoryOpen] = useState(false), [historyLimit, setHistoryLimit] = useState(20);
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const current = data?.items.filter(fact => fact.current) ?? [];
  return <Card title="Участие и деятельность">
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data}>
      {data && <>
        {!hideCurrent && <div className={s.roles}>{["block", "event"].map(kind => <section key={kind}><h3>{kind === "block" ? "Блоки" : "Мероприятия"}</h3><div className={s.facts}>
          {current.filter(fact => kind === "block" ? fact.scope.kind === "block" : fact.scope.kind === "event" || fact.scope.kind === "subevent").map((fact, index) => <div className={s.fact} key={`${fact.scope.id}/${fact.role}/${index}`}><TeamFact fact={fact} /><span>{roles[fact.role] ?? fact.role}</span></div>)}
          {!current.some(fact => kind === "block" ? fact.scope.kind === "block" : ["event", "subevent"].includes(fact.scope.kind)) && <Empty>Текущего участия нет.</Empty>}
        </div></section>)}</div>}
        <details className={s.activityHistory} open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>История деятельности · {data.items.length}</summary>
        {historyOpen && <><p>Роли и периоды участия. Эта история не открывает рабочие данные команды.</p>
        {data.items.length ? <ol className={s.facts}>{data.items.slice(0, historyLimit).map((fact, index) => <li className={s.fact} key={`${fact.scope.kind}/${fact.scope.id}/${fact.role}/${index}`}>
          <strong>{roles[fact.role] ?? fact.role}</strong><TeamFact fact={fact} />
          <small>{fact.started_at ? `${fact.observed ? "Известно с" : "С"} ${displayDate(fact.started_at)}` : "Дата начала неизвестна"}{fact.ended_at ? ` — ${displayDate(fact.ended_at)}` : " · сейчас"}</small>
        </li>)}</ol> : <Empty>Пока нет записанной истории.</Empty>}
        {data.items.length > historyLimit && <button type="button" className={s.historyMore} onClick={() => setHistoryLimit(limit => limit + 20)}>Показать ещё · {data.items.length - historyLimit}</button>}</>}
        </details>
      </>}
    </QueryState>
  </Card>;
}
