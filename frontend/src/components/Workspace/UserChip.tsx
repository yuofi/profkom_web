import { useQuery } from "@tanstack/react-query";
import type { UserRef } from "../../utils/api/contract";
import { directoryApi } from "../../utils/api/directory.api";
import { canRetainData } from "../../utils/api/request";
import { getContactRoute } from "../../utils/routes";
import { ChipAvatar } from "./ChipFace";
import { HoverCard } from "./HoverCard";
import { InteractiveChip, type ChipTrailingAction } from "./InteractiveChip";
import s from "./UserChip.module.css";

/** Selection chips remain display-only: no preview, navigation or data reads. */
export interface UserChipProps { user: UserRef; className?: string; interactive?: boolean; trailingAction?: ChipTrailingAction; previewDisabled?: boolean }
export function UserChip({ user, className = "", interactive = true, trailingAction, previewDisabled = false }: UserChipProps) {
  if (!interactive) return <InteractiveChip kind="display" label={user.display_name} avatarUrl={user.avatar_url} className={className} />;
  return <HoverCard className={className} disabled={previewDisabled} content={() => <UserPreview user={user} />}>{({ describedBy, close }) => user.user_id === null
    ? <InteractiveChip kind="display" focusable label={user.display_name} avatarUrl={user.avatar_url} ariaDescribedBy={describedBy} trailingAction={trailingAction && { ...trailingAction, onClick: event => { close();trailingAction.onClick(event); } }} />
    : <InteractiveChip kind="link" to={getContactRoute(user.user_id)} label={user.display_name} avatarUrl={user.avatar_url} ariaDescribedBy={describedBy} onClick={close} trailingAction={trailingAction && { ...trailingAction, onClick: event => { close();trailingAction.onClick(event); } }} />}
  </HoverCard>;
}
/** Mounted only while open; it uses the existing authorized contact projection. */
function UserPreview({ user }: { user: UserRef }) {
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: directoryApi.contacts, enabled: user.user_id !== null });
  const person = contacts.error && !canRetainData(contacts.error) ? undefined : contacts.data?.find(item => item.user_id === user.user_id);
  return <>
    <div className={s.identity}><ChipAvatar src={person?.photo_url ?? user.avatar_url} large /><div><strong>{person ? [person.surname, person.name, person.patronymic].filter(Boolean).join(" ") : user.display_name}</strong><small>Профиль участника</small></div></div>
    {person ? <dl className={s.details}>{person.group_number && person.group_number !== "0" && <div><dt>Группа</dt><dd>{person.group_number}</dd></div>}{person.blocks && <div><dt>Команды</dt><dd>{person.blocks}</dd></div>}{person.location && <div><dt>Локация</dt><dd>{person.location}</dd></div>}</dl> : <p className={s.hint}>{contacts.isLoading ? "Загружаем профиль…" : "Дополнительные сведения недоступны"}</p>}
  </>;
}
