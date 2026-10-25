import { ProfileBadge } from '../../components/ProfileBadge/ProfileBadge';
import { Page, Card, RouteLink } from '../../components/Workspace/WorkspaceUI';
import { useMe } from '../../utils/me';
import { useLogout } from '../../utils/hooks/useLogout';
import { AvatarPicker } from '../../components/Workspace/AvatarPicker';
import s from '../../components/Workspace/Workspace.module.css';
export const ProfilePage = () => {
  const user = useMe(); const { logout, busy, error } = useLogout();
  if (!user) return null;
  return (
    <Page title="Мой профиль" description="Ваши контакты и данные об участии в Профкоме.">
      <div className={s.columns}>
        <ProfileBadge user={user} readOnly />
        <div className={s.stack}>
          <Card title="Управление профилем">
            <div className={s.row}>
              <RouteLink to="/profile/edit">Редактировать свои данные</RouteLink>
              <button className={s.button} disabled={busy} onClick={() => void logout()}>{busy ? 'Выходим…' : 'Выйти'}</button>
            </div>
            {error && <p role="alert">{error}</p>}
          </Card>
          <Card title="Аватар"><AvatarPicker /></Card>
        </div>
      </div>
    </Page>
  );
};
