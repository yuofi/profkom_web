import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  emptyCriteria,
  type Task,
  type Assignment,
} from "../../utils/api/contract";
import { tasksApi } from "../../utils/api/tasks.api";
import { can } from "../../utils/session";
import { displayDate, moscowInput, toUtc } from "../../utils/dates";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";
import { ActionForm, type Field } from "./ActionForm";
import { number, text } from "./formValues";
import { Loading, QueryState } from "./WorkspaceUI";
import { revisionSnapshot, snapshotRevisions } from "./revisionSnapshot";
import { advanceOwn, recordOwnChange, useOwnRevisions } from "./ownRevisions";
import s from "./Workspace.module.css";
const criteriaNames: Record<string, string> = {
  unique: "Уникальная задача",
  creative: "Творческий подход",
  external_communication: "Общение вне вуза",
  in_person: "Очное присутствие",
  fixed_time: "Выполнение в определённое время",
};
export function AssessmentPanel({
  assignment,
  open = false,
}: {
  assignment: Assignment;
  open?: boolean;
}) {
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["assessments", assignment.assignment_id],
    queryFn: () => tasksApi.assessment(assignment.assignment_id),
    enabled: can(assignment, "view_assessment_inputs"),
  });
  if (!can(assignment, "view_assessment_inputs")) return null;
  const inputs = query.data;
  const savedEvaluation = inputs?.evaluation == null ? "" : String(inputs.evaluation);
  const savedCompleted = inputs?.effective_completed_at ? moscowInput(inputs.effective_completed_at) : "";
  // The completion date is moved by the chair, deputies and HR master only (УВ-5).
  const datesEditable = can(inputs, "edit_assessment_dates");
  return (
    <details className={s.details} open={open || undefined}>
      <summary>Исходные поля оценивания</summary>
      <QueryState keepDataOnError={!!query.data} loading={query.isLoading} error={query.error}>
        {inputs && (
          <>
            <p>
              Часы: {inputs.hours ?? "не заданы"} · Оценка:{" "}
              {inputs.evaluation ?? "не задана"}
            </p>
            <p>
              Расчётная дата выполнения:{" "}
              {displayDate(inputs.effective_completed_at)}
            </p>
            {can(inputs, "edit_assessment_inputs") && (
              <ActionForm
                key={assignment.assignment_id}
                revision={inputs.revision}
                record={`assignment-inputs:${assignment.assignment_id}`}
                adoptWhenUntouched
                fields={[
                  {
                    name: "hours",
                    label: "Часы",
                    type: "number",
                    value: String(inputs.hours ?? ""),
                    required: true,
                    min: 0,
                  },
                  // A cancelled assignment stays without an evaluation (A-TSK-2).
                  ...(assignment.status === "cancelled"
                    ? []
                    : [
                        {
                          name: "evaluation",
                          label: "Оценка",
                          type: "select" as const,
                          value: savedEvaluation,
                          options: [-1, 0, 1, 1.5].map((v) => ({
                            value: String(v),
                            label: String(v),
                          })),
                        },
                      ]),
                  ...(datesEditable
                    ? [
                        {
                          name: "completed",
                          label: "Расчётная дата выполнения, МСК",
                          type: "datetime-local" as const,
                          value: savedCompleted,
                        },
                      ]
                    : []),
                  {
                    name: "reason",
                    label: "Причина исправления",
                    type: "textarea",
                    required: true,
                  },
                ]}
                onSubmit={async (v, expectedRevision) => {
                  return perform(() =>
                    tasksApi.updateAssessment(assignment.assignment_id, {
                      expected_revision: expectedRevision!,
                      hours: number(v, "hours"),
                      // Only a changed evaluation is sent: it also changes the status.
                      // The form may still hold one from before a cancellation.
                      ...(assignment.status !== "cancelled" &&
                      text(v, "evaluation") &&
                      text(v, "evaluation") !== savedEvaluation
                        ? {
                            evaluation: number(v, "evaluation") as
                              | -1
                              | 0
                              | 1
                              | 1.5,
                          }
                        : {}),
                      // Only a moved date is sent: minutes in the field are not the stored instant.
                      ...(datesEditable && text(v, "completed") && text(v, "completed") !== savedCompleted
                        ? { effective_completed_at: toUtc(text(v, "completed")) }
                        : {}),
                      reason: text(v, "reason"),
                    }),
                  );
                }}
                onConflict={refresh}
              />
            )}
          </>
        )}
      </QueryState>
    </details>
  );
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
  const saved = inputs && { assigned: moscowInput(inputs.assigned_at), deadline: moscowInput(inputs.deadline_at) };
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
        ...Object.entries(criteriaNames).map(([name, label]) => ({
          name,
          label,
          type: "select" as const,
          value: String(inputs.criteria[name as keyof typeof inputs.criteria]),
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
              {Object.entries(criteriaNames).map(([key, label]) => (
                <li key={key}>
                  {label}:{" "}
                  {inputs.criteria[key as keyof typeof inputs.criteria]
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
              if (Date.parse(assigned ?? inputs.assigned_at) > Date.parse(deadline ?? inputs.deadline_at))
                throw Error("Выдача не может быть позже дедлайна");
              return perform(() =>
                tasksApi.updateInputs(task.task_id, {
                  expected_revision: expectedRevision!,
                  ...(assigned ? { assigned_at: assigned } : {}),
                  ...(deadline ? { deadline_at: deadline } : {}),
                  criteria: {
                    ...emptyCriteria(),
                    ...Object.fromEntries(
                      Object.keys(criteriaNames).map((k) => [
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
      </QueryState>
    </details>
  );
}
export function BulkHoursPanel({ task }: { task: Task }) {
  const { perform, refresh } = useWorkspaceActions();
  const client = useOwnRevisions();
  const [ready, setReady] = useState(false);
  const queries = useQueries({
    queries: task.assignments
      .filter((a) => can(a, "view_assessment_inputs"))
      .map((a) => ({
        queryKey: ["assessments", a.assignment_id],
        queryFn: () => tasksApi.assessment(a.assignment_id),
      })),
  });
  const inputs = queries.flatMap((q) =>
    q.data && can(q.data, "edit_assessment_inputs") ? [q.data] : [],
  );
  if (!ready && queries.every(q => !q.isLoading)) setReady(true);
  if (!ready) return <Loading />;
  if (!inputs.some((a) => can(a, "edit_assessment_inputs"))) return null;
  return (
    <details className={s.details}>
      <summary>Установить часы нескольким исполнителям</summary>
      <ActionForm
        revisionKey={revisionSnapshot(inputs.map(i => ({id: i.assignment_id, revision: i.revision})))}
        // Own corrections of single assignments move this combined baseline too (A-FE-2).
        rebaseKey={(key) => revisionSnapshot([...snapshotRevisions(key)].map(([id, revision]) => ({id, revision: advanceOwn(client, `assignment-inputs:${id}`, revision)})))}
        adoptWhenUntouched
        savedDetails={<ul>{inputs.map(i => <li key={i.assignment_id}>{task.assignments.find(a => a.assignment_id === i.assignment_id)?.assignee.display_name}: {i.hours ?? "не заданы"} ч.</li>)}</ul>}
        fields={[
          {
            name: "assignments",
            label: "Назначения",
            type: "multi",
            required: true,
            options: task.assignments
              .filter((a) =>
                inputs.some((i) => i.assignment_id === a.assignment_id),
              )
              .map((a) => ({
                value: a.assignment_id,
                label: a.assignee.display_name,
              })),
          },
          {
            name: "hours",
            label: "Одинаковое количество часов",
            type: "number",
            min: 0,
            required: true,
          },
          { name: "reason", label: "Причина", required: true },
        ]}
        onSubmit={async (v, _expectedRevision, snapshot) => {
          const selected = v.assignments as string[];
          const revisions = snapshotRevisions(snapshot);
          if (selected.some(id => !revisions.has(id) || !inputs.some(i => i.assignment_id === id)))
            throw Error("Обновите список доступных назначений");
          const saved = await perform(() =>
            tasksApi.bulkHours(
              selected.map(id => ({assignment_id: id, expected_revision: revisions.get(id)!})),
              number(v, "hours"),
              text(v, "reason"),
            ),
          );
          saved.items.forEach(i => {
            recordOwnChange(client, `assignment-inputs:${i.assignment_id}`, revisions.get(i.assignment_id)!, i.revision);
            revisions.set(i.assignment_id, i.revision);
          });
          return { revisionKey: revisionSnapshot([...revisions].map(([id, revision]) => ({id, revision}))) };
        }}
        onConflict={refresh}
      />
    </details>
  );
}
