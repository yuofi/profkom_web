import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UserRef } from "../../utils/api/contract";
import { ChipFace, ChipInitials } from "./ChipFace";
import { blockLogo } from "../../utils/teamLogos";
import { Glyph } from "./WorkspaceUI";
import s from "./EntityPicker.module.css";

export interface EntityOption {
  value: string;
  label: string;
  user?: UserRef;
  block?: { block_id?: string; name: string; avatar_url?: string | null };
  scope?: { kind: "block" | "subevent" | "event" | "chair"; name: string; avatar_url?: string | null };
  disabled?: boolean;
}
export type EntityKind = "person" | "block" | "scope";
interface CommonProps {
  id?: string;
  name?: string;
  label?: string;
  labelledBy?: string;
  entity?: EntityKind;
  options: EntityOption[];
  disabled?: boolean;
  loading?: boolean;
  invalid?: boolean;
  required?: boolean;
  describedBy?: string;
  placeholder?: string;
  emptyMessage?: string;
  onBlur?: () => void;
}
export type EntityPickerProps = CommonProps & (
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
);

function OptionChip({ option }: { option: EntityOption }) {
  if (option.user) return <ChipFace label={option.user.display_name} avatarUrl={option.user.avatar_url} />;
  if (option.block) return <ChipFace label={option.block.name} avatarUrl={option.block.avatar_url ?? blockLogo(option.block.name)} avatarPresentation="logo" avatarFallback={<ChipInitials name={option.block.name} />} />;
  if (option.scope?.kind === "block") return <ChipFace label={option.scope.name} avatarUrl={option.scope.avatar_url ?? blockLogo(option.scope.name)} avatarPresentation="logo" avatarFallback={<ChipInitials name={option.scope.name} />} />;
  if (option.scope) return <ChipFace label={option.scope.name} avatarUrl={option.scope.avatar_url ?? undefined} icon={<Glyph name={option.scope.kind === "subevent" ? "event" : "groups"} />} />;
  return <ChipFace label={option.label} />;
}
function missingLabel(kind?: EntityKind) {
  return kind === "person" ? "Выбранный участник недоступен" : kind === "block" ? "Выбранный блок недоступен" : "Выбранное значение недоступно";
}

