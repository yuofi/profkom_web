import { useState } from "react";
import { Glyph } from "./WorkspaceUI";
import s from "./Workspace.module.css";

/** Every multiple choice of people: search, checkboxes and chips of the chosen (A-ROL-13). */
export function RecipientPicker({
  id,
  name,
  options,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  name?: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [search, setSearch] = useState("");
  const filtered = options.filter(
    (p) =>
      p.label
        .toLocaleLowerCase("ru")
        .includes(search.trim().toLocaleLowerCase("ru")) ||
      value.includes(p.value),
  );
  const label = (v: string) => options.find((p) => p.value === v)?.label ?? v;
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-invalid={invalid}
      aria-describedby={describedBy}
    >
      <label className={s.field} htmlFor={`${id}-search`}>
        Поиск
      </label>
      <input
        id={`${id}-search`}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <p>Выбрано: {value.length}</p>
      {value.length > 0 && (
        <ul className={s.chips} aria-label="Выбранные">
          {value.map((v) => (
            <li key={v}>
              <button
                type="button"
                className={s.chip}
                aria-label={`Убрать: ${label(v)}`}
                onClick={() => onChange(value.filter((x) => x !== v))}
              >
                {label(v)}
                <Glyph name="close" className={s.chipClose} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={s.recipientOptions}>
        {filtered.map((p) => (
          <label className={s.row} key={p.value}>
            <input
              type="checkbox"
              name={name}
              value={p.value}
              checked={value.includes(p.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, p.value]
                    : value.filter((v) => v !== p.value),
                )
              }
            />
            <span>{p.label}</span>
          </label>
        ))}
      </div>
      {!filtered.length && <p>Подходящих участников нет.</p>}
    </div>
  );
}
