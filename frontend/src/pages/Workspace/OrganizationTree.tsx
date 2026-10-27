import { BlockChip } from "../../components/Workspace/BlockChip";
import { UserChip } from "../../components/Workspace/UserChip";
import type { Block, Leadership, UserRef } from "../../utils/api/contract";
import s from "./OrganizationTree.module.css";

interface OrganizationTreeProps {
  blocks: Block[];
  leadership: Leadership;
  people: UserRef[];
}

/** A readable hierarchy of ordinary lists, with the same profile/block chips as the workspace. */
export function OrganizationTree({ blocks, leadership, people }: OrganizationTreeProps) {
  const identities = new Map<number, UserRef>();
  const remember = (user: UserRef) => { if (user.user_id !== null) identities.set(user.user_id, user); };
  people.forEach(remember);
  blocks.forEach(block => { block.members.forEach(member => remember(member.user));if (block.master) remember(block.master.user); });
  if (leadership.chair) remember(leadership.chair);
  leadership.deputies.forEach(remember);

  return <section className={s.tree} aria-label="Структура Профкома">
    <header className={s.root}>
      <div><h2>Профком ВМК</h2><p>Руководство и состав блоков</p></div>
      <span className={s.count}>Блоков: {blocks.length}</span>
    </header>
    <section className={s.leadership} aria-label="Руководство Профкома">
      <div className={s.leaderGroup}><h3>Председатель</h3>{leadership.chair ? <UserChip user={leadership.chair} /> : <span className={s.empty}>Не назначен</span>}</div>
      <div className={s.leaderGroup}><h3>Заместители председателя</h3>{leadership.deputies.length ? <ul className={s.chips}>{leadership.deputies.map((user, index) => <li key={user.user_id ?? `deputy-${index}`}><UserChip user={user} /></li>)}</ul> : <span className={s.empty}>Не назначены</span>}</div>
    </section>
    {blocks.length ? <ul className={s.branches} aria-label="Блоки Профкома">{blocks.map(block => {
      const leaderIds = new Set([block.master?.user.user_id, ...(block.master?.deputy_user_ids ?? [])]);
      const deputies = [...new Set(block.master?.deputy_user_ids ?? [])].filter(id => id !== block.master?.user.user_id);
      const members = block.members.filter(member => member.user.user_id === null || !leaderIds.has(member.user.user_id));
      return <li key={block.block_id} className={s.block}>
        <div className={s.blockHeading}><BlockChip block={block} /><span className={s.count}>Участников: {members.length + (block.master ? 1 : 0) + deputies.length}</span></div>
        <div className={s.blockBody}>
          <section className={s.blockLeadership} aria-label={`Руководство блока ${block.name}`}>
            <div className={s.leaderRow}><h3>Мастер</h3>{block.master ? <UserChip user={block.master.user} /> : <span className={s.empty}>Не назначен</span>}</div>
            {deputies.length > 0 && <div className={s.leaderRow}><h3>Заместители</h3><ul className={s.chips}>{deputies.map(id => {
              const user = identities.get(id);
              return <li key={id}>{user ? <UserChip user={user} /> : <UserChip user={{ user_id: null, display_name: "Профиль недоступен", avatar_url: null }} interactive={false} />}</li>;
            })}</ul></div>}
          </section>
          <div className={s.members}>
            <h3>Участники</h3>
            {members.length ? <ul className={s.branches} aria-label={`Участники блока ${block.name}`}>{members.map((member, index) => <li className={s.member} key={member.user.user_id ?? `member-${index}`}><UserChip user={member.user} />{member.block_category === "junior" && <span className={s.category}>Новичок</span>}</li>)}</ul> : <p className={s.empty}>Других участников пока нет</p>}
          </div>
        </div>
      </li>;
    })}</ul> : <p className={s.empty}>Блоки пока не добавлены.</p>}
  </section>;
}
