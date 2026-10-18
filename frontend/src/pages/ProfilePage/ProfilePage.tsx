import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import Cookies from 'js-cookie';
import { ProfileBadge } from '../../components/ProfileBadge/ProfileBadge';
import { Page, Card, RouteLink } from '../../components/Workspace/WorkspaceUI';
import { useMe } from '../../utils/me';
import { authApi } from '../../utils/api/auth.api';
import s from '../../components/Workspace/Workspace.module.css';
export const ProfilePage = () => {
  const user = useMe(); const client = useQueryClient(); const navigate = useNavigate();
  if (!user) return null;
  return <Page title="Мой профиль" description="Ваши контакты и данные об участии в Профкоме."><div className={s.grid}><ProfileBadge user={user} readOnly /><Card title="Управление профилем"><div className={s.stack}><RouteLink to="/profile/edit">Редактировать свои данные</RouteLink><button className={s.button} onClick={async () => { try { await authApi.logout(); } finally { Cookies.remove('access_token'); client.clear(); navigate('/auth', { replace: true }); } }}>Выйти</button></div></Card></div></Page>;
};
