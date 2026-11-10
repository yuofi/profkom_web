import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { BlockAvatarPicker } from "../../components/Workspace/BlockAvatarPicker";
import { text } from "../../components/Workspace/formValues";
import { UserChip } from "../../components/Workspace/UserChip";
import { UnsavedChangesScope } from "../../components/Workspace/UnsavedChanges";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import { richText, type Block } from "../../utils/api/contract";
import { blockLifecycleApi } from "../../utils/api/blockLifecycle.api";
import { membershipApi } from "../../utils/api/membership.api";
import { displayDate } from "../../utils/dates";
import { getBlockRoute } from "../../utils/routes";
import { can } from "../../utils/session";
import { useDeadlineRefresh } from "../../utils/hooks/useDeadlineRefresh";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { TrackerTaskDialog } from "./TrackerTaskDialog";
import s from "./BlockSettings.module.css";
import w from "../../components/Workspace/Workspace.module.css";

function useBlockCommands(blockId: string) {
  const client = useQueryClient(), { perform, refresh } = useWorkspaceActions();
  return { refresh, run: (command: () => Promise<Block>) => perform(async () => { const saved = await command();client.setQueryData(["workspaceBlocks", blockId], saved);return saved; }) };
}

export function CreateBlockAction() {
  const [open, setOpen] = useState(false), navigate = useNavigate(), client = useQueryClient();
  const { perform } = useWorkspaceActions();
  return <>
    <button type="button" className={w.button} onClick={() => setOpen(true)}><Glyph name="add" />Создать блок</button>
    {open && <UnsavedChangesScope><TrackerTaskDialog title="Новый блок" onClose={() => setOpen(false)}><ActionForm submitLabel="Создать блок" fields={[
      { name: "name", label: "Название блока", required: true },
      { name: "description", label: "Описание", type: "textarea" },
      { name: "community_url", label: "Сообщество VK", type: "url" },
    ]} onSubmit={async values => {
      const name = text(values, "name").trim();if (!name) throw Error("Введите название блока");
      const saved = await perform(async () => { const block = await blockLifecycleApi.create({ name, description: richText(text(values, "description")), community_url: text(values, "community_url").trim() || null });client.setQueryData(["workspaceBlocks", block.block_id], block);return block; });
      setOpen(false);navigate(getBlockRoute(saved.block_id));return saved;
    }} /></TrackerTaskDialog></UnsavedChangesScope>}
  </>;
}

export function BlockSettingsAction({ block }: { block: Block }) {
  const [open, setOpen] = useState(false), { run, refresh } = useBlockCommands(block.block_id);
  const deletionActive = ["pending", "scheduled"].includes(block.deletion_request?.state ?? "");
  return <>
    <button type="button" className={w.button} onClick={() => setOpen(true)}><Glyph name="edit" />Настройки блока</button>
    {open && <UnsavedChangesScope><TrackerTaskDialog title="Настройки блока" onClose={() => setOpen(false)}><div className={s.stack}>
      <section className={s.section}><h3>Название</h3>{can(block, "rename_block") ? <ActionForm revision={block.revision} record={`block:${block.block_id}`} onConflict={refresh} submitLabel="Сохранить название" changeRequired={["name"]} fields={[{ name: "name", label: "Название блока", value: block.name, required: true }]} onSubmit={async (values, revision) => {
        const name = text(values, "name").trim();if (!name) throw Error("Введите название блока");
        return run(() => membershipApi.updateBlock(block.block_id, { expected_revision: revision!, name }));
      }} /> : <p>{block.name}</p>}</section>
      <section className={s.section}><h3>Аватар</h3><div className={s.avatar}><BlockAvatarPicker block={block} /><p className={s.note}>{can(block, "edit_block") ? "Нажмите на карандаш, чтобы загрузить или заменить аватар блока." : "Изменить аватар может мастер блока или руководство Профкома."}</p></div></section>
      {can(block, "start_block_deletion") && !deletionActive && <section className={s.section}><h3>Удаление блока</h3><p className={s.note}>Нужны подтверждения двух разных действующих руководителей: председателя или его заместителей. После второго подтверждения начнётся ожидание 72 часа; до его окончания удаление можно отменить.</p>
        <ActionForm fields={[]} revision={block.revision} record={`block:${block.block_id}`} onConflict={refresh} variant="danger" submitLabel="Запросить удаление блока" confirm={{ label: "Подтвердить запрос", text: "Ваш запрос станет первым подтверждением. Блок продолжит работать до второго подтверждения и завершения 72 часов ожидания. Старые задачи и ККР сохранятся." }} onSubmit={async (_, revision) => { const saved = await run(() => blockLifecycleApi.startDeletion(block.block_id, { expected_revision: revision! }));setOpen(false);return saved; }} />
      </section>}
      {deletionActive && <p className={s.note}>Запрос на удаление уже открыт. Подтверждения и срок ожидания показаны на странице блока.</p>}
    </div></TrackerTaskDialog></UnsavedChangesScope>}
  </>;
}

