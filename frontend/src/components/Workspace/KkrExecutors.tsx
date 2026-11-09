import { useEffect, useRef, useState } from "react";
import type { AccountingRow } from "../../utils/api/kkr.api";
import { formatHours, parseHours } from "../../utils/kkrAccounting";
import { UserChip } from "./UserChip";
import k from "./KkrExecutors.module.css";

type Evaluation = Exclude<AccountingRow["evaluation"], null>;
interface Props { rows: AccountingRow[]; disabled: boolean; onPatch: (id: string, values: Partial<AccountingRow>) => void }

/** The four evaluations: −1 and 0 are «не выполнено», 1 and 1,5 «зачтено». */
const evaluations: { value: Evaluation; label: string; done: boolean }[] = [
  { value: -1, label: "−1", done: false }, { value: 0, label: "0", done: false },
  { value: 1, label: "1", done: true }, { value: 1.5, label: "1,5", done: true },
];

/**
 * The executors of the KKR window (owner A2, variant Д): the hours in a field with «ч» inside it, the
 * evaluation four buttons seen at once with «не выполнено» and «зачтено» under them, «Исключить» a
 * checkbox. On a laptop one line per person under a header; on a phone the person and «Исключить»,
 * then the hours and the four buttons across the width.
 */
export function KkrExecutors({ rows, disabled, onPatch }: Props) {
  return <div className={k.executors}>
    <div className={k.head} aria-hidden="true"><span>Исполнитель</span><span>Часы</span><span>Оценка</span><span>Учёт</span></div>
    <ul aria-label="Исполнители">{rows.map(row => <Executor key={row.assignment_id} row={row} disabled={disabled} onPatch={onPatch} />)}</ul>
  </div>;
}

function Executor({ row, disabled, onPatch }: { row: AccountingRow; disabled: boolean; onPatch: Props["onPatch"] }) {
  const name = row.assignee.display_name, off = disabled || row.excluded;
  const patch = (values: Partial<AccountingRow>) => onPatch(row.assignment_id, values);
  return <li className={k.row} data-excluded={row.excluded || undefined}>
    <div className={k.who}><UserChip user={row.assignee} />{!row.is_current && <small>Прежний исполнитель</small>}</div>
    <label className={k.hours} data-disabled={off || undefined}>
      <HoursInput value={row.hours} label={`Часы: ${name}`} disabled={off} required={!row.excluded} onChange={hours => patch({ hours })} />
      <span aria-hidden="true">ч</span>
    </label>
    <div className={k.evaluation}>
      {/* One group with one chosen value: arrows move the choice, Tab leaves the group. */}
      <div className={k.choices} role="radiogroup" aria-label={`Оценка: ${name}`} aria-required={!row.excluded}>
        {evaluations.map(option => <label key={option.value} data-done={option.done || undefined}>
          <input type="radio" name={`evaluation-${row.assignment_id}`} value={option.value} required={!row.excluded} disabled={off}
            checked={row.evaluation === option.value} onChange={() => patch({ evaluation: option.value })} />
          <span aria-hidden="true">{option.label}</span>
          <span className={k.hidden}>{option.label}, {option.done ? "зачтено" : "не выполнено"}</span>
        </label>)}
      </div>
      <div className={k.caption} aria-hidden="true"><span>не выполнено</span><span>зачтено</span></div>
    </div>
    <label className={k.exclude}>
      <input type="checkbox" aria-label={`Исключить: ${name}`} disabled={disabled} checked={row.excluded} onChange={event => patch({ excluded: event.target.checked })} />
      Исключить
    </label>
  </li>;
}

/** A text field for hours: a comma or a dot, no spin arrows; what is typed stays until it is a number. */
function HoursInput({ value, onChange, label, disabled, required }: { value: number | null; onChange: (value: number | null) => void; label: string; disabled: boolean; required: boolean }) {
  const [text, setText] = useState(() => formatHours(value)), [seen, setSeen] = useState(value), input = useRef<HTMLInputElement>(null);
  // A value from outside (a template, the saved values) replaces the text unless the text already reads as it.
  if (value !== seen) { setSeen(value); if (parseHours(text) !== value) setText(formatHours(value)); }
  // A lone comma is not a number: the form does not send the previous hours under it.
  useEffect(() => { input.current?.setCustomValidity(parseHours(text) === undefined ? "Укажите часы числом, например 2,5" : ""); }, [text]);
  return <input ref={input} type="text" inputMode="decimal" autoComplete="off" placeholder="0" aria-label={label} disabled={disabled} required={required} value={text}
    onChange={event => {
      const [head, ...tail] = event.target.value.replace(/[^\d.,]/g, "").replace(/\./g, ",").split(",");
      const next = tail.length ? `${head},${tail.join("")}` : head, parsed = parseHours(next);
      setText(next);
      if (parsed !== undefined) onChange(parsed);
    }}
    onBlur={() => { if (parseHours(text) !== undefined) setText(formatHours(value)); }} />;
}
