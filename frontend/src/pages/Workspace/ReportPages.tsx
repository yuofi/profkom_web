import { canRetainData } from "../../utils/api/request";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  Markdown,
  RouteLink,
  Badge,
  Empty,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import {
  AttachmentPicker,
  Attachments,
} from "../../components/Workspace/Attachments";
import { reportsApi } from "../../utils/api/reports.api";
import { eventsApi } from "../../utils/api/events.api";
import { seasonsApi } from "../../utils/api/seasons.api";
import { richText, type FileRef, type Report } from "../../utils/api/contract";
import { can } from "../../utils/session";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import { getReportRoute } from "../../utils/routes";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import s from "../../components/Workspace/Workspace.module.css";
const template =
  "## Что сделали\n\n\n## Проблемы\n\n\n## Дальнейшие планы\n\n\n## Необходимая помощь\n\n";
/** `seasons` labels each report with its instance's season, as the history needs (A-EVT-5). */
function ReportLinks({ reports, seasons }: { reports: Report[]; seasons?: Map<string, string> }) {
  return (
    <ul className={s.list}>
      {reports.map((r) => (
        <li key={r.report_id}>
          <RouteLink to={getReportRoute(r.report_id)}>{r.title}</RouteLink>{" "}
          <Badge tone={r.kind === "final" ? "mint" : undefined}>{r.kind === "final" ? "Финальный" : "Регулярный"}</Badge>{" "}
          {seasons && <Badge>Сезон: {seasons.get(r.season_id) ?? "недоступен"}</Badge>}{" "}
          <span className={s.muted}>
            {r.state === "published"
              ? `${seasons ? "Последняя версия" : "Публикация"} ${displayDate(r.published_at)}`
              : "Черновик"}
          </span>
        </li>
      ))}
    </ul>
  );
}
export function ReportsPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { perform } = useWorkspaceActions();
  const kind = params.get("owner_kind");
  const ownerId = params.get("owner_id") ?? "";
  const valid = kind === "event" || kind === "subevent";
  const owner = useQuery({
    queryKey: ["events", "report-owner", kind, ownerId],
    queryFn: async () =>
      kind === "event"
        ? await eventsApi.get(ownerId)
        : await eventsApi.subevent(ownerId),
    enabled: valid && !!ownerId,
  });
  const query = useQuery({
    queryKey: ["reports", "list", kind, ownerId],
    queryFn: () =>
      reportsApi.list(
        valid && ownerId ? { owner_kind: kind, owner_id: ownerId } : {},
      ),
  });
  return (
    <Page
      title="Отчёты"
      actions={<RouteLink to="/reports/history">Поиск по истории</RouteLink>}
    >
      <div className={s.stack}>
        <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
          <Card>
            <ReportLinks reports={query.data?.items ?? []} />
            {query.data?.items.length === 0 && <Empty>Отчётов пока нет.</Empty>}
          </Card>
        </QueryState>
        {can(owner.data, "create_report") && valid && (
          <Card title="Новый отчёт">
            <ActionForm
              fields={[
                { name: "title", label: "Название", required: true },
                {
                  name: "kind",
                  label: "Тип отчёта",
                  type: "select",
                  required: true,
                  value: "regular",
                  options: [
                    { value: "regular", label: "Регулярный" },
                    { value: "final", label: "Финальный" },
                  ],
                },
                {
                  name: "body",
                  label: "Текст в Markdown",
                  type: "textarea",
                  value: template,
                  required: true,
                },
              ]}
              onSubmit={async (v) => {
                await perform(async () => {
                  const r = await reportsApi.create({
                    owner_kind: kind,
                    owner_id: ownerId,
                    title: text(v, "title"),
                    kind: text(v, "kind") as "regular" | "final",
                    content: richText(text(v, "body")),
                    file_ids: [],
                  });
                  navigate(getReportRoute(r.report_id));
                });
              }}
              submitLabel="Создать черновик"
            />
          </Card>
        )}
      </div>
    </Page>
  );
}
function ReportEditor({ report }: { report: Report }) {
  const { perform, refresh } = useWorkspaceActions();
  const [files, setFiles] = useState<FileRef[]>(
    report.draft_files ?? report.files,
  );
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const draft = report.draft_content ?? report.content;
  return (
    <Card title="Следующая редакция">
      <p>
        Опубликованная версия остаётся доступной читателям до новой публикации.
        Сохранённый черновик доступен соавторам.
      </p>
      <AttachmentPicker
        owner_kind="report"
        owner_id={report.report_id}
        purpose="report"
        files={files}
        onChange={setFiles}
        onBusyChange={setBusy}
      />
      <ActionForm
        disabled={busy}
        revision={report.revision}
        record={`report:${report.report_id}`}
        savedDetails={<Attachments files={report.draft_files ?? report.files} />}
        onReplaceWithSaved={() => setFiles(report.draft_files ?? report.files)}
        fields={[
          {
            name: "title",
            label: "Название",
            required: true,
            value: report.draft_title ?? report.title,
          },
          {
            name: "body",
            label: "Текст в Markdown",
            type: "textarea",
            required: true,
            value: draft.body,
          },
        ]}
        onSubmit={async (v, expectedRevision) => {
          return perform(() =>
            reportsApi.update(report.report_id, {
              expected_revision: expectedRevision!,
              title: text(v, "title"),
              content: richText(text(v, "body")),
              file_ids: files.map((f) => f.file_id),
            }),
          );
        }}
        onConflict={refresh}
        submitLabel="Сохранить черновик"
      />
      <button
        type="button"
        className={s.button}
        onClick={() => setPreview(!preview)}
      >
        Предпросмотр сохранённого черновика
      </button>
      {preview && <Markdown content={draft} />}
      {can(report, "publish_report") && (
        <ActionForm
          revision={report.revision}
          record={`report:${report.report_id}`}
          savedDetails={<><Markdown content={draft} /><Attachments files={report.draft_files ?? report.files} /></>}
          fields={[]}
          submitLabel="Опубликовать сохранённый отчёт"
          onSubmit={async (_v, expectedRevision) => {
            return perform(() =>
              reportsApi.publish(report.report_id, {
                expected_revision: expectedRevision!,
              }),
            );
          }}
          onConflict={refresh}
        />
      )}
    </Card>
  );
}
export function ReportPage() {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: ["reports", id],
    queryFn: () => reportsApi.get(id),
  });
  const report = query.data;
  const versions = useQuery({
    queryKey: ["reports", id, "versions"],
    queryFn: () => reportsApi.versions(id),
    enabled: can(report, "view_report_versions"),
  });
  // The history link is offered only for a series whose history the server opens (A-EVT-6).
  const series = useQuery({ queryKey: ["reports", "series"], queryFn: eventsApi.series, enabled: !!report });
  const historyReadable = !!report && !!series.data?.items.some((x) => x.series_id === report.report_series_id);
  return (
    <Page
      title={report?.title ?? "Отчёт"}
      actions={<RouteLink to="/reports">Все отчёты</RouteLink>}
    >
      <QueryState
        keepDataOnError={!!query.data}
        loading={query.isLoading}
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      >
        {report && (
          <div className={s.stack}>
            <Card>
              <Badge tone={report.kind === "final" ? "mint" : undefined}>
                {report.kind === "final"
                  ? "Финальный отчёт"
                  : "Регулярный отчёт"}
              </Badge>
              <p>
                {report.state === "published"
                  ? `Версия ${report.published_version} · ${displayDate(report.published_at)}`
                  : "Отчёт ещё не опубликован"}
              </p>
              {report.state === "published" && (
                <>
                  <Markdown content={report.content} />
                  <Attachments files={report.files} />
                </>
              )}
              {historyReadable && (
                <RouteLink
                  to={`/reports/history?series_id=${encodeURIComponent(report.report_series_id)}`}
                >
                  Все годы этой серии
                </RouteLink>
              )}
            </Card>
            {can(report, "edit_report") && (
              <ReportEditor key={id} report={report} />
            )}
            {can(report, "view_report_versions") && (
              <Card title="Опубликованные версии">
                <QueryState loading={versions.isLoading} error={versions.error}>
                  {versions.data?.items.map((v) => (
                    <details key={v.version} className={s.details}>
                      <summary>
                        Версия {v.version} · {displayDate(v.published_at)} ·{" "}
                        {v.published_by.display_name}
                      </summary>
                      <h3>{v.title}</h3>
                      <Markdown content={v.content} />
                      <Attachments files={v.files} />
                    </details>
                  ))}
                  {versions.data?.items.length === 0 && (
                    <Empty>Публикаций ещё нет.</Empty>
                  )}
                </QueryState>
              </Card>
            )}
          </div>
        )}
      </QueryState>
    </Page>
  );
}
export function ReportHistoryPage() {
  const [params, setParams] = useSearchParams();
  const series = useQuery({
    queryKey: ["reports", "series"],
    queryFn: eventsApi.series,
  });
  const seriesId = params.get("series_id") ?? "";
  const year = params.get("year") ?? "";
  const query = useQuery({
    queryKey: ["reports", "history", seriesId, year],
    queryFn: () =>
      reportsApi.history(seriesId, year ? Number(year) : undefined),
    enabled: !!seriesId,
  });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const seasonTitles = new Map(seasons.data?.items.map((x) => [x.season_id, x.title]));
  return (
    <Page
      title="История отчётов"
      description="Доступные опубликованные отчёты за все сохранённые годы. Права редактирования определяет каждый отчёт."
    >
      <Card>
        <ActionForm
          key={seriesId}
          fields={[
            {
              name: "series",
              label: "Серия мероприятия",
              type: "select",
              required: true,
              value: seriesId,
              options: series.data?.items.map((x) => ({
                value: x.series_id,
                label: x.title,
              })),
            },
            {
              name: "year",
              label: "Год, необязательно",
              type: "number",
              min: 2000,
              max: 2200,
              value: year,
            },
          ]}
          onSubmit={async (v) => {
            setParams({
              series_id: text(v, "series"),
              ...(text(v, "year") ? { year: text(v, "year") } : {}),
            });
          }}
          submitLabel="Показать отчёты"
        />
        <QueryState loading={query.isFetching} error={query.error}>
          {seriesId && <ReportLinks reports={query.data?.items ?? []} seasons={seasonTitles} />}
          {seriesId && query.data?.items.length === 0 && (
            <Empty>Нет доступных отчётов за этот период.</Empty>
          )}
        </QueryState>
      </Card>
    </Page>
  );
}
export function MeetingPage() {
  const { kind = "", id = "" } = useParams();
  const valid = kind === "event" || kind === "subevent";
  const apiKind = kind === "event" ? "events" : "subevents";
  const { perform, refresh } = useWorkspaceActions();
  // A removed announcement starts a new one from revision 0 with empty fields.
  const [removed, setRemoved] = useState(0);
  const owner = useQuery({
    queryKey: ["events", "meeting-owner", kind, id],
    queryFn: async () =>
      kind === "event" ? await eventsApi.get(id) : await eventsApi.subevent(id),
    enabled: valid,
  });
  const query = useQuery({
    queryKey: ["events", "meeting", kind, id],
    queryFn: () => eventsApi.meeting(apiKind, id),
    enabled: valid,
  });
  const meeting = query.data;
  if (!valid)
    return (
      <Page title="Созвон">
        <Empty>Неверный адрес созвона.</Empty>
      </Page>
    );
  return (
    <Page
      title={kind === "event" ? "Созвон руководителей" : "Созвон команды"}
      description={
        kind === "event"
          ? "Объявление для главоргов, ответственных и их заместителей."
          : "Объявление для участников подмероприятия."
      }
    >
      <div className={s.stack}>
        <QueryState
          keepDataOnError={!!query.data}
          loading={query.isLoading}
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        >
          <Card>
            {meeting ? (
              <>
                <h2>{meeting.title}</h2>
                <p>{displayDate(meeting.starts_at)}</p>
                <a
                  className={s.linkButton}
                  href={meeting.join_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Подключиться
                </a>
              </>
            ) : (
              <Empty>Созвон пока не назначен.</Empty>
            )}
          </Card>
        </QueryState>
        {(!query.error || (query.data && canRetainData(query.error))) &&
          (can(meeting, "edit_meeting") ||
            (!meeting && can(owner.data, "edit_meeting"))) && (
            <Card title="Объявление созвона">
              <ActionForm
                key={`${apiKind}/${id}/${removed}`}
                revision={meeting?.revision ?? 0}
                fields={[
                  {
                    name: "title",
                    label: "Название",
                    required: true,
                    value: meeting?.title ?? "",
                  },
                  {
                    name: "starts",
                    label: "Начало, МСК",
                    type: "datetime-local",
                    required: true,
                    value: meeting ? moscowInput(meeting.starts_at) : "",
                  },
                  {
                    name: "url",
                    label: "Ссылка на подключение",
                    type: "url",
                    required: true,
                    value: meeting?.join_url ?? "",
                  },
                ]}
                onSubmit={async (v, expectedRevision) => {
                  return perform(() =>
                    eventsApi.saveMeeting(apiKind, id, {
                      title: text(v, "title"),
                      starts_at: toUtc(text(v, "starts")),
                      join_url: text(v, "url"),
                      ...(meeting
                        ? { expected_revision: expectedRevision! }
                        : {}),
                    }),
                  );
                }}
                onConflict={refresh}
              />
              {meeting && can(meeting, "delete_meeting") && (
                <ActionForm
                  fields={[]}
                  submitLabel="Снять объявление"
                  onSubmit={async () => {
                    await perform(() => eventsApi.deleteMeeting(apiKind, id));
                    setRemoved((n) => n + 1);
                  }}
                />
              )}
            </Card>
          )}
      </div>
    </Page>
  );
}
