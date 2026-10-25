import { Suspense } from "react";
import { Loading } from "./WorkspaceUI";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useMe } from "../../utils/me";
import { can, useSession } from "../../utils/session";
import { DemoRolePicker } from "./DemoRolePicker";
import { useQuery } from "@tanstack/react-query";
import { workspaceApi } from "../../utils/api/workspace.api";
import s from "./WorkspaceLayout.module.css";
import ws from "./Workspace.module.css";
import ProfkomLogo from "../profkomLogo";
import { visibleAdminTabs } from "../../pages/Admin/adminTabs";
const navigation = [
  ["/", "Рабочий экран", "space_dashboard"],
  ["/events", "Мероприятия", "celebration"],
  ["/tasks", "Мои задачи", "task_alt"],
  ["/blocks", "Блоки", "groups"],
  ["/calendar", "Календарь", "calendar_month"],
  ["/materials", "Материалы", "menu_book"],
  ["/pgas", "ПГАС", "workspace_premium"],
  ["/contacts", "Контакты", "contacts"],
  ["/notifications", "Уведомления", "notifications"],
];
// The icon name comes from CSS: it is not part of the link text.
const NavIcon = ({ name }: { name: string }) => (
  <span className={`material-symbols-rounded ${s.icon}`} data-icon={name} aria-hidden="true" />
);

export function WorkspaceLayout() {
  const user = useMe();
  const { session } = useSession();
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: workspaceApi.notifications,
  });
  const unread =
    notifications.data?.items.filter((n) => !n.read_at).length ?? 0;
  const links = (
    <nav
      className={s.nav}
      aria-label="Основная навигация"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a"))
          event.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {navigation.map(([to, label, icon]) => (
        <NavLink end={to === "/"} key={to} to={to}>
          <NavIcon name={icon} />
          {label}
          {to === "/notifications" && unread > 0 && (
            <span className={s.count}><span className={s.hiddenText}> · </span>{unread}</span>
          )}
        </NavLink>
      ))}
      {can(session, "view_summary") && (
        <NavLink to="/seasons"><NavIcon name="insights" />Сезоны и ККР</NavLink>
      )}
      {(["create_volunteer_merit", "create_head_merit", "create_chair_merit"].some((cap) => can(session, cap) || session?.assignments?.some((a) => can(a, cap)))) && (
        <NavLink to="/merits"><NavIcon name="fact_check" />Учёт выполненной работы</NavLink>
      )}
      {visibleAdminTabs(session).length > 0 && (
        <NavLink to="/admin"><NavIcon name="admin_panel_settings" />Администрирование</NavLink>
      )}
      <NavLink to="/profile"><NavIcon name="account_circle" />Мой профиль</NavLink>
    </nav>
  );
  return (
    <div className={s.shell}>
      <aside className={s.sidebar}>
        <Link className={s.brand} to="/">
          <ProfkomLogo variant="desktop" width={42} strokeWidth={16} aria-hidden="true" />
          <span>Профком<small>ВМК МГУ</small></span>
        </Link>
        {links}
        <details className={s.mobile}>
          <summary><NavIcon name="menu" />Меню</summary>
          {links}
        </details>
        <div className={s.profile}>
          <Link to="/profile">
            {user?.name} {user?.surname}
          </Link>
        </div>
        <DemoRolePicker />
      </aside>
      <main className={s.content}>
        {user?.has_password === false && (
          // VK is the only way in for this account; a password is the way when VK fails (АВ-52).
          <p role="note" className={ws.warning}>
            Задайте пароль, чтобы входить по почте, если вход через VK недоступен.{" "}
            <Link to="/profile/edit">Задать пароль</Link>
          </p>
        )}
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