/** Search operates only on the supplied authorized options; typed text never becomes a saved ID. */
export function EntityPicker(props: EntityPickerProps) {
  const generated = useId(), id = props.id ?? generated;
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), popup = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [active, setActive] = useState(0);
  const options = [...new Map(props.options.map(option => [option.value, option])).values()];
  const selected = props.multiple ? props.value : props.value ? [props.value] : [];
  const tokens = search.trim().toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
  const filtered = options.filter(option => {
    const words = [option.label, option.user?.display_name, option.block?.name, option.scope?.name].filter(Boolean).join(" ").toLocaleLowerCase("ru");
    return tokens.every(token => words.includes(token));
  });
  const expanded = open && !props.disabled;
  const activeIndex = filtered[active] && !filtered[active].disabled ? active : filtered.findIndex(option => !option.disabled);
  const blocked = () => !!props.disabled || !!input.current?.matches(":disabled");
  const activate = () => {
    if (blocked()) return;
    setPortal(root.current?.closest("dialog") ?? document.body);
    setOpen(true);
  };
  const choose = (option: EntityOption) => {
    if (blocked() || option.disabled) return;
    if (props.multiple) props.onChange(selected.includes(option.value) ? selected.filter(value => value !== option.value) : [...selected, option.value]);
    else props.onChange(option.value);
    setSearch("");input.current?.focus();setOpen(!!props.multiple);
  };
  const remove = (value: string) => {
    if (blocked()) return;
    if (props.multiple) props.onChange(selected.filter(item => item !== value));
    else props.onChange("");
    setSearch("");setActive(0);input.current?.focus();activate();
  };
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) { setOpen(false);setSearch(""); }
    };
    document.addEventListener("pointerdown", outside);
    // A popup portalled out of a disabled fieldset must never remain interactive.
    const observer = new MutationObserver(() => { if (input.current?.matches(":disabled")) setOpen(false); });
    let ancestor = root.current?.parentElement;
    while (ancestor) { if (ancestor instanceof HTMLFieldSetElement) observer.observe(ancestor, { attributes: true, attributeFilter: ["disabled"] });ancestor = ancestor.parentElement; }
    return () => { document.removeEventListener("pointerdown", outside);observer.disconnect(); };
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      if (!root.current || !popup.current) return;
      const rect = root.current.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 16, above = rect.top - 16;
      const upwards = below < 200 && above > below;
      const height = Math.max(48, Math.min(320, upwards ? above : below));
      popup.current.style.width = `${width}px`;
      popup.current.style.maxHeight = `${height}px`;
      popup.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      popup.current.style.top = upwards ? "auto" : `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 56))}px`;
      popup.current.style.bottom = upwards ? `${Math.max(8, window.innerHeight - rect.top + 6)}px` : "auto";
    };
    position();window.addEventListener("resize", position);window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position);window.removeEventListener("scroll", position, true); };
  }, [expanded, portal, filtered.length, selected.length, props.loading]);
  useEffect(() => {
    if (expanded && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, activeIndex, id]);
  const move = (key: string) => {
    const enabled = filtered.flatMap((option, index) => option.disabled ? [] : [index]);
    if (!enabled.length) return;
    if (key === "Home") setActive(enabled[0]);
    else if (key === "End") setActive(enabled.at(-1)!);
    else { const current = enabled.indexOf(activeIndex), direction = key === "ArrowUp" ? -1 : 1;setActive(enabled[(current + direction + enabled.length) % enabled.length]); }
  };
  return <div ref={root} className={s.root} data-entity-picker data-field-name={props.name} data-disabled={props.disabled || undefined}
    onBlur={event => {
      const target = event.relatedTarget;
      if (!(target instanceof Node) || (!root.current?.contains(target) && !popup.current?.contains(target))) { setOpen(false);setSearch("");props.onBlur?.(); }
    }}
    onKeyDown={event => { if (event.key === "Escape" && expanded) { event.preventDefault();event.stopPropagation();setOpen(false);setSearch(""); } }}>
    {props.label && <label className={s.label} id={`${id}-label`} htmlFor={id}>{props.label}</label>}
    <div className={s.control} data-invalid={props.invalid || undefined}>
      {selected.length > 0 && <ul className={s.selected} aria-label="Выбранные значения">{selected.map((value, index) => {
        const option = options.find(option => option.value === value);
        const label = option?.label ?? missingLabel(props.entity);
        return <li key={value} data-selected-value={value}>
          {option ? <OptionChip option={option} /> : <span className={s.missing}>{label}</span>}
          <button type="button" className={s.remove} disabled={props.disabled} aria-label={`Убрать: ${label}${!option && selected.length > 1 ? ` (${index + 1})` : ""}`} onClick={() => remove(value)}><Glyph name="close" /></button>
        </li>;
      })}</ul>}
      <div className={s.search}>
        <svg className={s.searchIcon} viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
        <input ref={input} id={id} name={props.name ? `${props.name}__query` : undefined} type="text" role="combobox" autoComplete="off"
          aria-label={!props.label && !props.labelledBy ? "Поиск и выбор" : undefined} aria-labelledby={props.labelledBy ?? (props.label ? `${id}-label` : undefined)}
          aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-options` : undefined} aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          aria-required={props.required || undefined} aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy} disabled={props.disabled}
          placeholder={selected.length ? props.multiple ? "Найти и добавить…" : "Изменить выбор…" : props.placeholder ?? (props.multiple ? "Найти и добавить…" : "Найти и выбрать…")} value={search}
          onFocus={activate} onClick={activate} onChange={event => { setSearch(event.target.value);setActive(0);activate(); }}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault();event.stopPropagation();if (expanded && activeIndex >= 0) choose(filtered[activeIndex]);else activate(); }
            else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault();const already = expanded;activate();if (already || ["Home", "End", "ArrowUp"].includes(event.key)) move(event.key); }
          }} />
        {props.loading && <span className={s.loading} aria-hidden="true">…</span>}
      </div>
    </div>
    {props.name && (props.multiple ? selected.map(value => <input key={value} type="hidden" name={props.name} value={value} />) : <input type="hidden" name={props.name} value={props.value} />)}
    {expanded && portal && createPortal(<div ref={popup} className={s.popup} data-entity-picker-popup={id} data-field-name={props.name} onMouseDown={event => event.preventDefault()}>
      {props.loading && <p role="status" className={s.message}>Загружаем варианты…</p>}
      <ul id={`${id}-options`} role="listbox" aria-label={props.label ?? "Доступные варианты"} aria-multiselectable={props.multiple || undefined} aria-busy={props.loading || undefined}>
        {filtered.map((option, index) => <li id={`${id}-option-${index}`} key={option.value} role="option" aria-selected={selected.includes(option.value)} aria-disabled={option.disabled || undefined}
          data-option-value={option.value} data-value={option.value} data-active={activeIndex === index} onMouseEnter={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(option)}>
          <OptionChip option={option} /><span className={s.check} aria-hidden="true">{selected.includes(option.value) ? "✓" : ""}</span>
        </li>)}
      </ul>
      {!props.loading && !filtered.length && <p className={s.message}>{props.emptyMessage ?? "Подходящих вариантов нет."}</p>}
    </div>, portal)}
  </div>;
}
