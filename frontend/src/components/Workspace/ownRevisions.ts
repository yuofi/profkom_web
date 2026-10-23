import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Revisions this app instance produced itself, per record ("event:<id>",
 * "assignment-inputs:<id>"). A successful command records from→to; every form of the same
 * record whose baseline is `from` may then move to `to` without a conflict banner (A-FE-2).
 * A revision someone else produced is never on such a chain, so it still stops the form.
 * One record key names one server counter: two counters of one object get two keys.
 * Chains belong to a QueryClient: one per tab, and one per simulated user in tests.
 */
interface Store { chains: Map<string, Map<number, number>>; listeners: Set<() => void>; version: number }
const stores = new WeakMap<QueryClient, Store>();
const store = (client: QueryClient) => {
  let s = stores.get(client);
  if (!s) stores.set(client, (s = { chains: new Map(), listeners: new Set(), version: 0 }));
  return s;
};
const notify = (s: Store) => { s.version++; s.listeners.forEach((listener) => listener()); };

export function recordOwnChange(client: QueryClient, record: string, from: number, to: number) {
  if (from === to) return;
  const s = store(client);
  const chain = s.chains.get(record) ?? new Map<number, number>();
  chain.set(from, to);
  s.chains.set(record, chain);
  notify(s);
}

/** The latest revision reachable from `revision` through own changes only. */
export function advanceOwn(client: QueryClient, record: string, revision: number) {
  const chain = store(client).chains.get(record);
  let current = revision;
  for (let steps = 0; chain?.has(current) && steps < 1000; steps++) current = chain.get(current)!;
  return current;
}

/** Another account signs in: its forms start from what it reads itself. */
export function forgetOwnChanges(client: QueryClient) {
  const s = store(client);
  s.chains.clear();
  notify(s);
}

/** The client of this form; re-renders it when another form records an own change. */
export function useOwnRevisions() {
  const client = useQueryClient();
  const s = store(client);
  useSyncExternalStore(
    (listener) => { s.listeners.add(listener); return () => s.listeners.delete(listener); },
    () => s.version,
    () => s.version,
  );
  return client;
}
