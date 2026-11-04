import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { displayDate } from "../../utils/dates";
import { getProfileSettingsRoute } from "../../utils/routes";
import { isWorkingSession, useSession } from "../../utils/session";
import { BOT_LINK_ANCHOR } from "./botLink";
import s from "./Workspace.module.css";
import b from "./BotLinkBanner.module.css";

const DISMISSED = "profkom-bot-link-banner";
const dismissed = () => { try { return sessionStorage.getItem(DISMISSED) === "1"; } catch { return false; } };

/** Before the deadline an active account without a working VK link sees a reminder in the
 *  workspace; it leads to the bot block of the profile settings and can be hidden for this
 *  tab. After the deadline the gate page takes its place (session.bot_link.blocked). */
export function BotLinkBanner() {
  const { session } = useSession();
  const { pathname } = useLocation();
  const [hidden, setHidden] = useState(dismissed);
  const link = session?.bot_link;
  if (!link || link.state === "ok" || link.blocked || hidden || !isWorkingSession(session)) return null;
  if (pathname === getProfileSettingsRoute()) return null;
  const until = link.deadline ? ` до ${displayDate(link.deadline)}` : "";
  const text = link.state === "none"
    ? (until ? `Привяжите бота ВКонтакте${until}.` : "Привяжите бота ВКонтакте: скоро это станет обязательным.")
    : (until ? `Бот ВКонтакте настроен не до конца: исправьте${until}.` : "Бот ВКонтакте настроен не до конца: скоро привязка станет обязательной.");
  return (
    <p role="note" className={s.warning}>
      {text}{" "}
      <Link to={`${getProfileSettingsRoute()}#${BOT_LINK_ANCHOR}`}>{link.state === "none" ? "Привязать" : "Исправить"}</Link>{" "}
      <button type="button" className={b.dismiss} onClick={() => { try { sessionStorage.setItem(DISMISSED, "1"); } catch { /* storage unavailable */ } setHidden(true); }}>Скрыть</button>
    </p>
  );
}
