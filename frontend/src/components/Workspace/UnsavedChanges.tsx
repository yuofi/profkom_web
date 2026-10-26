import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, useLocation, useNavigate, type BlockerFunction } from "react-router-dom";
import { UnsavedChangesContext, UnsavedChangesScopeContext, type Entry } from "./unsavedChangesHooks";
import s from "./UnsavedChanges.module.css";
type PendingAction = { run: () => void | Promise<void>; scope?: string };
type NavigationEffect = { target: string; from: string; run: () => void | Promise<void> };
const address = (location: { pathname: string; search: string; hash: string }) => location.pathname + location.search + location.hash;

/** Closing this editor affects only its forms; route exits still check all editors. */
export function UnsavedChangesScope({ children }: { children: ReactNode }) {
  const scope = useId();
  return <UnsavedChangesScopeContext.Provider value={scope}>{children}</UnsavedChangesScopeContext.Provider>;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const [statuses, setStatuses] = useState<Record<string, Pick<Entry, "dirty" | "busy" | "label" | "scope"> & { canSave: boolean }>>({});
  const transitioning = useRef(false);
  const lastBlockedKey = useRef<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const effect = useRef<NavigationEffect | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const currentAddress = address(location);
  const dirtyEntries = useCallback((scope?: string) => [...entries.current.values()].filter((entry) => (!scope || entry.scope === scope) && (entry.dirty || entry.busy)), []);
  const blocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) =>
    currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search && dirtyEntries().length > 0,
  [dirtyEntries]));
  const update = useCallback((id: string, entry: Entry) => {
    entries.current.set(id, entry);
    setStatuses((old) => {
      const previous = old[id];
      if (previous && previous.dirty === entry.dirty && previous.busy === entry.busy && previous.label === entry.label && previous.scope === entry.scope && previous.canSave === !!entry.save) return old;
      return { ...old, [id]: { dirty: entry.dirty, busy: entry.busy, label: entry.label, scope: entry.scope, canSave: !!entry.save } };
    });
  }, []);
  const remove = useCallback((id: string) => {
    entries.current.delete(id);
    setStatuses((old) => {
      if (!(id in old)) return old;
      const next = { ...old }; delete next[id]; return next;
    });
  }, []);
  const leave = useCallback((run: () => void | Promise<void>, scope?: string) => {
    if (dirtyEntries(scope).length) { transitioning.current = false; setError(""); setPending({ run, scope }); }
    else void run();
  }, [dirtyEntries]);
  const guardedNavigate = useCallback((to: string, committed?: () => void | Promise<void>) => {
    if (to === currentAddress) { if (committed) void committed(); return; }
    effect.current = committed ? { target: to, from: location.key, run: committed } : null;
    navigate(to);
  }, [currentAddress, location.key, navigate]);
  const value = useMemo(() => ({ update, remove, leave, navigate: guardedNavigate }), [update, remove, leave, guardedNavigate]);

  useEffect(() => {
    const queued = effect.current;
    if (!queued || queued.from === location.key) return;
    effect.current = null;
    if (queued.target === currentAddress) void Promise.resolve(queued.run()).catch(() => { /* The source page remains open if marking fails. */ });
  }, [location.key, currentAddress]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyEntries().length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyEntries]);

  const open = blocker.state === "blocked" || !!pending;
  const modalScope = blocker.state === "blocked" ? undefined : pending?.scope;
  const dirty = Object.values(statuses).filter((entry) => (!modalScope || entry.scope === modalScope) && (entry.dirty || entry.busy));
  const busy = saving || dirty.some((entry) => entry.busy);
  const canSave = dirty.length > 0 && dirty.every((entry) => entry.canSave);
  const stay = () => {
    if (saving) return;
    effect.current = null;
    setPending(null); setError("");
    if (blocker.state === "blocked") blocker.reset();
  };
  const proceed = useCallback(async () => {
    if (transitioning.current) return;
    transitioning.current = true;
    const action = pending;
    setPending(null); setError("");
    if (blocker.state === "blocked") blocker.proceed();
    if (action) await action.run();
  }, [pending, blocker]);
  useEffect(() => {
    // A later POP may revisit the same history key. End this cycle when it is
    // no longer blocked, but keep the in-flight latch for stale proceed calls.
    if (blocker.state !== "blocked") {
      lastBlockedKey.current = null;
      return;
    }
    if (lastBlockedKey.current !== blocker.location.key) {
      lastBlockedKey.current = blocker.location.key;
      transitioning.current = false;
    }
  }, [blocker]);
  useEffect(() => {
    // A normal successful create can redirect before its Formik baseline updates.
    // Resume that route once the committed editor state becomes clean.
    if (blocker.state === "blocked" && !saving && dirty.length === 0) {
      queueMicrotask(() => { void proceed(); });
    }
  }, [blocker.state, saving, dirty.length, proceed]);
  useEffect(() => {
    const target = dialog.current;
    if (!target || !open) return;
    if (typeof target.showModal === "function") { if (!target.open) target.showModal(); }
    else target.setAttribute("open", "");
    return () => { if (typeof target.close === "function" && target.open) target.close(); };
  }, [open]);
  const saveAndLeave = async () => {
    if (busy || !canSave) return;
    setSaving(true); setError("");
    try {
      for (const entry of dirtyEntries(modalScope)) {
        if (!entry.save || !await entry.save()) {
          setError("Изменения не сохранены. Проверьте поля формы и сообщения об ошибке.");
          return;
        }
      }
      await proceed();
    } catch {
      setError("Не удалось сохранить изменения. Ваш ввод остаётся на странице.");
    } finally { setSaving(false); }
  };
  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      {open && <dialog ref={dialog} className={s.dialog} aria-labelledby="unsaved-title" onCancel={(event) => { event.preventDefault(); stay(); }}>
        <h2 id="unsaved-title">Есть несохранённые изменения</h2>
        <p>Сохранить изменения перед выходом?</p>
        {dirty.some((entry) => entry.label) && <ul>{[...new Set(dirty.map((entry) => entry.label).filter(Boolean))].map((label) => <li key={label}>{label}</li>)}</ul>}
        {busy && <p role="status">Дождитесь окончания сохранения или загрузки файлов.</p>}
        {!canSave && !busy && <p>Для этой операции используйте кнопку в самой форме или выйдите без сохранения.</p>}
        {error && <p role="alert">{error}</p>}
        <div className={s.actions}>
          <button type="button" disabled={busy || !canSave} onClick={() => void saveAndLeave()}>Сохранить и перейти</button>
          <button type="button" disabled={busy} onClick={() => {
            for (const entry of dirtyEntries(modalScope)) entry.discard?.();
            void proceed();
          }}>Уйти без сохранения</button>
          <button type="button" disabled={saving} autoFocus onClick={stay}>Остаться</button>
        </div>
      </dialog>}
    </UnsavedChangesContext.Provider>
  );
}
