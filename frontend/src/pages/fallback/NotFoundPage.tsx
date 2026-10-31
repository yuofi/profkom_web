import { Link, useLocation, useNavigate } from "react-router-dom";
import styles from "./UnderConstruction.module.css";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { Image } from "../../components/Image/Image";
import { isActiveSession, useSession } from "../../utils/session";
import { WorkspaceLayout, WorkspaceSkeleton } from "../../components/Workspace/WorkspaceLayout";
import { Empty, Page, RouteLink } from "../../components/Workspace/WorkspaceUI";
import w from "../../components/Workspace/Workspace.module.css";

const TITLE = "404: Страница не найдена | Профком ВМК";

/** «Назад» only when this tab came here from another page of the site. */
function BackButton({ className }: { className?: string }) {
  const navigate = useNavigate(), { key } = useLocation();
  return key === "default" ? null : <button type="button" className={className} onClick={() => navigate(-1)}>Назад</button>;
}

/** For visitors who are not signed in: the public page with the way to the site (GL-21). */
export const NotFoundPage = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  return (
    <div className={styles.globalWrapper}>
      <title>{TITLE}</title>
    <div className={styles.wrapper}>
      <h1 className={styles.heading}>Такой страницы не существует!</h1>
      <nav className={styles.actions} aria-label="Куда перейти">
        <Link className={styles.subheadingLink} to="/">На главную</Link>
        <BackButton className={styles.subheadingLink} />
      </nav>
      {isMobile ? (
          <Image src="/nf-mobile-capy.webp" disableModal={true} />
        ) : (
            <Image src="/nf-desktop-capy.webp" disableModal={true} />
        )}
    </div>
    </div>
  );
};

/** Inside the workspace, with its menu, for a signed-in member (GL-21). */
function WorkspaceNotFound() {
  return <Page title="Страница не найдена">
    <title>{TITLE}</title>
    <Empty>Такой страницы нет: возможно, ссылка устарела или в адресе опечатка.</Empty>
    <nav className={w.row} aria-label="Куда перейти"><RouteLink to="/">На главную</RouteLink><BackButton className={w.button} /></nav>
  </Page>;
}

/** An unknown address: the workspace frame for an active session, the public page otherwise
 *  (a visitor is not sent to the login form for a mistyped link). */
export function NotFoundRoute() {
  const { session, loading } = useSession();
  if (loading) return <WorkspaceSkeleton />;
  return isActiveSession(session) && !session?.password_change_required
    ? <WorkspaceLayout><WorkspaceNotFound /></WorkspaceLayout>
    : <NotFoundPage />;
}

export default NotFoundRoute;
