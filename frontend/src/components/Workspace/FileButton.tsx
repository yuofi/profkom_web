import { useRef, type ChangeEvent, type RefObject } from "react";
import { Glyph } from "./WorkspaceUI";
import s from "./Workspace.module.css";
import b from "./FileButton.module.css";

/**
 * The site's file choice: a button and the chosen name; the system «Choose File» control stays
 * hidden (GL-40). `inputRef` lets the owner clear the chosen file.
 */
export function FileButton({ label = "Выбрать файл", fileName, showName = true, accept, disabled, describedBy, invalid, inputRef, onChange }: {
  label?: string;
  fileName?: string | null;
  /** Off where the owner already names the chosen file. */
  showName?: boolean;
  accept?: string;
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const own = useRef<HTMLInputElement>(null), input = inputRef ?? own;
  return <div className={b.field}>
    <button type="button" className={s.button} disabled={disabled} aria-describedby={describedBy} aria-invalid={invalid || undefined} onClick={() => input.current?.click()}>
      <Glyph name="attach_file" />{label}
    </button>
    {showName && <span className={b.name}>{fileName || "Файл не выбран"}</span>}
    <input ref={input} type="file" hidden tabIndex={-1} accept={accept} disabled={disabled} onChange={onChange} />
  </div>;
}
