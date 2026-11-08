import { ProfileBadge } from '../../components/ProfileBadge/ProfileBadge';
import { Page, Card, RouteLink } from '../../components/Workspace/WorkspaceUI';
import { useMe } from '../../utils/me';
import { useSession } from '../../utils/session';
import { useLogout } from '../../utils/hooks/useLogout';
import { ProfileActivity } from '../../components/Workspace/ProfileActivity';
import { ProfileAchievements } from '../../components/Workspace/ProfileAchievements';
import { ProfileTeams } from '../../components/Workspace/ProfileTeams';
import { getProfileSettingsRoute } from '../../utils/routes';
import s from '../../components/Workspace/Workspace.module.css';
export const ProfilePage = () => {
  const user = useMe(); const { logout, busy, error } = useLogout();
  // The service account is no person: the server answers no team, award or activity of it,
  // and its name and address are the server's (backend/docs/SERVICE_ACCOUNT.md).
  const service = !!useSession().session?.service_account;
  if (!user) return null;
  return (
    <Page title="Мой профиль" description="Ваши контакты и данные об участии в Профкоме." actions={<RouteLink to={getProfileSettingsRoute()}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m9.5 3-.6 2-1.6.9-2-.5-2.5 4.2 1.5 1.5v1.8l-1.5 1.5 2.5 4.2 2-.5 1.6.9.6 2h5l.6-2 1.6-.9 2 .5 2.5-4.2-1.5-1.5v-1.8l1.5-1.5-2.5-4.2-2 .5-1.6-.9-.6-2z" /><circle cx="12" cy="12" r="3" /></svg>Настройки
    </RouteLink>}>
      <div className={s.stack}>
      <div className={s.columns}>
        <ProfileBadge user={user} readOnly />
        <div className={s.stack}>
          <Card title="Управление профилем">
            <div className={s.row}>
              {!service && <RouteLink to="/profile/edit">Редактировать свои данные</RouteLink>}
              <RouteLink to="/support">Мои обращения</RouteLink>
              <button className={s.button} disabled={busy} onClick={() => void logout()}>{busy ? 'Выходим…' : 'Выйти'}</button>
            </div>
            {error && <p role="alert">{error}</p>}
          </Card>
          {service
            ? <Card title="Участие"><p className={s.muted}>Сервисный аккаунт не участвует в работе Профкома: у него нет команд, достижений и истории участия.</p></Card>
            : <ProfileTeams userId={user.user_id} />}
        </div>
      </div>
      {!service && <ProfileAchievements userId={user.user_id} />}
      {!service && <ProfileActivity userId={user.user_id} hideCurrent />}
      </div>
    </Page>
  );
};
