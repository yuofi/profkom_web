import { isDemoMode } from '../../utils/demoData';
import s from './WorkspaceLayout.module.css';
const roles = [['organizer', 'Организатор'], ['leader', 'Руководитель'], ['hr', 'Мастер HR'], ['hr-deputy', 'Зам мастера HR'], ['chair', 'Председатель'], ['chair-deputy', 'Зам председателя'], ['editor', 'Редактор'], ['pending', 'Ожидание одобрения'], ['rejected', 'Отказ регистрации'], ['archived', 'Архивный аккаунт'], ['multi', 'Несколько ролей']];
export function DemoRolePicker() {
  if (!import.meta.env.DEV || !isDemoMode) return null;
  return <div className={s.demo}>Демонстрационный режим<label>Роль<select aria-label="Демонстрационная роль" value={sessionStorage.getItem('profkom-demo-role') ?? import.meta.env.VITE_DEMO_ROLE ?? 'organizer'} onChange={e => { sessionStorage.setItem('profkom-demo-role', e.target.value); window.location.assign('/'); }}>{roles.map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select></label></div>;
}