export function BlockDeletionStatus({ block }: { block: Block }) {
  const { run, refresh } = useBlockCommands(block.block_id), [now, setNow] = useState(Date.now);
  const request = block.deletion_request, scheduled = request?.state === "scheduled";
  // Only this detail entry polls, and only while a request is active. React Query
  // suspends the interval in hidden tabs; the server remains the clock authority.
  useQuery({ queryKey: ["workspaceBlocks", block.block_id], queryFn: () => membershipApi.block(block.block_id, { include_deputies: true }), initialData: block, enabled: !!request && ["pending", "scheduled"].includes(request.state), refetchOnMount: false, refetchInterval: query => ["pending", "scheduled"].includes(query.state.data?.deletion_request?.state ?? "") ? 30_000 : false, refetchIntervalInBackground: false });
  useEffect(() => { if (!scheduled) return;const timer = window.setInterval(() => setNow(Date.now()), 60000);return () => window.clearInterval(timer); }, [scheduled]);
  useDeadlineRefresh(scheduled && request.delete_after ? [request.delete_after] : [], refresh);
  if (block.archived_at) return <section className={`${s.notice} ${s.history}`} aria-label="Удалённый блок"><h2>Блок удалён</h2><p>Удалён {displayDate(block.archived_at)}. Прежние задачи, гайды и ККР сохранены; новые задачи в очередях блока не создаются.</p></section>;
  if (!request || !["pending", "scheduled"].includes(request.state)) return null;
  const minutes = request.delete_after ? Math.max(0, Math.ceil((Date.parse(request.delete_after) - now) / 60000)) : 0;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), remainder = minutes % 60;
  return <section className={s.notice} aria-label="Удаление блока">
    <h2>{scheduled ? "Удаление блока запланировано" : "Запрошено удаление блока"}</h2>
    <p>{scheduled ? "Оба подтверждения получены. До окончания срока блок продолжает работать; любой действующий председатель или заместитель может отменить удаление." : "Получено 1 из 2 подтверждений. Нужно решение другого действующего председателя или заместителя. Таймер ещё не запущен."}</p>
    <ul className={s.votes} aria-label="Подтверждения удаления">{request.approvals.map(approval => <li key={`${approval.actor.user_id}:${approval.at}`} className={s.vote}><UserChip user={approval.actor} /><time dateTime={approval.at}>{displayDate(approval.at)}</time></li>)}</ul>
    {scheduled && request.delete_after && <><p>Удаление: <strong>{displayDate(request.delete_after)}, МСК</strong></p><p className={s.countdown} role="timer">{minutes ? `Осталось: ${days ? `${days} д. ` : ""}${hours} ч. ${remainder} мин.` : "Срок ожидания истёк. Обновляем состояние блока."}</p></>}
    <p className={s.note}>После удаления блок исчезнет из общего списка, а его очереди перестанут принимать новые задачи. Текущие должности и участие в блоке завершатся. Прежние задачи, гайды и ККР сохранятся вместе с доступом к ним. Руководство получит уведомления сейчас и каждый день ожидания.</p>
    <div className={s.actions}>
      {can(request, "approve_block_deletion") && <ActionForm fields={[]} revision={block.revision} record={`block:${block.block_id}`} onConflict={refresh} variant="danger" submitLabel="Подтвердить удаление" confirm={{ label: "Подтвердить и запустить 72 часа", text: "Это второе подтверждение. После него начнётся 72-часовой срок, в течение которого удаление можно отменить. По завершении срока блок будет удалён, а прежняя история сохранится." }} onSubmit={(_, revision) => run(() => blockLifecycleApi.approveDeletion(block.block_id, { expected_revision: revision!, request_id: request.request_id }))} />}
      {can(request, "cancel_block_deletion") && <ActionForm fields={[]} revision={block.revision} record={`block:${block.block_id}`} onConflict={refresh} submitLabel="Отменить удаление" onSubmit={(_, revision) => run(() => blockLifecycleApi.cancelDeletion(block.block_id, { expected_revision: revision!, request_id: request.request_id }))} />}
    </div>
  </section>;
}
