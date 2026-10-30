import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ParticipationRole } from "../../utils/api/contract";
import { publicParticipationApi } from "../../utils/api/publicParticipation.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { getBlockRoute, getEventRoute } from "../../utils/routes";
import { canRetainData } from "../../utils/api/request";
import { Card, Empty, QueryState } from "./WorkspaceUI";
import { blockLogo, eventLogo } from "../../utils/teamLogos";
import { ChipAvatar, ChipInitials } from "./ChipFace";
import t from "./ProfileTeams.module.css";

const roleLabels: Record<ParticipationRole, string> = {
  member: "Участник блока", master: "Мастер", deputy_master: "Заместитель мастера",
  event_leader: "Главорг", event_deputy: "Заместитель главорга",
  subevent_leader: "Ответственный", subevent_deputy: "Заместитель ответственного",
  organizer: "Организатор", subevent_hr: "HR подмероприятия",
};
interface Team { id: string; name: string; to: string; roles: ParticipationRole[]; avatar?: string }
function TeamList({ items, label }: { items: Team[]; label: string }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <ul className={t.teams}>{(expanded ? items : items.slice(0, 5)).map(item => <li key={item.id}>
      <Link className={t.teamLink} to={item.to}><ChipAvatar src={item.avatar} presentation="logo" fallback={<ChipInitials name={item.name} />} /><span>{item.name}</span></Link>
      <small>{item.roles.map(role => roleLabels[role]).join(" · ")}</small>
    </li>)}</ul>
    {items.length > 5 && <button type="button" className={t.more} aria-expanded={expanded} aria-label={`${expanded ? "Свернуть" : "Показать все"}: ${label}`} onClick={() => setExpanded(value => !value)}>{expanded ? "Свернуть" : `Показать все · ${items.length}`}</button>}
  </>;
}
export function ProfileTeams({ userId }: { userId: number }) {
  const query = useQuery({ queryKey: ["participantParticipation", userId], queryFn: () => publicParticipationApi.get(userId) });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const eventSeasons = [...new Set(data?.events.map(event => event.season_id) ?? [])];
  return <Card title="Текущие команды">
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data} retry={() => void query.refetch()}>{data && <div className={t.columns}>
      <section><h3>Блоки <span>{data.blocks.length}</span></h3>{data.blocks.length ? <TeamList label="Блоки" items={data.blocks.map(block => ({ id: block.block_id, name: block.name, roles: block.roles, to: getBlockRoute(block.block_id), avatar: blockLogo(block.name) }))} /> : <Empty>Нет текущих блоков.</Empty>}</section>
      <section><h3>Мероприятия <span>{data.events.length}</span></h3>{eventSeasons.map(id => {
        const season = seasons.data?.items.find(item => item.season_id === id);
        const items = data.events.filter(event => event.season_id === id);
        return <details className={t.season} key={id} open={!!season?.is_current || eventSeasons.length === 1}>
          <summary>{season?.title ?? "Сезон"}<span>{items.length}</span></summary>
          <TeamList label={season?.title ?? "Мероприятия"} items={items.map(event => ({ id: event.event_id, name: event.title, roles: event.roles, to: getEventRoute(event.event_id), avatar: eventLogo(event.title) }))} />
        </details>;
      })}{!data.events.length && <Empty>Нет участия в мероприятиях незакрытых сезонов.</Empty>}</section>
    </div>}</QueryState>
  </Card>;
}
