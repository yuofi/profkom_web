import { useId, useRef, useState } from "react";
import { BlockChip } from "../../components/Workspace/BlockChip";
import { UserChip } from "../../components/Workspace/UserChip";
import type { Block, Leadership, UserRef } from "../../utils/api/contract";
import s from "./OrganizationTree.module.css";

interface OrganizationTreeProps {
  blocks: Block[];
  leadership: Leadership;
  people: UserRef[];
}
const normalized = (value: string) => value.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();

/** A readable hierarchy of ordinary lists, with the same profile/block chips as the workspace. */
export function OrganizationTree({ blocks, leadership, people }: OrganizationTreeProps) {
  const id = useId(), searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const terms = normalized(search).split(/\s+/).filter(Boolean), searching = terms.length > 0;
  const matches = (value: string) => terms.every(term => normalized(value).includes(term));
  const matchClass = (value: string) => searching && matches(value) ? s.searchMatch : "";
  const clearSearch = () => { setSearch("");searchInput.current?.focus(); };
  const toggle = (blockId: string) => setExpandedIds(previous => { const next = new Set(previous);if (next.has(blockId)) next.delete(blockId);else next.add(blockId);return next; });
  const identities = new Map<number, UserRef>();
  const remember = (user: UserRef) => { if (user.user_id !== null) identities.set(user.user_id, user); };
  people.forEach(remember);
  blocks.forEach(block => { block.members.forEach(member => remember(member.user));if (block.master) remember(block.master.user);if (block.hr) remember(block.hr); });
  if (leadership.chair) remember(leadership.chair);
  leadership.deputies.forEach(remember);
  const rows = blocks.map(block => {
    const leaderIds = new Set([block.master?.user.user_id, ...(block.master?.deputy_user_ids ?? [])]);
    const deputies = [...new Set(block.master?.deputy_user_ids ?? [])].filter(userId => userId !== block.master?.user.user_id);
    const members = block.members.filter(member => member.user.user_id === null || !leaderIds.has(member.user.user_id));
    const users = [...(block.master ? [block.master.user] : []), ...(block.hr ? [block.hr] : []), ...deputies.flatMap(userId => { const user = identities.get(userId);return user ? [user] : []; }), ...members.map(member => member.user)];
    return { block, deputies, members, matches: matches(block.name) || users.some(user => matches(user.display_name)) };
  });
  const shown = searching ? rows.filter(row => row.matches) : rows;
  const globalMatches = searching ? [leadership.chair, ...leadership.deputies].filter(user => user && matches(user.display_name)).length : 0;
  const allExpanded = blocks.length > 0 && blocks.every(block => expandedIds.has(block.block_id));
  const noneExpanded = blocks.every(block => !expandedIds.has(block.block_id));

  return <section className={s.tree} aria-label="Структура Профкома">
    <div className={s.toolbar} role="search" aria-label="Поиск по структуре Профкома">
      <label className={s.search} htmlFor={`${id}-search`}><span>Поиск по структуре</span><input ref={searchInput} id={`${id}-search`} type="search" autoComplete="off" placeholder="Название блока или имя участника" value={search} onChange={event => setSearch(event.target.value)} aria-describedby={`${id}-search-hint`} /></label>
      {search && <button type="button" className={s.action} aria-label="Сбросить поиск" onClick={clearSearch}>Сбросить</button>}
      <div className={s.actions} aria-label="Вид дерева">
        <button type="button" className={s.action} disabled={searching || allExpanded || !blocks.length} onClick={() => setExpandedIds(new Set(blocks.map(block => block.block_id)))}>Развернуть все</button>
        <button type="button" className={s.action} disabled={searching || noneExpanded} onClick={() => setExpandedIds(new Set())}>Свернуть все</button>
      </div>
    </div>
    <p className={s.searchHint} id={`${id}-search-hint`} role="status">{searching ? `Найдено блоков: ${shown.length} из ${blocks.length}. Совпадений в руководстве Профкома: ${globalMatches}. Найденные блоки раскрыты целиком; сброс поиска вернёт прежний вид дерева.` : "Поиск по названиям блоков и именам руководителей и участников. Раскройте блок стрелкой, чтобы увидеть состав."}</p>
    <header className={s.root}>
      <div><h2>Профком ВМК</h2><p>Руководство и состав блоков</p></div>
      <span className={s.count}>Блоков: {blocks.length}</span>
    </header>
    <section className={s.leadership} aria-label="Руководство Профкома">
      <div className={s.leaderGroup}><h3>Председатель</h3>{leadership.chair ? <UserChip user={leadership.chair} className={matchClass(leadership.chair.display_name)} /> : <span className={s.empty}>Не назначен</span>}</div>
      <div className={s.leaderGroup}><h3>Заместители председателя</h3>{leadership.deputies.length ? <ul className={s.chips}>{leadership.deputies.map((user, index) => <li key={user.user_id ?? `deputy-${index}`}><UserChip user={user} className={matchClass(user.display_name)} /></li>)}</ul> : <span className={s.empty}>Не назначены</span>}</div>
    </section>
    {shown.length ? <ul className={s.branches} aria-label="Блоки Профкома">{shown.map(({ block, deputies, members }) => {
      const expanded = searching || expandedIds.has(block.block_id), bodyId = `${id}-block-${block.block_id}`;
      return <li key={block.block_id} className={s.block}>
        <div className={s.blockHeading}>
          <button type="button" className={s.toggle} aria-label={`${expanded ? "Свернуть" : "Развернуть"} блок ${block.name}`} aria-expanded={expanded} aria-controls={bodyId} disabled={searching} title={searching ? "При поиске найденные блоки раскрыты" : undefined} onClick={() => toggle(block.block_id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
          <BlockChip block={block} className={matchClass(block.name)} /><span className={s.count}>Участников: {members.length + (block.master ? 1 : 0) + deputies.length}</span>
        </div>
        <div id={bodyId} className={s.blockBody} hidden={!expanded}>{expanded && <>
          <section className={s.blockLeadership} aria-label={`Руководство блока ${block.name}`}>
            <div className={s.leaderRow}><h3>Мастер</h3>{block.master ? <UserChip user={block.master.user} className={matchClass(block.master.user.display_name)} /> : <span className={s.empty}>Не назначен</span>}</div>
            {deputies.length > 0 && <div className={s.leaderRow}><h3>Заместители</h3><ul className={s.chips}>{deputies.map(userId => {
              const user = identities.get(userId);
              return <li key={userId}>{user ? <UserChip user={user} className={matchClass(user.display_name)} /> : <UserChip user={{ user_id: null, display_name: "Профиль недоступен", avatar_url: null }} interactive={false} />}</li>;
            })}</ul></div>}
            <div className={s.leaderRow}><h3>HR</h3>{block.hr ? <UserChip user={block.hr} className={matchClass(block.hr.display_name)} /> : <span className={s.empty}>Не назначен</span>}</div>
          </section>
          <div className={s.members}>
            <h3>Участники</h3>
            {members.length ? <ul className={s.branches} aria-label={`Участники блока ${block.name}`}>{members.map((member, index) => <li className={s.member} key={member.user.user_id ?? `member-${index}`}><UserChip user={member.user} className={matchClass(member.user.display_name)} />{member.block_category === "junior" && <span className={s.category}>Новичок</span>}</li>)}</ul> : <p className={s.empty}>Других участников пока нет</p>}
          </div>
        </>}</div>
      </li>;
    })}</ul> : blocks.length ? <div className={s.noResults}><p>{globalMatches ? "В блоках совпадений нет. Найденные участники руководства Профкома отмечены выше." : "Ничего не найдено. Попробуйте другое имя или название блока."}</p><button type="button" className={s.action} onClick={clearSearch}>Показать все блоки</button></div> : <p className={s.empty}>Блоки пока не добавлены.</p>}
  </section>;
}
