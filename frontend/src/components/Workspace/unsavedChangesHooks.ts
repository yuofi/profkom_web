import { createContext, useCallback, useContext, useId, useLayoutEffect } from "react";
import { useNavigate } from "react-router-dom";

export type Entry = {
  dirty: boolean;
  busy?: boolean;
  label?: string;
  scope?: string;
  save?: () => Promise<boolean>;
  discard?: () => void;
};
type Guard = {
  update: (id: string, entry: Entry) => void;
  remove: (id: string) => void;
  leave: (action: () => void | Promise<void>, scope?: string) => void;
  navigate: (to: string, committed?: () => void | Promise<void>) => void;
};
export const UnsavedChangesContext = createContext<Guard | null>(null);
export const UnsavedChangesScopeContext = createContext<string | undefined>(undefined);

/** Register editing state, including values kept outside Formik and pending uploads. */
export function useUnsavedChanges(entry: Entry) {
  const guard = useContext(UnsavedChangesContext);
  const id = useId();
  const scope = useContext(UnsavedChangesScopeContext);
  useLayoutEffect(() => { guard?.update(id, { ...entry, scope: entry.scope ?? scope }); });
  useLayoutEffect(() => () => guard?.remove(id), [guard, id]);
  return id;
}

/** Non-route exits, such as closing an editor dialog, use the same confirmation. */
export function useGuardedAction(explicitScope?: string) {
  const guard = useContext(UnsavedChangesContext);
  const scope = useContext(UnsavedChangesScopeContext);
  return useCallback((action: () => void | Promise<void>) => {
    if (guard) guard.leave(action, explicitScope ?? scope);
    else void action();
  }, [guard, explicitScope, scope]);
}

/** The callback runs only after a route really opens, including after confirmation. */
export function useConfirmedNavigation() {
  const guard = useContext(UnsavedChangesContext);
  const navigate = useNavigate();
  return useCallback((to: string, committed?: () => void | Promise<void>) => {
    if (guard) guard.navigate(to, committed);
    else {
      navigate(to);
      if (committed) queueMicrotask(() => { void committed(); });
    }
  }, [guard, navigate]);
}

