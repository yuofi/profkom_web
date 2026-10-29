import { NotificationPreferences } from "../../components/Workspace/NotificationPreferences";
import { Glyph, Page, RouteLink } from "../../components/Workspace/WorkspaceUI";
import { getProfilePage } from "../../utils/routes";

/** Own preferences remain separate from the public-facing profile overview. */
export function ProfileSettingsPage() {
  return <Page title="Настройки профиля" description="Выберите, какие события и каналы уведомлений вам нужны." actions={<RouteLink to={getProfilePage()}><Glyph name="arrow_back" />К профилю</RouteLink>}>
    <NotificationPreferences />
  </Page>;
}
