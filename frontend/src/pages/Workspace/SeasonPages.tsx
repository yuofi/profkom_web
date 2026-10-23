import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
  Badge,
  Empty,
} from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { seasonsApi } from "../../utils/api/seasons.api";
import { normalizeApiError } from "../../utils/api/request";
import { can, useSession } from "../../utils/session";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import { getSeasonRoute } from "../../utils/routes";
import { SeasonBlockerLink } from "../../components/Workspace/SeasonBlockerLink";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import type {
  Decision,
  Season,
  SeasonSummary,
  SummaryRow,
} from "../../utils/api/contract";
import { SeasonCorrectionForm } from "./MeritPages";
import { SummaryTable } from "./SummaryTable";
import { decisionLabels as decisions } from "../../utils/decisions";
import { SummaryHistory } from "./SummaryHistory";
export { DecisionBadges } from "./SummaryTable";
import s from "../../components/Workspace/Workspace.module.css";
const states = {
  planned: "Запланирован",
  open: "Открыт",
  summarizing: "Подведение итогов",
  closed: "Закрыт",
};
export function SeasonsPage() {
  const { session } = useSession();
  const { perform } = useWorkspaceActions();
  const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  return (
    <Page title="Сезоны">
      <div className={s.stack}>
        <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
          <div className={s.grid}>
            {query.data?.items.map((season) => (
              <Card key={season.season_id} title={season.title}>
                <div className={s.row}>
                  <Badge>{states[season.state]}</Badge>
                  {season.is_current && <Badge>Текущий по умолчанию</Badge>}
                </div>
                <p>
                  {displayDate(season.starts_at)} —{" "}
                  {displayDate(season.ends_at)}
                </p>
                <RouteLink to={getSeasonRoute(season.season_id)}>
                  Открыть сезон
                </RouteLink>
              </Card>
            ))}
          </div>
        </QueryState>
        {can(session, "open_season") && (
          <Card title="Подготовить следующий сезон">
            <ActionForm
              fields={[
                { name: "title", label: "Название", required: true },
                {
                  name: "type",
                  label: "Тип",
                  type: "select",
                  required: true,
                  options: [
                    { value: "winter_spring", label: "Зима — весна" },
                    { value: "summer_autumn", label: "Лето — осень" },
                    { value: "autumn_winter", label: "Осень — зима" },
                  ],
                },
                {
                  name: "start",
                  label: "Начало, МСК",
                  type: "datetime-local",
                  required: true,
                },
                {
                  name: "end",
                  label: "Конец, МСК",
                  type: "datetime-local",
                  required: true,
                },
              ]}
              onSubmit={async (v) => {
                const start = toUtc(text(v, "start")),
                  end = toUtc(text(v, "end"));
                if (start >= end)
                  throw Error("Начало должно быть раньше конца");
                await perform(() =>
                  seasonsApi.create({
                    title: text(v, "title"),
                    type: text(v, "type") as Season["type"],
                    starts_at: start,
                    ends_at: end,
                  }),
                );
              }}
              submitLabel="Подготовить сезон"
            />
          </Card>
        )}
        <SeasonCorrectionForm />
      </div>
    </Page>
  );
}
function SeasonCommand({
  season,
  action,
  label,
}: {
  season: Season;
  action: "open" | "begin-summary" | "close";
  label: string;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
  return (
    <div>
      <ActionForm
        revision={season.revision}
        record={`season:${season.season_id}`}
        onConflict={refresh}
        fields={[]}
        submitLabel={label}
        onSubmit={async (_v, expectedRevision) => {
          setFailure(null);
          try {
            const saved = await perform(() =>
              seasonsApi.command(season.season_id, action, {
                expected_revision: expectedRevision!,
              }),
            );
            return "season" in saved ? saved.season : saved;
          } catch (e) {
            setFailure(normalizeApiError(e));
            throw e;
          }
        }}
      />
      {failure?.blockers.length ? (
        <ul className={s.list} aria-label="Препятствия закрытию">
          {failure.blockers.map((b, index) => (
            <li key={index}>
              <SeasonBlockerLink blocker={b} seasonId={season.season_id} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
export function SeasonPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  const season = query.data?.items.find((x) => x.season_id === id);
  return (
    <Page
      title={season?.title ?? "Сезон"}
      actions={<RouteLink to="/seasons">Все сезоны</RouteLink>}
    >
      <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
        {season ? (
          <div className={s.stack}>
            <Card>
              <Badge>{states[season.state]}</Badge>
              {season.is_current && <Badge>Текущий по умолчанию</Badge>}
              <p>
                {displayDate(season.starts_at)} — {displayDate(season.ends_at)}
              </p>
              <p>
                Другие незакрытые сезоны остаются доступны для завершения
                работы.
              </p>
              <div className={s.row}>
                <RouteLink
                  to={`/tasks?season_id=${encodeURIComponent(id)}&mine=false`}
                >
                  Задачи сезона
                </RouteLink>
                {can(session, "view_summary") && (
                  <RouteLink to={`/seasons/${encodeURIComponent(id)}/summary`}>
                    Сводная ККР
                  </RouteLink>
                )}
                {["create_volunteer_merit", "create_head_merit", "create_chair_merit", "view_summary"].some((cap) => can(session, cap)) && (
                  <RouteLink to={`/seasons/${encodeURIComponent(id)}/merits`}>
                    Особые заслуги и волонтёры
                  </RouteLink>
                )}
              </div>
            </Card>
            <Card title="Управление сезоном">
              <div className={s.stack}>
                {can(season, "open_season") && (
                  <SeasonCommand
                    season={season}
                    action="open"
                    label="Открыть и сделать текущим"
                  />
                )}
                {can(season, "begin_summary") && (
                  <SeasonCommand
                    season={season}
                    action="begin-summary"
                    label="Начать подведение итогов"
                  />
                )}
                {can(season, "close_season") && (
                  <SeasonCommand
                    season={season}
                    action="close"
                    label="Закрыть сезон"
                  />
                )}
                {season.capabilities.length === 0 && (
                  <Empty>
                    Управление доступно председателю по состоянию сезона.
                  </Empty>
                )}
              </div>
            </Card>
            {can(season, "edit_season") && (
              <Card title="Исправление периода">
                <ActionForm
                  key={season.season_id}
                  revision={season.revision}
                  record={`season:${season.season_id}`}
                  fields={[
                    {
                      name: "title",
                      label: "Название",
                      required: true,
                      value: season.title,
                    },
                    {
                      name: "start",
                      label: "Начало, МСК",
                      type: "datetime-local",
                      required: true,
                      value: moscowInput(season.starts_at),
                    },
                    {
                      name: "end",
                      label: "Конец, МСК",
                      type: "datetime-local",
                      required: true,
                      value: moscowInput(season.ends_at),
                    },
                    { name: "reason", label: "Причина", required: true },
                  ]}
                  onSubmit={async (v, expectedRevision) => {
                    if (text(v, "start") >= text(v, "end"))
                      throw Error("Начало должно быть раньше конца");
                    return perform(() =>
                      seasonsApi.update(id, {
                        expected_revision: expectedRevision!,
                        title: text(v, "title"),
                        starts_at: toUtc(text(v, "start")),
                        ends_at: toUtc(text(v, "end")),
                        reason: text(v, "reason"),
                      }),
                    );
                  }}
                  onConflict={refresh}
                />
              </Card>
            )}
          </div>
        ) : (
          !query.isLoading && <Empty>Сезон недоступен.</Empty>
        )}
      </QueryState>
    </Page>
  );
}
function DecisionsForm({
  summary,
  row,
}: {
  summary: SeasonSummary;
  row: SummaryRow;
}) {
  const { perform, refresh } = useWorkspaceActions();
  return (
    <details>
      <summary>Изменить отметки</summary>
      <p className={s.muted}>
        Отметки сохраняют решение в сводной. Архивирование аккаунта выполняется
        отдельно.
      </p>
      <ActionForm
        key={`${summary.season_id}/${row.user.user_id}`}
        revision={summary.version}
        // One version for the whole summary: own saves of other rows move it (A-FE-2).
        record={`summary:${summary.season_id}`}
        fields={[
          {
            name: "decisions",
            label: "Текущие отметки",
            type: "multi",
            confirmRemoval: false,
            value: row.decisions,
            options: Object.entries(decisions).map(([value, label]) => ({
              value,
              label,
            })),
          },
          { name: "reason", label: "Основание", required: true },
        ]}
        onSubmit={async (v, expectedRevision) => {
          return perform(() =>
            seasonsApi.decisions(summary.season_id, row.user.user_id!, {
              expected_version: expectedRevision!,
              decisions: v.decisions as Decision[],
              reason: text(v, "reason"),
            }),
          );
        }}
        onConflict={refresh}
      />
    </details>
  );
}
export function SummaryPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const allowed = can(session, "view_summary");
  const [filter, setFilter] = useState("");
  const [exportError, setExportError] = useState("");
  const query = useQuery({
    queryKey: ["summary", id],
    queryFn: () => seasonsApi.summary(id),
    enabled: allowed,
  });
  const bonuses = useQuery({
    queryKey: ["masterBonuses", id],
    queryFn: () => seasonsApi.bonuses(id),
    enabled: allowed,
  });
  const summary = query.data;
  if (!allowed)
    return (
      <Page title="ККР">
        <Empty>Нет доступа к расчётной сводной.</Empty>
      </Page>
    );
  return (
    <Page
      title="Сводная ККР"
      description="Значения, места и состав источников возвращает сервер."
      actions={<RouteLink to={getSeasonRoute(id)}>Сезон</RouteLink>}
    >
      <div className={s.stack}>
        <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
          {summary && (
            <>
              <Card>
                <div className={s.between}>
                  <p>
                    Версия {summary.version} ·{" "}
                    {summary.state === "approved"
                      ? `Утверждена ${displayDate(summary.approved_at)}`
                      : "Предварительная"}
                  </p>
                  <button
                    className={s.button}
                    onClick={async () => {
                      setExportError("");
                      try {
                        const blob = await seasonsApi.export(id);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `kkr-${id}.xlsx`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      } catch (e) {
                        setExportError(normalizeApiError(e).message);
                      }
                    }}
                  >
                    Скачать XLSX
                  </button>
                </div>
                {exportError && (
                  <p role="alert" className={s.error}>
                    {exportError}
                  </p>
                )}
                <label className={s.field}>
                  Поиск по имени или группе
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
                <SummaryTable summary={summary} filter={filter} renderDecisions={(row) =>
                  can(summary, "edit_decisions") && row.user.user_id
                    ? <DecisionsForm row={row} summary={summary} /> : null
                } />
              </Card>
              <RouteLink to={`/seasons/${encodeURIComponent(id)}/sources`}>
                Подробные начисления и исходные поля
              </RouteLink>
              {can(summary, "correct_summary") && (
                <RouteLink
                  to={`/seasons/${encodeURIComponent(id)}/corrections`}
                >
                  Исправить закрытые итоги
                </RouteLink>
              )}
            </>
          )}
        </QueryState>
        {summary?.state === "approved" && <SummaryHistory key={id} seasonId={id} />}
        <Card title="Основания бонусов мастеров">
          <QueryState loading={bonuses.isLoading} error={bonuses.error}>
            {bonuses.data?.items.map((b) => (
              <details className={s.details} key={b.bonus_id}>
                <summary>
                  {b.recipient?.display_name ?? "Мастер не назначен"} · {b.amount.toFixed(2)} ·
                  учитываемых организаторов {b.eligible_organizer_count}
                </summary>
                <p>Версия расчёта: {b.calculation_version}</p>
                <RouteLink to={`/blocks/${encodeURIComponent(b.block_id)}`}>
                  Блок — источник бонуса
                </RouteLink>
                <ul>
                  {b.basis.map((member) => (
                    <li key={member.participant_id}>
                      {member.user.display_name}: {member.member_task_score} —{" "}
                      {member.included
                        ? "включён"
                        : member.exclusion === "master"
                          ? "исключён как мастер"
                          : "исключён: неположительный вклад"}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            {bonuses.data?.items.length === 0 && (
              <Empty>Бонусов в этом сезоне нет.</Empty>
            )}
          </QueryState>
        </Card>
      </div>
    </Page>
  );
}
