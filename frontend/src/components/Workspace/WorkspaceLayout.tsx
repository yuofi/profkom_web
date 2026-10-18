import { Link, NavLink, Outlet } from 'react-router-dom';
import { useMe } from '../../utils/me';
import { can, useSession } from '../../utils/session';
import { DemoRolePicker } from './DemoRolePicker';
import s from './WorkspaceLayout.module.css';
const navigation = [['/', 'Рабочий экран'], ['/events', 'Мероприятия'], ['/tasks', 'Мои задачи'], ['/blocks', 'Блоки'], ['/calendar', 'Календарь'], ['/materials', 'Материалы'], ['/pgas', 'ПГАС'], ['/contacts', 'Контакты'], ['/notifications', 'Уведомления']];

export function WorkspaceLayout() {
  const user = useMe(); const { session } = useSession();
  const links = <nav className={s.nav} aria-label="Основная навигация" onClick={event => { if ((event.target as HTMLElement).closest('a')) event.currentTarget.closest('details')?.removeAttribute('open'); }}>{navigation.map(([to, label]) => <NavLink end={to === '/'} key={to} to={to}>{label}</NavLink>)}{can(session, 'view_summary') && <NavLink to="/seasons">Сезоны и ККР</NavLink>}{can(session, 'review_registrations') && <NavLink to="/registrations">Регистрации</NavLink>}{can(session, 'transfer_chair') && <NavLink to="/leadership">Руководство</NavLink>}<NavLink to="/profile">Мой профиль</NavLink></nav>;
  return <div className={s.shell}><aside className={s.sidebar}><Link className={s.brand} to="/">Профком<small>ВМК МГУ</small></Link>{links}<details className={s.mobile}><summary>Меню</summary>{links}</details><div className={s.profile}><Link to="/profile">{user?.name} {user?.surname}</Link></div><DemoRolePicker /></aside><main className={s.content}><Outlet /></main></div>;
}
