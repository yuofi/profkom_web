import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import Cookies from 'js-cookie';
import { Page, Card, Loading, ErrorState } from '../../components/Workspace/WorkspaceUI';
import { ActionForm } from '../../components/Workspace/ActionForm';
import { number, ids } from '../../components/Workspace/formValues';
import { useSession, can } from '../../utils/session';
import { membershipApi } from '../../utils/api/membership.api';
import { sessionApi } from '../../utils/api/session.api';
import { directoryApi } from '../../utils/api/directory.api';
import { clearPrivateCache } from '../../utils/api/invalidation';
import s from '../../components/Workspace/Workspace.module.css';
import { RegistrationForm } from '../../components/Workspace/RegistrationForm';
import { DemoRolePicker } from '../../components/Workspace/DemoRolePicker';
export function AccountStatePage() {
  const { session } = useSession();
  const application = useQuery({ queryKey: ['registrations', 'me'], queryFn: membershipApi.registration, enabled: session?.account_state === 'pending', retry: false });
  return <Page title={session?.account_state === 'archived' ? 'Аккаунт в архиве' : session?.registration_status === 'rejected' ? 'Нужно уточнить сведения' : 'Заявка на рассмотрении'} description="Рабочие разделы станут доступны после одобрения регистрации."><Card><DemoRolePicker />{application.isLoading ? <Loading /> : application.error ? <ErrorState error={application.error} /> : <><p>{application.data?.rejection_reason ?? 'Дождитесь решения руководства Профкома.'}</p>{application.data && <p>Использовано отправок: {application.data.attempts_used} из {application.data.attempt_limit}.</p>}{application.data && application.data.status !== 'approved' && <RegistrationForm application={application.data} />}</>}<Link className={s.linkButton} to="/auth" onClick={() => Cookies.remove('access_token')}>Ко входу</Link></Card></Page>;
}
export function WorkspaceStartPage() {
  return <Page title="Рабочий экран" description="Задачи, команды и ближайшие встречи в одном месте."><div className={s.grid}><Card title="Мои задачи"><Link className={s.linkButton} to="/tasks">Открыть задачи</Link></Card><Card title="Мероприятия"><Link className={s.linkButton} to="/events">Мои команды</Link></Card><Card title="Блоки"><Link className={s.linkButton} to="/blocks">Открыть блоки</Link></Card></div></Page>;
}
export function ComingPage({ title }: { title: string }) { return <Page title={title}><Card><p>Здесь пока нет доступных записей.</p></Card></Page>; }
export function LeadershipPage() {
  const { session } = useSession(); const client = useQueryClient();
  const leadership = useQuery({ queryKey: ['leadership'], queryFn: sessionApi.leadership });
  const contacts = useQuery({ queryKey: ['contacts'], queryFn: directoryApi.contacts });
  if (leadership.isLoading) return <Loading />;
  if (leadership.error) return <ErrorState error={leadership.error} />;
  const current = leadership.data!;
  const choices = contacts.data?.filter(p => p.user_id !== current.chair.user_id).map(p => ({ value: String(p.user_id), label: `${p.surname} ${p.name}` })) ?? [];
  return <Page title="Руководство Профкома"><div className={s.stack}><Card title="Текущий состав"><p>Председатель: {current.chair.display_name}</p><p>Заместители: {current.deputies.map(p => p.display_name).join(', ') || 'не назначены'}</p></Card>{can(current, 'transfer_chair') && can(session, 'transfer_chair') && <Card title="Передача поста"><p>Новый председатель получит полномочия. Прежние заместители потеряют глобальные права; остальные назначения сохранятся.</p><ActionForm key={`transfer-${current.revision}`} fields={[{ name: 'user', label: 'Новый председатель', type: 'select', options: choices, required: true }]} submitLabel="Передать пост" onSubmit={async v => { await sessionApi.transfer(number(v, 'user'), { expected_revision: current.revision }); await clearPrivateCache(client); }} /></Card>}{can(current, 'manage_chair_deputies') && <Card title="Заместители председателя"><ActionForm key={`deputies-${current.revision}`} fields={[{ name: 'users', label: 'До трёх заместителей', type: 'multi', value: current.deputies.map(p => String(p.user_id)), options: choices }]} onSubmit={async v => { const selected = ids(v, 'users'); if (selected.length > 3) throw Error('Можно назначить не более трёх заместителей'); await sessionApi.deputies(selected, { expected_revision: current.revision }); await client.invalidateQueries({ queryKey: ['leadership'] }); await clearPrivateCache(client); }} /></Card>}</div></Page>;
}
