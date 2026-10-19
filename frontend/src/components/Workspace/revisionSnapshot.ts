/** A lossless, order-independent version vector for a replacing bulk command. */
export const revisionSnapshot = (items: { id: string; revision: number }[]) =>
  JSON.stringify(items.map(({ id, revision }) => [id, revision] as const)
    .sort(([a], [b]) => a.localeCompare(b)));

export const snapshotRevisions = (snapshot: string | undefined) =>
  new Map<string, number>(snapshot ? JSON.parse(snapshot) as [string, number][] : []);
