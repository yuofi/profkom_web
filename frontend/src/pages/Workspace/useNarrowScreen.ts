import { useEffect, useState } from "react";

const narrowQuery = "(max-width: 768px)";
/** Phones get fewer calendar grid columns and the day view by default. */
export function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(narrowQuery).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(narrowQuery), listener = (event: MediaQueryListEvent) => setNarrow(event.matches);
    media.addEventListener("change", listener);return () => media.removeEventListener("change", listener);
  }, []);
  return narrow;
}
