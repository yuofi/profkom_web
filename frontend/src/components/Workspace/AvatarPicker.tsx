import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { directoryApi } from '../../utils/api/directory.api';
import { filesApi } from '../../utils/api/files.api';
import { normalizeApiError } from '../../utils/api/request';
import { useWorkspaceActions } from '../../utils/hooks/useWorkspace';
import { QueryState } from './WorkspaceUI';
import { Image } from '../Image/Image';
import s from './Workspace.module.css';
export function AvatarPicker() {
  const query = useQuery({ queryKey: ['avatars'], queryFn: directoryApi.avatars }); const { perform } = useWorkspaceActions(); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [error, setError] = useState(''); const [success, setSuccess] = useState(false);
  const save = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); setSuccess(false); try { await perform(action); setSuccess(true); } catch (e) { setError(normalizeApiError(e).message); } finally { setBusy(false); } };
  return <div className={s.form}><QueryState loading={query.isLoading} error={query.error}><div className={s.row}>{query.data?.items.map(p => <button className={s.button} key={p.preset_id} type="button" disabled={busy} onClick={() => { void save(() => directoryApi.avatar({ preset_id: p.preset_id })); }}><img src={p.image_url} alt="" width={64} height={64} /><span>{p.title}</span></button>)}</div></QueryState><label className={s.field}>Своё фото: PNG, JPEG или WebP до 5 МБ<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void save(async () => { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw Error('Выберите PNG, JPEG или WebP до 5 МБ'); const uploaded = await filesApi.upload(file, { owner_kind: 'avatar', purpose: 'avatar' }, setProgress); await directoryApi.avatar({ file_id: uploaded.file_id }); }); }} /></label>{busy && <p role="status">Сохраняем аватар · загрузка {progress}%</p>}{success && <p role="status" className={s.success}>Аватар сохранён</p>}{error && <p role="alert" className={s.error}>{error}</p>}<details><summary>Аватар по умолчанию</summary><Image src="/avatars/default.svg" alt="Аватар по умолчанию" width={96} height={96} /></details></div>;
}
