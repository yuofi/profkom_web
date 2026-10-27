import type { MouseEventHandler, ReactNode, Ref } from "react";
import { Link, type To } from "react-router-dom";
import { ChipFace, type ChipFaceProps } from "./ChipFace";
import s from "./InteractiveChip.module.css";
interface ActionAria { expanded?: boolean; controls?: string; hasPopup?: "dialog" | "menu" | "listbox" | true }
export interface ChipTrailingAction extends ActionAria { label: string; onClick: MouseEventHandler<HTMLButtonElement>; icon?: ReactNode; disabled?: boolean }
interface Common extends Omit<ChipFaceProps, "className"> { className?: string; title?: string; ariaLabel?: string; ariaDescribedBy?: string; anchorRef?: Ref<HTMLSpanElement>; trailingAction?: ChipTrailingAction }
export type InteractiveChipProps = Common & (
  | { kind: "link"; to: To; onClick?: MouseEventHandler<HTMLAnchorElement>; target?: string; rel?: string }
  | ({ kind: "action"; onClick: MouseEventHandler<HTMLButtonElement>; disabled?: boolean } & ActionAria)
  | { kind: "display"; focusable?: boolean }
);
/** One primary semantic action and an optional sibling action; never nested interactive elements. */
export function InteractiveChip({ anchorRef, ...props }: InteractiveChipProps) {
  const face = <ChipFace label={props.label} avatarUrl={props.avatarUrl} avatarFallback={props.avatarFallback} icon={props.icon} />;
  const common = { className: s.main, title: props.title, "aria-label": props.ariaLabel, "aria-describedby": props.ariaDescribedBy };
  return <span ref={anchorRef} className={`${s.shell} ${props.className ?? ""}`} data-row-action={props.kind !== "display" || props.trailingAction ? true : undefined} data-has-trailing={!!props.trailingAction || undefined}>
    {props.kind === "link" ? <Link {...common} to={props.to} target={props.target} rel={props.rel} onClick={props.onClick}>{face}</Link> : props.kind === "action" ? <button {...common} type="button" disabled={props.disabled} onClick={props.onClick} aria-expanded={props.expanded} aria-controls={props.controls} aria-haspopup={props.hasPopup}>{face}</button> : <span {...common} tabIndex={props.focusable ? 0 : undefined}>{face}</span>}
    {props.trailingAction && <button type="button" className={s.trailing} aria-label={props.trailingAction.label} title={props.trailingAction.label} disabled={props.trailingAction.disabled}
      aria-expanded={props.trailingAction.expanded} aria-controls={props.trailingAction.controls} aria-haspopup={props.trailingAction.hasPopup}
      onClick={event => { event.stopPropagation();props.trailingAction!.onClick(event); }}>
      {props.trailingAction.icon ?? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 16 11-11 3 3L8 19H5v-3Zm9-9 3 3" /></svg>}
    </button>}
  </span>;
}
