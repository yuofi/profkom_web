import { Suspense, useContext, useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading } from "./WorkspaceUI";
import { Link, Outlet, UNSAFE_DataRouterContext, useLocation } from "react-router-dom";
import { prefetchRouteData, preloadRouteCode } from "../../utils/routePrefetch";
import { useMe } from "../../utils/me";
import { personName } from "../../utils/personName";
import { can, isWorkingSession, useSession } from "../../utils/session";
import { supportApi } from "../../utils/api/support.api";
import { canRetainData } from "../../utils/api/request";
import { DemoRolePicker } from "./DemoRolePicker";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { NotificationBell } from "./NotificationBell";
import { BotLinkBanner } from "./BotLinkBanner";
import { FeedbackSideMenuContext } from "./feedbackDialog";
import s from "./WorkspaceLayout.module.css";
import ws from "./Workspace.module.css";
import ProfkomLogo from "../profkomLogo";
import { visibleAdminTabs } from "../../pages/Admin/adminTabs";
import { Glyph } from "./WorkspaceUI";
import { SECTIONS, SectionContext, sectionOf, toneStyle } from "./sections";
import type { Session } from "../../utils/api/contract";
import { createsMerits, readsMerits } from "../../pages/Workspace/meritAccess";

/** Menu items that need a role; the others are for everyone. */
const shown: Record<string, (session: Session | null) => boolean> = {
  "/seasons": (session) => can(session, "view_summary"),
  "/merits": (session) => createsMerits(session) || readsMerits(session),
  "/admin": (session) => visibleAdminTabs(session).length > 0,
  // The chair, the deputies and the senders they name (BOT_API.md, stage 4).
  "/broadcasts": (session) => can(session, "send_broadcast") || can(session, "manage_broadcast_senders"),
};

const noSubscription = () => () => {};
/** A route whose code is still loading keeps the previous page on screen (the router renders
 *  in a transition): a thin bar says at once that the click was taken (GL-14). The router's
 *  own state already has the new location; the rendered one follows when the page is ready.
 *  The new route's code and first data start together at this moment (PF-04). */
function NavigationProgress() {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const shown = useLocation(), client = useQueryClient();
  const target = useSyncExternalStore(router ? router.subscribe : noSubscription, () => router?.state.location ?? shown);
  const pending = target.key !== shown.key;
  useEffect(() => {
    if (!pending) return;
    preloadRouteCode(target.pathname);
    prefetchRouteData(client, target.pathname);
  }, [pending, target.pathname, client]);
  return pending ? <div className={s.progress} role="progressbar" aria-label="Открываем страницу" /> : null;
}
/** The sections of the menu load their code when the browser is idle; not on a data saver,
 *  a slow link or a mobile network, where each section loads when it is opened. */
function useIdleSectionCode(paths: string[]) {
  const key = paths.join(" ");
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string; type?: string } }).connection;
    if (connection?.saveData || /[23]g/.test(connection?.effectiveType ?? "") || connection?.type === "cellular") return;
    const load = () => key.split(" ").forEach(preloadRouteCode);
    const idle = window.requestIdleCallback;
    const timer = setTimeout(() => idle ? idle(load, { timeout: 5000 }) : load(), 2500);
    return () => clearTimeout(timer);
  }, [key]);
}
/** The mobile menu closes on Escape and on a tap outside it, the bell included (GL-19). */
function useDismissibleMenu() {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !menu.current?.open) return;
      menu.current.removeAttribute("open");menu.current.querySelector("summary")?.focus();
    };
    const pointer = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.removeAttribute("open");
    };
    document.addEventListener("keydown", key);document.addEventListener("pointerdown", pointer);
    return () => { document.removeEventListener("keydown", key);document.removeEventListener("pointerdown", pointer); };
  }, []);
  return menu;
}
/** While the session is checked (F5): the frame of the workspace without its menu, which
 *  depends on the session's rights, and without any user data (GL-34). Its menu (the brand only)
 *  registers too: on a task page the report button is bottom-left from the first frame (D-03). */
