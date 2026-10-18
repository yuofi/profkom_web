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
import s from "../../components/Workspace/Workspace.module.css";
const states = {
  planned: "Запланирован",
  open: "Открыт",
  summarizing: "Подведение итогов",
  closed: "Закрыт",
};
const decisions: Record<Decision, string> = {
  golden_red_bull: "Золотой Red Bull",
  kick_warning: "Предупреждение о кике",
  kick: "Кик",
  nice: "Найс",
};
export function DecisionBadges({ values }: { values: Decision[] }) {
  return values.length ? (
    <div className={s.row}>
      {values.map((d) => (
        <span key={d} className={`${s.decision} ${s[d]}`}>
          {decisions[d]}
        </span>
      ))}
    </div>
  ) : (
    <span>Нет отметок</span>
  );
}
export function SeasonsPage() {
  const { session } = useSession();
  const { perform } = useWorkspaceActions();
  const query = useQuery({ queryKey: ["seasons"], queryFn: seasonsApi.list });
  return (
    <Page title="Сезоны">
      <div className={s.stack}>
        <QueryState loading={query.isLoading} error={query.error}>
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
  const { perform } = useWorkspaceActions();
  const [failure, setFailure] = useState<ReturnType<
    typeof normalizeApiError
  > | null>(null);
  return (
    <div>
      <ActionForm
        fields={[]}
        submitLabel={label}
        onSubmit={async () => {
          setFailure(null);
          try {
            await perform(() =>
              seasonsApi.command(season.season_id, action, {
                expected_revision: season.revision,
              }),
            );
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
      <QueryState loading={query.isLoading} error={query.error}>
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
                  key={season.revision}
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
                  onSubmit={async (v) => {
                    if (text(v, "start") >= text(v, "end"))
                      throw Error("Начало должно быть раньше конца");
                    await perform(() =>
                      seasonsApi.update(id, {
                        expected_revision: season.revision,
                        title: text(v, "title"),
                        starts_at: toUtc(text(v, "start")),
                        ends_at: toUtc(text(v, "end")),
                        reason: text(v, "reason"),
                      }),
                    );
                  }}
                  onConflict={() => {
                    void refresh();
                  }}
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
        key={summary.version}
        fields={[
          {
            name: "decisions",
            label: "Текущие отметки",
            type: "multi",
            value: row.decisions,
            options: Object.entries(decisions).map(([value, label]) => ({
              value,
              label,
            })),
          },
          { name: "reason", label: "Основание", required: true },
        ]}
        onSubmit={async (v) => {
          await perform(() =>
            seasonsApi.decisions(summary.season_id, row.user.user_id!, {
              expected_version: summary.version,
              decisions: v.decisions as Decision[],
              reason: text(v, "reason"),
            }),
          );
        }}
        onConflict={() => {
          void refresh();
        }}
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
        <QueryState loading={query.isLoading} error={query.error}>
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
                <div
                  className={s.tableWrap}
                  tabIndex={0}
                  role="region"
                  aria-label="Сезонная сводная, горизонтальная прокрутка"
                >
                  <table className={`${s.table} ${s.summaryTable}`}>
                    <thead>
                      <tr>
                        {[
                          "Место / прошлое",
                          "Участник",
                          "Блоки",
                          "Источники",
                          "ККР / задач",
                          "Отметки",
                        ].map((x) => (
                          <th key={x}>{x}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summary.rows
                        .filter((row) =>
                          `${row.user.display_name} ${row.group_number}`
                            .toLowerCase()
                            .includes(filter.toLowerCase()),
                        )
                        .map((row) => (
                          <tr key={row.participant_id}>
                            <td>
                              {row.rank} / {row.previous_rank ?? "—"}
                            </td>
                            <td>
                              {row.user.display_name}
                              <p className={s.muted}>
                                {row.group_number} ·{" "}
                                {row.category === "junior"
                                  ? "Джуниор"
                                  : "Активист"}
                              </p>
                              {row.is_archived && <Badge>Уже исключён</Badge>}
                              {row.is_master && <Badge>Мастер</Badge>}
                            </td>
                            <td>
                              {row.blocks.map((b) => b.name).join(", ") || "—"}
                            </td>
                            <td>
                              {row.source_scores.map((source, i) => (
                                <p key={i}>
                                  {source.title}: {source.score.toFixed(2)}
                                </p>
                              ))}
                            </td>
                            <td>
                              {row.total_score.toFixed(2)} /{" "}
                              {row.evaluated_task_count}
                            </td>
                            <td>
                              <div aria-label="Решения текущего сезона">
                                <DecisionBadges values={row.decisions} />
                              </div>
                              <div aria-label="Решения прошлого сезона">
                                <p className={s.muted}>Ранее:</p>
                                <DecisionBadges
                                  values={row.previous_decisions}
                                />
                              </div>
                              {can(summary, "edit_decisions") &&
                                row.user.user_id && (
                                  <DecisionsForm row={row} summary={summary} />
                                )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
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
        <Card title="Основания бонусов мастеров">
          <QueryState loading={bonuses.isLoading} error={bonuses.error}>
            {bonuses.data?.items.map((b) => (
              <details className={s.details} key={b.bonus_id}>
                <summary>
                  {b.recipient.display_name} · {b.amount.toFixed(2)} ·
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
