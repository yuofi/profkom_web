import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supportApi } from "../../utils/api/support.api";
import { membershipApi } from "../../utils/api/membership.api";
import { canRetainData } from "../../utils/api/request";
import { getTaskQueueRoute, getTaskRoute } from "../../utils/routes";
import { usePeopleOptions, useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { ids, text } from "../../components/Workspace/formValues";
import { Page, Card, QueryState, Empty } from "../../components/Workspace/WorkspaceUI";
import { MarkdownContent } from "../../components/Workspace/MarkdownContent";
import s from "../../components/Workspace/Workspace.module.css";

export function SupportPage() {
  const context = useQuery({ queryKey: ["supportContext"], queryFn: supportApi.context });
  const current = !context.error || canRetainData(context.error) ? context.data : undefined;
  const blocks = useQuery({ queryKey: ["workspaceBlocks"], queryFn: membershipApi.blocks, enabled: !!current?.can_configure });
  const people = usePeopleOptions({ includeNonMembers: true, enabled: !!current?.can_manage_staff }), { perform, refresh } = useWorkspaceActions();
  const reports = useQuery({ queryKey: ["supportReports"], queryFn: supportApi.reports, enabled: !!current?.can_triage, refetchInterval: 30000 });
  const visibleReports = !reports.error || canRetainData(reports.error) ? reports.data : undefined;
  const mine = useQuery({ queryKey: ["feedbackMine"], queryFn: supportApi.mine, refetchInterval: 30000 });
  const ownReports = !mine.error || canRetainData(mine.error) ? mine.data : undefined;
  return <Page title="Поддержка сайта" description="Очередь WEBSUPPORT и обращения пользователей.">
    <QueryState loading={context.isLoading} error={context.error}>
      {current && <div className={s.stack}>
        {current.can_triage && current.queue_id && <Link to={getTaskQueueRoute(current.queue_id)}>Открыть очередь WEBSUPPORT</Link>}
        {!current.configured && <Empty>Очередь ещё не подключена. Отправленные обращения сохранены и ожидают настройки.</Empty>}
        {current.can_configure && <Card title="Блок поддержки"><QueryState loading={blocks.isLoading} error={blocks.error}><ActionForm fields={[{ name: "block", label: "IT-блок", type: "select", entity: "block", required: true, value: current.block_id ?? "", options: (blocks.data ?? []).map(block => ({ value: block.block_id, label: block.name, block })) }]}
          revision={current.revision} record="support:settings" onConflict={refresh} submitLabel="Сохранить блок поддержки" onSubmit={async (values, revision) => perform(() => supportApi.configure(text(values, "block"), revision!))} /></QueryState></Card>}
        {current.configured && current.can_manage_staff && <Card title="Сотрудники поддержки"><p>Мастер и заместитель IT получают доступ по должности. Дополнительных сотрудников назначают явно.</p><ActionForm fields={[{ name: "staff", label: "Дополнительные сотрудники", type: "multi", entity: "person", value: current.staff_user_ids.map(String), options: people.options }]}
          revision={current.revision} record="support:settings" onConflict={refresh} submitLabel="Сохранить сотрудников" onSubmit={async (values, revision) => perform(() => supportApi.staff(ids(values, "staff"), revision!))} /></Card>}
        {current.can_triage ? <section><h2>Обращения</h2><QueryState loading={reports.isLoading} error={reports.error} keepDataOnError={!!visibleReports}>
          {!visibleReports?.items.length && !reports.isLoading && <Empty>Обращений пока нет.</Empty>}
          <div className={s.stack}>{visibleReports?.items.map(report => <Card key={report.report_id} title={report.title}><p className={s.muted}>{report.kind === "bug" ? "Ошибка" : "Предложение"} · {report.task_key ?? "Ожидает создания тикета"}</p><MarkdownContent body={report.body} />{report.contact && <p>Контакт для ответа: {report.contact}</p>}{report.task_id && <Link to={getTaskRoute(report.task_id)}>Открыть тикет</Link>}</Card>)}</div>
        </QueryState></section> : null}
        <section><h2>Мои обращения</h2><QueryState loading={mine.isLoading} error={mine.error} keepDataOnError={!!ownReports}>
          {!ownReports?.items.length && !mine.isLoading && <Empty>Отправьте обращение кнопкой с жучком на любой странице.</Empty>}
          <div className={s.stack}>{ownReports?.items.map(report => <Card key={report.report_id} title={report.title}>
            {report.task_id ? <Link to={getTaskRoute(report.task_id)}>Открыть {report.task_key}</Link> : report.state === "withdrawn" ? <p>Обращение отозвано.</p> : <>
              <p className={s.muted}>Обращение сохранено и ожидает подключения очереди.</p>
              <ActionForm fields={[{ name: "title", label: "Заголовок обращения", required: true, value: report.title }, { name: "body", label: "Описание обращения", type: "textarea", required: true, value: report.body }]} revision={report.revision} record={`feedback:${report.report_id}`} onConflict={refresh} submitLabel="Дополнить обращение" onSubmit={async (values, revision) => perform(() => supportApi.pending(report.report_id, { expected_revision: revision!, title: text(values, "title"), body: text(values, "body") }))} />
              <ActionForm fields={[]} revision={report.revision} record={`feedback:${report.report_id}`} onConflict={refresh} submitLabel="Отозвать обращение" onSubmit={async (_values, revision) => perform(() => supportApi.pending(report.report_id, { expected_revision: revision!, withdraw: true }))} />
            </>}
          </Card>)}</div>
        </QueryState></section>
      </div>}
    </QueryState>
  </Page>;
}
