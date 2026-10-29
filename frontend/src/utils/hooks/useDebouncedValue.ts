import { useEffect, useState } from "react";

/** Keep the input/URL immediate while coalescing read-only search requests. */
export function useDebouncedValue(value: string, delay = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = window.setTimeout(() => setSettled(value), value ? delay : 0);
    return () => window.clearTimeout(timer);
  }, [value, settled, delay]);
  return value ? settled : "";
}
