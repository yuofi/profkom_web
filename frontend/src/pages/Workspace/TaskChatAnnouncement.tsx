import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { Task, UserRef } from "../../utils/api/contract";
import { taskChatApi, type TaskChatContext } from "../../utils/api/taskChat.api";
import { displayDate } from "../../utils/dates";
import { getBlockRoute, getEventRoute } from "../../utils/routes";
import { can } from "../../utils/session";
import { userMessage } from "../../utils/api/messages";
import { Glyph } from "../../components/Workspace/WorkspaceUI";
import s from "./TaskChat.module.css";
import w from "../../components/Workspace/Workspace.module.css";

const reasons: Record<string, string> = {
  unsupported_scope: "Для этой очереди рассылка в чат недоступна.",
  private_queue: "Задачи из закрытой очереди нельзя отправлять в общий чат.",
  forbidden: "У вас нет права отправлять сообщения в чат этой команды.",
  no_chat: "К этой команде ещё не привязан чат.",
  bot_offline: "Бот временно не в сети. Попробуйте позднее или создайте задачу без рассылки.",
  bot_unavailable: "Связь с ботом выключена. Задачу можно создать без рассылки.",
  missing_vk: "Не у всех исполнителей привязан VK. Выберите других исполнителей или создайте задачу без рассылки.",
  not_in_chat: "Бот или выбранный участник отсутствует в чате. Проверьте состав беседы.",
  recipient_missing: "Не все исполнители присутствуют в чате. Добавьте их в беседу перед повтором.",
  binding_changed: "Чат команды изменился. Сообщение в прежний чат больше не отправляется.",
  expired: "Срок отправки этого сообщения истёк.",
  chat_too_large: "В чате слишком много участников для одной рассылки.",
  chat_unavailable: "Боту недоступен чат. Проверьте его права в настройках.",
};
export function TaskChatToggle({ context, loading, error, retry, enabled, onChange, title, teamTitle, assignees, disabled = false }: {
  context?: TaskChatContext; loading: boolean; error: boolean; retry: () => void; enabled: boolean; onChange: (enabled: boolean) => void;
  title: string; teamTitle: string; assignees: UserRef[]; disabled?: boolean;
}) {
  const ready = !!context?.available && !!context.binding && !loading && !error;
  const selected = context?.recipient_mode === "assignees";
  const names = assignees.map(person => person.display_name).join(", ");
  const recipients = selected ? `Упомянем: ${names || "выбранных исполнителей"}.` : "Упомянем всех участников чата.";
  const settingsRoute = context?.can_manage && context.scope && (context.scope.kind === "block" ? getBlockRoute(context.scope.id) : context.scope.kind === "event" ? getEventRoute(context.scope.id) : null);
  const reason = context?.missing_vk_user_ids.length ? reasons.missing_vk : context?.reason ? reasons[context.reason] ?? "Рассылка для этой задачи сейчас недоступна." : "К этой команде ещё не привязан чат.";
  return <section className={s.card} aria-label="Рассылка в чат VK">
    <label className={s.toggle}><span>Уведомить чат VK</span><input className={s.switch} type="checkbox" role="switch" checked={enabled} disabled={disabled || !enabled && !ready} onChange={event => onChange(event.target.checked)} /></label>
    {loading ? <p className={s.note} role="status">Проверяем чат…</p> : error ? <><p className={s.note}>Не удалось проверить чат. Задачу можно создать без рассылки.</p><button className={s.link} type="button" onClick={retry}>Проверить чат</button></> : <>
      <p className={s.chat}>{context?.binding?.title || "Чат не подключён"}</p>
      {!ready ? <><p className={s.note}>{reason}</p>{settingsRoute && <Link className={s.link} to={`${settingsRoute}?chat=settings`}>Настроить чат</Link>}</> : enabled ? <>
        <p>{recipients}</p><p className={s.note}>Сообщение появится в общем чате после создания задачи.</p>
        {!context.bot_online && <p role="status" className={s.note}>Бот временно не в сети. Сообщение подождёт его возвращения.</p>}
        <details className={s.preview}><summary>Предпросмотр сообщения</summary><div className={s.message}>
          <span>Новая задача · {teamTitle}</span><strong>{title.trim() || "Название задачи"}</strong><span>{selected ? names || "Выбранные исполнители" : "Все участники чата"}</span><span className={s.link}>Открыть задачу →</span>
        </div><p className={s.note}>Описание и вложения останутся на сайте.</p></details>
      </> : <p className={s.note}>Создадим задачу без сообщения в чате.</p>}
    </>}
  </section>;
}

const deliveryLabels = { pending: "Сообщение в очереди", sending: "Отправляем сообщение", sent: "Сообщение отправлено", failed: "Не удалось отправить сообщение", partial: "Сообщение отправлено не полностью", cancelled: "Рассылка отменена" };
export function TaskChatDelivery({ task }: { task: Task }) {
  const client = useQueryClient(), [pending, setPending] = useState(false), [error, setError] = useState("");
  const announcement = task.chat_announcement;
  if (!announcement) return null;
  return <section className={s.status} aria-label="Статус рассылки в VK">
    <p className={s.statusHeading}><Glyph name="send" />{deliveryLabels[announcement.state]}</p>
    <p className={s.note}>{announcement.state === "sent" ? `Отправлено ${displayDate(announcement.sent_at)}` : ["pending", "sending"].includes(announcement.state) ? "Задача уже создана. Бот отправит сообщение отдельно." : announcement.state === "cancelled" ? "Задача сохранена. Новое сообщение в чат не отправляется." : "Задача сохранена. Повторное создание не требуется."}</p>
    {announcement.error_code && <p className={s.note}>{reasons[announcement.error_code] ?? "Проверьте доступ бота к чату и связи VK у исполнителей."}</p>}
    {can(announcement, "retry_chat_announcement") && <button type="button" className={w.button} disabled={pending} onClick={async () => {
      setPending(true);setError("");
      try {
        const saved = await taskChatApi.retry(task.task_id, { expected_revision: announcement.revision });
        client.setQueryData<Task>(["tasks", task.task_id], current => current ? { ...current, chat_announcement: saved } : current);
        void client.invalidateQueries({ queryKey: ["tasks", task.task_id] });
      } catch (failure) { setError(userMessage(failure));void client.invalidateQueries({ queryKey: ["tasks", task.task_id] }); }
      finally { setPending(false); }
    }}>{pending ? "Повторяем…" : "Повторить отправку"}</button>}
    {error && <p role="alert" className={w.error}>{error}</p>}
  </section>;
}
