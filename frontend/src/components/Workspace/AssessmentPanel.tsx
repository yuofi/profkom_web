import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  emptyCriteria,
  type Task,
  type Assignment,
  type AssessmentInputs,
  type AssignmentStatus,
} from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { number, text } from "./formValues";
import { QueryState } from "./WorkspaceUI";
import { UserChip } from "./UserChip";
import a from "./AssessmentPanel.module.css";
import s from "./Workspace.module.css";
import { KkrTemplateTools } from "./KkrTemplateLibrary";
import type { TemplateSelection } from "../../utils/api/profileFeatures.api";
import { HistoryDisclosure } from "./HistoryPanel";
import { criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";
const accountingStates: Record<AssignmentStatus, { label: string; explanation: string }> = {
  assigned: { label: "Ожидает оценки", explanation: "Решение для ККР ещё не принято." },
  in_progress: { label: "Ожидает оценки", explanation: "Работа в процессе; решение для ККР ещё не принято." },
  help_required: { label: "Нужны уточнения", explanation: "В учёте сохранён запрос помощи; решение для ККР ещё не принято." },
  submitted: { label: "Ожидает оценки", explanation: "Результат передан на оценивание для ККР." },
  needs_revision: { label: "На доработке", explanation: "Учётное решение возвращено на доработку." },
  accepted: { label: "Зачтено", explanation: "Принято для расчёта ККР с сохранёнными часами и оценкой." },
  not_completed: { label: "Не выполнено", explanation: "Для ККР учтено невыполнение с сохранённой оценкой." },
  cancelled: { label: "Исключено из ККР", explanation: "Назначение исключено из расчёта; оценка не применяется." },
};
export function AssessmentPanel({ assignment, open = false, hasResult = false, seasonClosed = false }: {
  assignment: Assignment; open?: boolean; hasResult?: boolean; seasonClosed?: boolean;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const [templateSelection, setTemplateSelection] = useState<TemplateSelection | null>(null);
  const query = useQuery({ queryKey: ["assessments", assignment.assignment_id], queryFn: () => tasksApi.assessment(assignment.assignment_id), enabled: can(assignment, "view_assessment_inputs") });
  if (!can(assignment, "view_assessment_inputs")) return null;
  const inputs = query.data;
  const status = inputs?.workflow_status;
  const state = status ? accountingStates[status] : null;
  const editable = can(inputs, "edit_assessment_inputs");
  const datesEditable = can(inputs, "edit_assessment_dates");
  const savedCompleted = inputs?.effective_completed_at ? moscowInput(inputs.effective_completed_at) : "";
  return <section className={a.panel} aria-label={`ККР: ${assignment.assignee.display_name}`}>
    <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error}>
      {inputs && <>
        <div className={a.summary}>
          <UserChip user={assignment.assignee} />
          <div className={a.state}><span className={a.label}>Состояние ККР</span><strong data-accounting-state={status ?? "unknown"}>{state?.label ?? "Состояние не получено"}</strong></div>
          <dl className={a.values}><div><dt>Часы</dt><dd data-accounting-hours>{inputs.hours ?? "не заданы"}</dd></div><div><dt>Оценка</dt><dd>{status === "cancelled" ? "не применяется" : inputs.evaluation ?? "не задана"}</dd></div></dl>
        </div>
        <p className={a.explanation}>{state?.explanation ?? "Обновите данные учёта перед принятием решения."}</p>
        <p className={a.date}>Расчётная дата выполнения: {displayDate(inputs.effective_completed_at)}</p>
        {seasonClosed && <p className={s.warning}>Сезон закрыт. Исправление ККР требует причины и создаёт новую версию итогов сезона. Публичный статус задачи не изменится.</p>}
        {editable && <details className={a.editor} open={open || undefined}>
          <summary>{inputs.evaluation == null && status !== "cancelled" ? "Оценить" : "Изменить"}</summary>
          <div className={a.editorBody}>
            <h4>Исходные поля оценивания</h4>
            <p className={s.muted}>Часы и выбранное решение сохраняются вместе. Если решение не выбрано, изменятся только заполненные поля. Статус задачи и другие исполнители не изменятся.</p>
            {status === "cancelled" && <p className={s.muted}>Исключённому назначению нельзя поставить оценку. Доступно исправление часов{datesEditable ? " и расчётной даты" : ""}.</p>}
            <ActionForm key={assignment.assignment_id} revision={inputs.revision} record={`assignment-inputs:${assignment.assignment_id}`} adoptWhenUntouched
              externalState={templateSelection} savedExternalState={null} onReplaceWithSaved={() => setTemplateSelection(null)}
              beforeFields={form => <KkrTemplateTools form={form} mode="assessment" selection={templateSelection} onSelection={setTemplateSelection} />}
              fields={[
                { name: "hours", label: "Часы", type: "number", value: String(inputs.hours ?? ""), required: true, min: 0 },
                ...(status === "cancelled" ? [] : [{ name: "evaluation", label: "Решение по ККР и оценка", type: "select" as const, value: "", options: [
                  { value: "1", label: "Зачесть · оценка 1" }, { value: "1.5", label: "Зачесть · оценка 1,5" },
                  { value: "0", label: "Не выполнено · оценка 0" }, { value: "-1", label: "Не выполнено · оценка −1" },
                ], hint: "Оставьте выбор пустым, чтобы сохранить текущее учётное решение. Для зачёта нужна фактическая сдача или разрешённая расчётная дата." }]),
                ...(datesEditable ? [{ name: "completed", label: "Расчётная дата выполнения, МСК", type: "datetime-local" as const, value: savedCompleted }] : []),
                { name: "reason", label: "Причина исправления", type: "textarea", required: true },
              ]}
              submitLabel="Сохранить ККР" onConflict={refresh} resetFieldsOnSuccess={["evaluation"]}
              onSubmit={async (v, expectedRevision) => perform(() => tasksApi.updateAssessment(assignment.assignment_id, {
                expected_revision: expectedRevision!, hours: number(v, "hours"),
                ...(inputs.workflow_status !== "cancelled" && text(v, "evaluation") ? { evaluation: number(v, "evaluation") as -1 | 0 | 1 | 1.5 } : {}),
                ...(datesEditable && text(v, "completed") && text(v, "completed") !== savedCompleted ? { effective_completed_at: toUtc(text(v, "completed")) } : {}),
                reason: text(v, "reason"),
                ...(templateSelection ? { template_selection: templateSelection } : {}),
              }))} />
          </div>
        </details>}
        <AccountingDecisions assignment={assignment} inputs={inputs} hasResult={hasResult || assignment.submissions.length > 0} />
        <HistoryDisclosure kind="assignment" id={assignment.assignment_id} title="История исходных полей и решений ККР" />
      </>}
    </QueryState>
  </section>;
}
function AccountingDecisions({ assignment, inputs, hasResult }: { assignment: Assignment; inputs: AssessmentInputs; hasResult: boolean }) {
  const { perform, refresh } = useWorkspaceActions();
  const status = inputs.workflow_status;
  if (!can(assignment, "review_assignment") || !can(inputs, "edit_assessment_inputs") || typeof inputs.workflow_revision !== "number" || !status) return null;
  const canExclude = ["assigned", "in_progress", "help_required", "submitted", "needs_revision"].includes(status);
  const canRevise = status !== "needs_revision" && (["submitted", "accepted"].includes(status) || hasResult);
  if (!canExclude && !canRevise) return null;
  return <details className={a.decisions}><summary>Другие решения по ККР</summary><div className={a.editorBody}>
    <p className={s.muted}>Это отдельное учётное решение. Оно не сохраняет несохранённые часы в форме выше и не меняет публичный статус задачи.</p>
    <ActionForm revision={inputs.workflow_revision} record={`assignment-inputs:${assignment.assignment_id}`} adoptWhenUntouched allowExitSave={false} onConflict={refresh} resetFieldsOnSuccess={["decision"]}
      fields={[
        { name: "decision", label: "Учётное решение", type: "select", required: true, options: [
          ...(canRevise ? [{ value: "request-revision", label: "Вернуть на доработку для ККР" }] : []),
          ...(canExclude ? [{ value: "cancel", label: "Исключить из расчёта ККР" }] : []),
        ] },
        { name: "reason", label: "Причина учётного решения", type: "textarea", required: true },
      ]} submitLabel="Применить учётное решение"
      onSubmit={async (values, revision) => {
        const decision = text(values, "decision");
        if (decision === "cancel" && canExclude) await perform(() => tasksApi.command(assignment.assignment_id, "cancel", { expected_revision: revision!, reason: text(values, "reason") }));
        else if (decision === "request-revision" && canRevise) await perform(() => tasksApi.command(assignment.assignment_id, "request-revision", { expected_revision: revision!, review_note: text(values, "reason") }));
        else throw Error("Обновите доступные учётные решения");
        try {
          const saved = await tasksApi.assessment(assignment.assignment_id);
          const acknowledged = saved.workflow_revision ?? saved.revision;
          if (acknowledged !== revision! + 1) throw Error("Учёт уже изменён после решения");
          return { revision: acknowledged };
        } catch { throw Error("Учётное решение применено. Не удалось перечитать его версию: обновите данные перед следующим действием."); }
      }} />
  </div></details>;
}
export function TaskInputsPanel({ task }: { task: Task }) {
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["assessments", "task", task.task_id],
    queryFn: () => tasksApi.inputs(task.task_id),
    enabled: can(task, "view_assessment_inputs"),
  });
  if (!can(task, "view_assessment_inputs")) return null;
  const inputs = query.data;
  // Issue date and deadline are moved by the chair, deputies and HR master only (УВ-5).
  const datesEditable = can(inputs, "edit_assessment_dates");
  const saved = inputs && { assigned: moscowInput(inputs.assigned_at), deadline: inputs.deadline_at ? moscowInput(inputs.deadline_at) : "" };
  const fields: Field[] = inputs && saved
    ? [
        ...(datesEditable
          ? [
              {
                name: "assigned",
                label: "Дата выдачи, МСК",
                type: "datetime-local" as const,
                required: true,
                value: saved.assigned,
              },
              {
                name: "deadline",
                label: "Дедлайн, МСК",
                type: "datetime-local" as const,
                required: true,
                value: saved.deadline,
              },
            ]
          : []),
        ...criteriaKeys.map((name) => ({
          name,
          label: criteriaLabels[name],
          type: "select" as const,
          value: String(inputs.criteria[name]),
          options: [
            { value: "false", label: "Нет" },
            { value: "true", label: "Да" },
          ],
        })),
        {
          name: "reason",
          label: "Причина изменения",
          required: true,
          type: "textarea",
        },
      ]
    : [];
  return (
    <details className={s.details}>
      <summary>Даты и признаки задачи</summary>
      <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error}>
        {inputs && !datesEditable && (
          <p>
            Выдана: {displayDate(inputs.assigned_at)} · Дедлайн:{" "}
            {displayDate(inputs.deadline_at)}
          </p>
        )}
        {inputs && !can(inputs, "edit_assessment_inputs") && (
          <>
            <ul>
              {criteriaKeys.map((key) => (
                <li key={key}>
                  {criteriaLabels[key]}:{" "}
                  {inputs.criteria[key]
                    ? "да"
                    : "нет"}
                </li>
              ))}
            </ul>
          </>
        )}
        {inputs && can(inputs, "edit_assessment_inputs") && (
          <ActionForm
            key={task.task_id}
            revision={inputs.revision}
            record={`task:${task.task_id}`}
            adoptWhenUntouched
            fields={fields}
            onSubmit={async (v, expectedRevision) => {
              // Only moved dates are sent: minutes in the field are not the stored instant.
              const moved = (name: "assigned" | "deadline") =>
                datesEditable && text(v, name) !== saved![name] ? toUtc(text(v, name)) : undefined;
              const assigned = moved("assigned"), deadline = moved("deadline");
              if (Date.parse(assigned ?? inputs.assigned_at) > Date.parse(deadline ?? inputs.deadline_at ?? ""))
                throw Error("Выдача не может быть позже дедлайна");
              return perform(() =>
                tasksApi.updateInputs(task.task_id, {
                  expected_revision: expectedRevision!,
                  ...(assigned ? { assigned_at: assigned } : {}),
                  ...(deadline ? { deadline_at: deadline } : {}),
                  criteria: {
                    ...emptyCriteria(),
                    ...Object.fromEntries(
                      criteriaKeys.map((k) => [
                        k,
                        text(v, k) === "true",
                      ]),
                    ),
                  },
                  reason: text(v, "reason"),
                }),
              );
            }}
            onConflict={refresh}
          />
        )}
        {inputs && <HistoryDisclosure kind="task" id={task.task_id} title="История параметров и исходных полей задачи" />}
      </QueryState>
    </details>
  );
}
