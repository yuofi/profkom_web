import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { profileFeaturesApi, type Achievement, type AchievementGrant, type FeaturesContext } from "../../utils/api/profileFeatures.api";
import { canRetainData } from "../../utils/api/request";
import { displayDate } from "../../utils/dates";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import type { IconName } from "../icons";
import { ActionForm } from "./ActionForm";
import { AnchoredPopover } from "./AnchoredPopover";
import { text } from "./formValues";
import { Card, Empty, Glyph, QueryState } from "./WorkspaceUI";
import { UserChip } from "./UserChip";
import { UnsavedChangesScope } from "./UnsavedChanges";
import { useGuardedAction } from "./unsavedChangesHooks";
import w from "./Workspace.module.css";
import s from "./ProfileFeatures.module.css";
const iconLabels: Record<string, string> = { workspace_premium: "Награда", celebration: "Праздник", school: "Знания", badge: "Участие", fact_check: "Результат", groups: "Команда" };
const icon = (name: string) => <Glyph name={(Object.hasOwn(iconLabels, name) ? name : "workspace_premium") as IconName} />;
export function ProfileAchievements({ userId }: { userId: number }) {
  const query = useQuery({ queryKey: ["profileAchievements", userId], queryFn: () => profileFeaturesApi.achievements(userId) });
  const catalogue = useQuery({ queryKey: ["achievements", userId], queryFn: () => profileFeaturesApi.catalogue(userId) });
  const context = useQuery({ queryKey: ["profileFeaturesContext"], queryFn: profileFeaturesApi.context });
  const data = !query.error || canRetainData(query.error) ? query.data : undefined;
  const awards = !catalogue.error || canRetainData(catalogue.error) ? catalogue.data : undefined;
  const ctx = !context.error || canRetainData(context.error) ? context.data : undefined;
  const active = data?.items.filter(grant => !grant.revoked_at) ?? [];
  const available = awards?.items.filter(award => !award.archived && award.capabilities.includes("grant_achievement")) ?? [];
  return <Card title="Достижения">
    <QueryState loading={query.isLoading} error={query.error} keepDataOnError={!!data}>
      {data && <>
        {!!active.length && <ul className={s.awardShelf} aria-label="Награды">{active.map(grant => <li key={grant.grant_id}><UnsavedChangesScope><AwardBadge grant={grant} /></UnsavedChangesScope></li>)}</ul>}
        {!active.length && <Empty>Пока нет выданных наград.</Empty>}
        {!!data.items.length && <UnsavedChangesScope><AwardHistory grants={data.items} /></UnsavedChangesScope>}
      </>}
    </QueryState>
    {!!available.length && <details className={w.details}><summary>Выдать награду</summary><GrantForm key={userId} userId={userId} awards={available} /></details>}
    {!!ctx?.award_scopes.length && <details className={w.details}><summary>Каталог и управление наградами</summary><QueryState loading={catalogue.isLoading} error={catalogue.error} keepDataOnError={!!awards}>
      {awards && <UnsavedChangesScope><Catalogue context={ctx} awards={awards.items} /></UnsavedChangesScope>}
    </QueryState></details>}
  </Card>;
}
function AwardBadge({ grant }: { grant: AchievementGrant }) {
  const [open, setOpen] = useState(false), anchor = useRef<HTMLButtonElement>(null), leave = useGuardedAction();
  const label = `Награда «${grant.achievement.title}» · ${displayDate(grant.issued_at)}`;
  return <>
    <button ref={anchor} type="button" className={s.awardButton} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} data-achievement-grant={grant.grant_id} onClick={() => { if (open) leave(() => setOpen(false));else setOpen(true); }}>{icon(grant.achievement.icon)}</button>
    <AnchoredPopover open={open} anchorRef={anchor} label={grant.achievement.title} width={360} focusRoot className={s.awardPopover} onRequestClose={() => leave(() => setOpen(false))}><AwardGrantCard grant={grant} /></AnchoredPopover>
  </>;
}
function AwardHistory({ grants }: { grants: AchievementGrant[] }) {
  const [open, setOpen] = useState(false), leave = useGuardedAction();
  return <details className={w.details} open={open}><summary onClick={event => { event.preventDefault();if (open) leave(() => setOpen(false));else setOpen(true); }}>История награждений · {grants.length}</summary>
    {open && <div className={s.badges}>{grants.map(grant => <AwardGrantCard key={grant.grant_id} grant={grant} history />)}</div>}
  </details>;
}
function AwardGrantCard({ grant, history = false }: { grant: AchievementGrant; history?: boolean }) {
  const { perform, refresh } = useWorkspaceActions();
  return <article className={`${history ? s.badge : s.awardDetail} ${grant.revoked_at ? s.revoked : ""}`}>
    {icon(grant.achievement.icon)}{history && <h3>{grant.achievement.title}</h3>}<p>{grant.achievement.description}</p>
    <small>{grant.achievement.scope.name} · {displayDate(grant.issued_at)}</small><div>Выдал(а) <UserChip user={grant.issued_by} /></div>
    {grant.note && <p>{grant.note}</p>}
    {grant.revoked_at && <><strong>Отозвана · {displayDate(grant.revoked_at)}</strong>{grant.revoked_by && <UserChip user={grant.revoked_by} />}{grant.revoke_reason && <p>Основание: {grant.revoke_reason}</p>}</>}
    {history && <ul>{grant.history.map(event => <li key={event.event_id}>{event.kind === "issued" ? "Выдана" : "Отозвана"} · {displayDate(event.created_at)} · {event.actor.display_name}</li>)}</ul>}
    {grant.capabilities.includes("revoke_achievement") && <details><summary>Отозвать</summary><ActionForm revision={grant.revision} onConflict={refresh} allowExitSave={false}
      fields={[{ name: "reason", label: "Основание отзыва", type: "textarea", required: true }]} submitLabel="Отозвать награду" variant="danger"
      onSubmit={async (values, revision) => { await perform(() => profileFeaturesApi.revoke({ ...grant, revision: revision! }, text(values, "reason"))); }} /></details>}
  </article>;
}
function GrantForm({ userId, awards }: { userId: number; awards: Achievement[] }) {
  const { perform } = useWorkspaceActions();
  return <ActionForm resetOnSuccess allowExitSave={false} fields={[
    { name: "award", label: "Награда", type: "select", required: true, options: awards.map(award => ({ value: award.achievement_id, label: `${award.title} · ${award.scope.name}` })) },
    { name: "note", label: "Комментарий получателю и управляющим", type: "textarea" },
  ]} submitLabel="Выдать награду" onSubmit={async values => {
    const award = awards.find(row => row.achievement_id === text(values, "award"));
    if (!award) throw Error("Выберите доступную награду");
    await perform(() => profileFeaturesApi.grant(award, userId, text(values, "note")));
  }} />;
}
function Catalogue({ context, awards }: { context: FeaturesContext; awards: Achievement[] }) {
  const [editing, setEditing] = useState<Achievement | "new" | null>(null);
  const guard = useGuardedAction(), { perform, refresh } = useWorkspaceActions();
  const selected = editing && editing !== "new" ? editing : null;
  const managed = awards.filter(award => award.capabilities.includes("manage_achievement"));
  return <div className={s.library}><button type="button" className={w.button} onClick={() => guard(() => setEditing("new"))}>Создать награду</button>
    <div className={s.badges}>{managed.map(award => <article className={s.badge} key={award.achievement_id}>{icon(award.icon)}<h3>{award.title}</h3><p>{award.scope.name}{award.archived ? " · В архиве" : ""}</p><button type="button" className={w.button} onClick={() => guard(() => setEditing(award))}>Изменить</button></article>)}</div>
    {editing && <><ActionForm key={selected?.achievement_id ?? "new"} revision={selected?.revision} onConflict={refresh}
      fields={[
        { name: "title", label: "Название награды", required: true, value: selected?.title ?? "" },
        { name: "description", label: "Описание награды", type: "textarea", value: selected?.description ?? "" },
        { name: "icon", label: "Значок", type: "select", required: true, value: selected?.icon ?? context.award_icons[0], options: context.award_icons.map(name => ({ value: name, label: iconLabels[name] ?? name })) },
        ...(selected ? [{ name: "archived", label: "Состояние каталога", type: "select" as const, value: String(selected.archived), options: [{ value: "false", label: "Активна" }, { value: "true", label: "В архиве" }] }] : [{ name: "scope", label: "Область награды", type: "select" as const, required: true, options: context.award_scopes.map((scope, index) => ({ value: String(index), label: scope.name })) }]),
      ]} onSubmit={async (values, revision) => {
        const data = { title: text(values, "title"), description: text(values, "description"), icon: text(values, "icon") };
        if (selected) { const saved = await perform(() => profileFeaturesApi.updateAchievement({ ...selected, revision: revision! }, data, text(values, "archived") === "true"));setEditing(saved);return { revision: saved.revision }; }
        else { const scope = context.award_scopes[Number(text(values, "scope"))];if (!scope) throw Error("Выберите область награды");await perform(() => profileFeaturesApi.createAchievement(data, scope)); }
      }} /><button type="button" className={w.button} onClick={() => guard(() => setEditing(null))}>Закрыть редактор награды</button></>}
  </div>;
}
