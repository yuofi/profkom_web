import { useState, type ReactNode } from "react";
import s from "./ChipFace.module.css";
const fallbackAvatar = "/avatars/default.svg";
function safeAvatar(source: string | null | undefined): string | null {
  if (!source) return null;
  try {
    const url = new URL(source, window.location.origin);
    return ["http:", "https:"].includes(url.protocol) && (url.origin === window.location.origin || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ? source : null;
  } catch { return null; }
}
export function ChipInitials({ name, className = "" }: { name: string; className?: string }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const text = words.slice(0, 2).map(word => [...word][0]).join("").toLocaleUpperCase("ru") || "•";
  return <span className={`${s.initials} ${className}`} aria-hidden="true">{text}</span>;
}
export function ChipAvatar({ src, large = false, fallback, className = "" }: { src?: string | null; large?: boolean; fallback?: ReactNode; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const safe = safeAvatar(src), unavailable = !safe || failed === safe;
  if (unavailable && fallback) return <span className={`${s.fallback} ${large ? s.large : ""} ${className}`}>{fallback}</span>;
  const shown = unavailable ? fallbackAvatar : safe;
  return <img className={`${s.avatar} ${large ? s.large : ""} ${className}`} src={shown} alt="" loading="lazy" referrerPolicy="no-referrer"
    onError={event => { if (shown !== fallbackAvatar) setFailed(shown);else if (event.currentTarget.getAttribute("src") !== fallbackAvatar) event.currentTarget.src = fallbackAvatar; }} />;
}
export interface ChipFaceProps { label: ReactNode; avatarUrl?: string | null; avatarFallback?: ReactNode; icon?: ReactNode; className?: string }
/** Pure identity presentation: no links, buttons, preview or domain data reads. */
export function ChipFace({ label, avatarUrl, avatarFallback, icon, className = "" }: ChipFaceProps) {
  const avatar = avatarUrl !== undefined || !!avatarFallback;
  return <span className={`${s.face} ${avatar || icon ? s.withIcon : ""} ${className}`}>
    {avatar ? <ChipAvatar src={avatarUrl} fallback={avatarFallback} /> : icon && <span className={s.icon} aria-hidden="true">{icon}</span>}
    <span className={s.label}>{label}</span>
  </span>;
}
