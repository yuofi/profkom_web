import { useEffect } from "react";

/** A deadline requests fresh capabilities; it never grants them locally. */
export function useDeadlineRefresh(
  deadlines: string[],
  refresh: () => unknown,
) {
  const key = [...new Set(deadlines)].sort().join("|");
  useEffect(() => {
    const dates = key
      .split("|")
      .map(Date.parse)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    let index = dates.findIndex((date) => date > Date.now());
    if (index === -1) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const next = dates[index];
      if (next === undefined) return;
      timer = setTimeout(
        () => {
          if (Date.now() < next) schedule();
          else {
            void refresh();
            do {
              index++;
            } while (dates[index] <= Date.now());
            schedule();
          }
        },
        Math.min(Math.max(0, next - Date.now()), 2_147_483_647),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [key, refresh]);
}
