import { useId, type FocusEvent } from "react";
import type { Criteria } from "../../utils/api/contract";
import { criteriaFactors, criteriaKeys, criteriaLabels } from "../../utils/kkrCriteria";
import { metricValue } from "../../pages/Workspace/seasonAnalyticsView";
import s from "./CriteriaGroup.module.css";

type Key = keyof Criteria;

/**
 * The KKR criteria as equal tiles (owner A1, variant Б): one look and the same names in the KKR
 * window, the merit form, the correction of closed results and the template editor. Each tile is a
 * real checkbox named by its criterion; the multiplier beside the name is its description.
 */
export function CriteriaGroup({ legend = "Признаки задачи", keys = criteriaKeys, checked, onChange, disabled = false, onBlur }: {
  legend?: string;
  /** The criteria shown, in the table's order unless a form says otherwise. */
  keys?: readonly Key[];
  checked: (key: Key) => boolean;
  onChange: (key: Key, value: boolean) => void;
  disabled?: boolean;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
}) {
  const id = useId();
  return (
    <fieldset className={s.group} disabled={disabled}>
      <legend className={s.legend}>{legend}</legend>
      <div className={s.frame}>
        <div className={s.tiles}>
          {keys.map((key) => (
            <label key={key} className={s.tile}>
              <input type="checkbox" name={key} value="true" checked={checked(key)} onBlur={onBlur}
                aria-labelledby={`${id}-${key}`} aria-describedby={`${id}-${key}-factor`}
                onChange={(event) => onChange(key, event.target.checked)} />
              {/* The multiplier floats at the right of the name's first line, so the lines below it
                  take the tile's whole width and a long word stays whole. */}
              <span className={s.text}>
                <span className={s.factor} id={`${id}-${key}-factor`}>×{metricValue(criteriaFactors[key])}</span>
                <span id={`${id}-${key}`}>{criteriaLabels[key]}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
