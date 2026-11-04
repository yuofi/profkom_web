import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { NotificationPreferences } from "../../components/Workspace/NotificationPreferences";
import { BotLinkStep } from "../../components/Workspace/BotLinkStep";
import { BOT_LINK_ANCHOR } from "../../components/Workspace/botLink";
import { Glyph, Page, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { displayDate } from "../../utils/dates";
import { getProfilePage } from "../../utils/routes";
import { useSession } from "../../utils/session";
import s from "../../components/Workspace/Workspace.module.css";

/** Own preferences remain separate from the public-facing profile overview. */
export function ProfileSettingsPage() {
  const { session } = useSession();
  const { hash } = useLocation();
  const deadline = session?.bot_link?.deadline;
  // The workspace reminder leads here: its block in view.
  useEffect(() => {
    if (hash === `#${BOT_LINK_ANCHOR}`) document.getElementById(BOT_LINK_ANCHOR)?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  return <Page title="Настройки профиля" description="Выберите, какие события и каналы уведомлений вам нужны." actions={<RouteLink to={getProfilePage()}><Glyph name="arrow_back" />К профилю</RouteLink>}>
    <div className={s.stack}>
      <BotLinkStep id={BOT_LINK_ANCHOR} lead={<p className={s.muted}>{deadline
        ? `Бот будет присылать уведомления сайта. Привязка обязательна с ${displayDate(deadline)}.`
        : "Бот будет присылать уведомления сайта в личные сообщения."}</p>} />
      <NotificationPreferences />
    </div>
  </Page>;
}
