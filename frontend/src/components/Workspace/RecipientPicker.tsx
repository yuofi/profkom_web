import { useState } from "react";
import s from "./Workspace.module.css";

export function RecipientPicker({
  id,
  options,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
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
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-invalid={invalid}
      aria-describedby={describedBy}
    >
      <label className={s.field} htmlFor={`${id}-search`}>
        Поиск получателей
      </label>
      <input
        id={`${id}-search`}
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <p>Выбрано: {value.length}</p>
      <div className={s.recipientOptions}>
        {filtered.map((p) => (
          <label className={s.row} key={p.value}>
            <input
              type="checkbox"
              checked={value.includes(p.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, p.value]
                    : value.filter((v) => v !== p.value),
                )
              }
            />
            {p.label}
          </label>
        ))}
      </div>
      {!filtered.length && <p>Подходящих участников нет.</p>}
    </div>
  );
}