export function WorkspaceSkeleton() {
  const { pathname } = useLocation();
  const registerSideMenu = useContext(FeedbackSideMenuContext);
  return (
    <div className={s.shell} style={{ "--section": `var(--accent-${sectionOf(pathname).tone})` } as CSSProperties}>
      <aside ref={registerSideMenu ?? undefined} className={s.sidebar}>
        <Link className={s.brand} to="/">
          <ProfkomLogo variant="desktop" width={42} strokeWidth={16} aria-hidden="true" />
          <span>Профком<small>ВМК МГУ</small></span>
        </Link>
      </aside>
      <main className={s.content}><Loading /></main>
    </div>
  );
}

/** The workspace frame; `children` stand in for the route outlet (the 404 page uses it). */
export function WorkspaceLayout({ children }: { children?: ReactNode } = {}) {
  const user = useMe();
  const { session } = useSession();
  const { pathname } = useLocation();
  const client = useQueryClient();
  // The same query as the support page: on /support only, and no extra request.
  const onSupport = pathname === "/support" || pathname.startsWith("/support/");
  const support = useQuery({ queryKey: ["supportContext"], queryFn: supportApi.context, enabled: onSupport && isWorkingSession(session) });
  const supportStaff = onSupport && (!support.error || canRetainData(support.error)) && !!(support.data?.can_triage || support.data?.can_configure);
  const section = sectionOf(pathname, { supportStaff, broadcaster: shown["/broadcasts"](session) });
  const menu = useDismissibleMenu();
  const registerSideMenu = useContext(FeedbackSideMenuContext);
  const visible = SECTIONS.filter(({ to }) => to !== "/notifications" && (shown[to]?.(session) ?? true));
  useIdleSectionCode(visible.map(({ to }) => to));
  // The first load of a page (F5, a shared link): its data starts beside its code.
  useEffect(() => { prefetchRouteData(client, pathname); }, [client, pathname]);
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
      {visible.map(({ to, label, icon, tone }) => (
        <Link key={to} to={to} style={toneStyle(tone)}
          onPointerEnter={() => preloadRouteCode(to)} onFocus={() => preloadRouteCode(to)}
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
      <NavigationProgress />
      <aside ref={registerSideMenu ?? undefined} className={s.sidebar}>
        <Link className={s.brand} to="/">
          <ProfkomLogo variant="desktop" width={42} strokeWidth={16} aria-hidden="true" />
          <span>Профком<small>ВМК МГУ</small></span>
        </Link>
        {links()}
        <details ref={menu} className={s.mobile}>
          <summary><Glyph name="menu" className={s.icon} />Меню</summary>
          {links(true)}
        </details>
        <div className={s.profile}>
          <Link to="/profile" aria-label="Мой профиль" aria-current={pathname === "/profile" ? "page" : pathname.startsWith("/profile/") ? "true" : undefined}>
            <Glyph name="account_circle" className={s.icon} />
            <span>{(user && personName(user)) || "Мой профиль"}</span>
          </Link>
        </div>
        <DemoRolePicker />
      </aside>
      <div className={s.notifications}><NotificationBell /></div>
      <main className={s.content}>
        {user?.has_password === false && pathname !== "/profile/edit" && (
          // VK is the only way in for this account; a password is the way when VK fails (АВ-52).
          <p role="note" className={ws.warning}>
            Задайте пароль, чтобы входить по почте, если вход через VK недоступен.{" "}
            <Link to="/profile/edit">Задать пароль</Link>
          </p>
        )}
        <BotLinkBanner />
        <SectionContext.Provider value={section}>
          <PageErrorBoundary resetKey={pathname}>
            <Suspense fallback={<Loading />}>
              {children ?? <Outlet />}
            </Suspense>
          </PageErrorBoundary>
        </SectionContext.Provider>
      </main>
    </div>
  );
}
