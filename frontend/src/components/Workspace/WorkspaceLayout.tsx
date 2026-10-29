import { Suspense, type CSSProperties } from "react";
import { Loading } from "./WorkspaceUI";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useMe } from "../../utils/me";
import { can, useSession } from "../../utils/session";
import { DemoRolePicker } from "./DemoRolePicker";
import { NotificationBell } from "./NotificationBell";
import s from "./WorkspaceLayout.module.css";
import ws from "./Workspace.module.css";
import ProfkomLogo from "../profkomLogo";
import { visibleAdminTabs } from "../../pages/Admin/adminTabs";
import { Glyph } from "./WorkspaceUI";
import { SECTIONS, SectionContext, sectionOf, toneStyle } from "./sections";
import type { Session } from "../../utils/api/contract";

const MERIT_CAPS = ["create_volunteer_merit", "create_head_merit", "create_chair_merit"];
/** Menu items that need a role; the others are for everyone. */
const shown: Record<string, (session: Session | null) => boolean> = {
  "/seasons": (session) => can(session, "view_summary"),
  "/merits": (session) =>
    MERIT_CAPS.some((cap) => can(session, cap) || !!session?.assignments?.some((a) => can(a, cap))),
  "/admin": (session) => visibleAdminTabs(session).length > 0,
};

export function WorkspaceLayout() {
  const user = useMe();
  const { session } = useSession();
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const links = (includeProfile = false) => (
    <nav
      className={s.nav}
      aria-label="Основная навигация"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a"))
          event.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {/* The item of the page's section is marked on its inner pages too (a subevent is under Мероприятия). */}
      {SECTIONS.filter(({ to }) => to !== "/notifications" && (shown[to]?.(session) ?? true)).map(({ to, label, icon, tone }) => (
        <Link key={to} to={to} style={toneStyle(tone)}
          aria-current={pathname === to ? "page" : section.to === to ? "true" : undefined}>
          <Glyph name={icon} className={s.icon} />
          {label}
        </Link>
      ))}
      {includeProfile && <Link className={s.mobileProfile} to="/profile" style={toneStyle("yellow")}
        aria-label="Мой профиль" aria-current={pathname === "/profile" ? "page" : pathname.startsWith("/profile/") ? "true" : undefined}>
        <Glyph name="account_circle" className={s.icon} />Мой профиль
      </Link>}
    </nav>
  );
  return (
    <div className={s.shell} style={{ "--section": `var(--accent-${section.tone})` } as CSSProperties}>
      <aside className={s.sidebar}>
        <Link className={s.brand} to="/">
          <ProfkomLogo variant="desktop" width={42} strokeWidth={16} aria-hidden="true" />
          <span>Профком<small>ВМК МГУ</small></span>
        </Link>
        {links()}
        <details className={s.mobile}>
          <summary><Glyph name="menu" className={s.icon} />Меню</summary>
          {links(true)}
        </details>
        <div className={s.profile}>
          <Link to="/profile" aria-label="Мой профиль" aria-current={pathname === "/profile" ? "page" : pathname.startsWith("/profile/") ? "true" : undefined}>
            <Glyph name="account_circle" className={s.icon} />
            <span>{user ? `${user.name} ${user.surname}` : "Мой профиль"}</span>
          </Link>
        </div>
        <DemoRolePicker />
      </aside>
      <div className={s.notifications}><NotificationBell /></div>
      <main className={s.content}>
        {user?.has_password === false && (
          // VK is the only way in for this account; a password is the way when VK fails (АВ-52).
          <p role="note" className={ws.warning}>
            Задайте пароль, чтобы входить по почте, если вход через VK недоступен.{" "}
            <Link to="/profile/edit">Задать пароль</Link>
          </p>
        )}
        <SectionContext.Provider value={section}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </SectionContext.Provider>
      </main>
    </div>
  );
}
