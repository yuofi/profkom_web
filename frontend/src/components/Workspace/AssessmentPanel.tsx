import { useQueries, useQuery } from '@tanstack/react-query';
import { emptyCriteria, type Task, type Assignment } from '../../utils/api/contract';
import { tasksApi } from '../../utils/api/tasks.api';
import { can } from '../../utils/session';
import { displayDate, moscowInput, toUtc } from '../../utils/dates';
import { useWorkspaceActions } from '../../utils/hooks/useWorkspace';
import { ActionForm, type Field } from './ActionForm';
import { number, text } from './formValues';
import { QueryState } from './WorkspaceUI';
import s from './Workspace.module.css';
const criteriaNames: Record<string, string> = { unique: 'Уникальная задача', creative: 'Творческий подход', external_communication: 'Общение вне вуза', in_person: 'Очное присутствие', fixed_time: 'Выполнение в определённое время' };
export function AssessmentPanel({ assignment }: { assignment: Assignment }) {
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({ queryKey: ['assessments', assignment.assignment_id], queryFn: () => tasksApi.assessment(assignment.assignment_id), enabled: can(assignment, 'view_assessment_inputs') });
  if (!can(assignment, 'view_assessment_inputs')) return null;
  const inputs = query.data;
  return <details className={s.details}><summary>Исходные поля оценивания</summary><QueryState loading={query.isLoading} error={query.error}>{inputs && <><p>Часы: {inputs.hours ?? 'не заданы'} · Оценка: {inputs.evaluation ?? 'не задана'}</p><p>Расчётная дата выполнения: {displayDate(inputs.effective_completed_at)}</p>{can(inputs, 'edit_assessment_inputs') && <ActionForm key={inputs.revision} fields={[{ name: 'hours', label: 'Часы', type: 'number', value: String(inputs.hours ?? ''), required: true, min: 0 }, { name: 'evaluation', label: 'Оценка', type: 'select', value: inputs.evaluation === null ? '' : String(inputs.evaluation), options: [-1, 0, 1, 1.5].map(v => ({ value: String(v), label: String(v) })) }, { name: 'completed', label: 'Расчётная дата выполнения, МСК', type: 'datetime-local', value: inputs.effective_completed_at ? moscowInput(inputs.effective_completed_at) : '' }, { name: 'reason', label: 'Причина исправления', type: 'textarea', required: true }]} onSubmit={async v => { await perform(() => tasksApi.updateAssessment(assignment.assignment_id, { expected_revision: inputs.revision, hours: number(v, 'hours'), ...(text(v, 'evaluation') ? { evaluation: number(v, 'evaluation') as -1 | 0 | 1 | 1.5 } : {}), effective_completed_at: text(v, 'completed') ? toUtc(text(v, 'completed')) : null, reason: text(v, 'reason') })); }} onConflict={() => { void refresh(); }} />}</>}</QueryState></details>;
}
export function TaskInputsPanel({ task }: { task: Task }) {
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({ queryKey: ['assessments', 'task', task.task_id], queryFn: () => tasksApi.inputs(task.task_id), enabled: can(task, 'view_assessment_inputs') });
  if (!can(task, 'view_assessment_inputs')) return null;
  const inputs = query.data;
  const fields: Field[] = inputs ? [{ name: 'assigned', label: 'Дата выдачи, МСК', type: 'datetime-local', required: true, value: moscowInput(inputs.assigned_at) }, { name: 'deadline', label: 'Дедлайн, МСК', type: 'datetime-local', required: true, value: moscowInput(inputs.deadline_at) }, ...Object.entries(criteriaNames).map(([name, label]) => ({ name, label, type: 'select' as const, value: String(inputs.criteria[name as keyof typeof inputs.criteria]), options: [{ value: 'false', label: 'Нет' }, { value: 'true', label: 'Да' }] })), { name: 'reason', label: 'Причина изменения', required: true, type: 'textarea' }] : [];
  return <details className={s.details}><summary>Даты и признаки задачи</summary><QueryState loading={query.isLoading} error={query.error}>{inputs && <ActionForm key={inputs.revision} fields={fields} onSubmit={async v => {
    const assigned = toUtc(text(v, 'assigned')); const deadline = toUtc(text(v, 'deadline')); if (assigned > deadline) throw Error('Выдача не может быть позже дедлайна');
    await perform(() => tasksApi.updateInputs(task.task_id, { expected_revision: inputs.revision, assigned_at: assigned, deadline_at: deadline, criteria: { ...emptyCriteria(), ...Object.fromEntries(Object.keys(criteriaNames).map(k => [k, text(v, k) === 'true'])) }, reason: text(v, 'reason') }));
  }} onConflict={() => { void refresh(); }} />}</QueryState></details>;
}
export function BulkHoursPanel({ task }: { task: Task }) {
  const { perform, refresh } = useWorkspaceActions();
  const queries = useQueries({ queries: task.assignments.map(a => ({ queryKey: ['assessments', a.assignment_id], queryFn: () => tasksApi.assessment(a.assignment_id), enabled: can(a, 'view_assessment_inputs') })) });
  const inputs = queries.flatMap(q => q.data ? [q.data] : []);
  if (!inputs.some(a => can(a, 'edit_assessment_inputs'))) return null;
  return <details className={s.details}><summary>Установить часы нескольким исполнителям</summary><ActionForm fields={[{ name: 'assignments', label: 'Назначения', type: 'multi', required: true, options: task.assignments.filter(a => inputs.some(i => i.assignment_id === a.assignment_id)).map(a => ({ value: a.assignment_id, label: a.assignee.display_name })) }, { name: 'hours', label: 'Одинаковое количество часов', type: 'number', min: 0, required: true }, { name: 'reason', label: 'Причина', required: true }]} onSubmit={async v => { const selected = v.assignments as string[]; await perform(() => tasksApi.bulkHours(inputs.filter(i => selected.includes(i.assignment_id)).map(i => ({ assignment_id: i.assignment_id, expected_revision: i.revision })), number(v, 'hours'), text(v, 'reason'))); }} onConflict={() => { void refresh(); }} /></details>;
}
