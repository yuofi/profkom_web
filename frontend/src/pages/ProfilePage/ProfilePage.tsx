import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Helmet } from "react-helmet-async";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button/Button";
import { Icon } from "../../components/Icon";
import { ProfileBadge } from "../../components/ProfileBadge/ProfileBadge";
import { blocksApi } from "../../utils/api/blocks.api";
import type { BlockOut } from "../../utils/api/types";
import { demoBlocks, isDemoMode } from "../../utils/demoData";
import { filterRoles } from "../../utils/filterRoles";
import { useMe } from "../../utils/me";
import { getAdminTabRoute } from "../../utils/routes";
import styles from "./ProfilePage.module.css";

type WorkspaceSection = "blocks" | "events";

interface EventRole {
  event: string;
  role: string;
}

const sections: Array<{
  id: WorkspaceSection;
  label: string;
  icon: string;
}> = [
  { id: "blocks", label: "Блоки", icon: "diversity_3" },
  { id: "events", label: "Мероприятия", icon: "event" },
];

const isWorkspaceSection = (value: string | null): value is WorkspaceSection =>
  sections.some((section) => section.id === value);

const parseBlockNames = (value: string): Set<string> =>
  new Set(
    value
      .split(/[,;\n]+/)
      .map((block) => block.trim().toLocaleLowerCase("ru"))
      .filter(Boolean),
  );

const parseEventRoles = (raw?: string): EventRole[] => {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];

      const record = item as Record<string, unknown>;
      if (typeof record.event !== "string" || typeof record.role !== "string") {
        return [];
      }

      const event = record.event.trim();
      const role = record.role.trim();
      return event && role ? [{ event, role }] : [];
    });
  } catch {
    return [];
  }
};

const getBlockRole = (block: BlockOut, kkrName: string): string => {
  if (block.master === kkrName) return "мастер";
  if (block.hr === kkrName) return "HR";
  return "участник";
};

const formatMembers = (count: number): string => {
  const normalized = Math.abs(count) % 100;
  const lastDigit = normalized % 10;

  if (normalized >= 11 && normalized <= 19) return `${count} участников`;
  if (lastDigit === 1) return `${count} участник`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${count} участника`;
  return `${count} участников`;
};

export const ProfilePage = () => {
  const user = useMe();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get("section");
  const activeSection: WorkspaceSection = isWorkspaceSection(requestedSection)
    ? requestedSection
    : "events";

  const {
    data: blocks,
    isLoading: areBlocksLoading,
    isError: areBlocksError,
  } = useQuery({
    queryKey: ["blocks"],
    queryFn: blocksApi.getAll,
    enabled: Boolean(user) && !isDemoMode,
  });

  const availableBlocks = isDemoMode ? demoBlocks : blocks;

  const userBlocks = useMemo(() => {
    if (!user || !availableBlocks) return [];

    const membership = parseBlockNames(user.blocks || "");
    return availableBlocks
      .filter(
        (block) =>
          membership.has(block.name.trim().toLocaleLowerCase("ru")) ||
          block.master === user.kkr_name ||
          block.hr === user.kkr_name,
      )
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }, [availableBlocks, user]);

  const eventRoles = useMemo(
    () => parseEventRoles(user?.events_roles),
    [user?.events_roles],
  );

  const selectSection = (section: WorkspaceSection) => {
    if (section === "events") {
      setSearchParams({}, { replace: true });
      return;
    }

    setSearchParams({ section }, { replace: true });
  };

  if (!user) return null;

  return (
    <div className={styles.mainContainer}>
      <Helmet>
        <title>Личный кабинет | Профком ВМК</title>
      </Helmet>

      <main className={styles.dashboard}>
        <aside className={styles.profileColumn} aria-label="Профиль">
          <ProfileBadge user={user} readOnly={isDemoMode} compact />

          {filterRoles(["admin", "super_user"], user) && (
            <Button
              variant="primary"
              className={styles.adminButton}
              onClick={() => navigate(getAdminTabRoute("blocks"))}
            >
              <Icon name="admin_panel_settings" size={20} />
              админская панель
            </Button>
          )}
        </aside>

        <section className={styles.workspace} aria-label="Работа в профкоме">
          <nav className={styles.sectionNav} aria-label="Разделы личного кабинета">
            {sections.map((section) => {
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`${styles.sectionTab} ${isActive ? styles.sectionTabActive : ""}`}
                  aria-pressed={isActive}
                  onClick={() => selectSection(section.id)}
                >
                  <Icon name={section.icon} size={20} filled={isActive} />
                  <span>{section.label}</span>
                </button>
              );
            })}
          </nav>

          <div className={styles.contentCard}>
            {activeSection === "blocks" ? (
              <section aria-labelledby="blocks-heading">
                <div className={styles.sectionHeading}>
                  <div>
                    <h2 id="blocks-heading">Команды и роли</h2>
                    <p>Блоки, в которых вы состоите.</p>
                  </div>
                  <span className={styles.countBadge}>{userBlocks.length}</span>
                </div>

                {!isDemoMode && areBlocksLoading ? (
                  <div className={styles.stateBox}>
                    <Icon name="sync" size={28} />
                    <span>Загружаем блоки…</span>
                  </div>
                ) : !isDemoMode && areBlocksError ? (
                  <div className={styles.stateBox}>
                    <Icon name="error" size={28} />
                    <span>Не удалось загрузить блоки</span>
                  </div>
                ) : userBlocks.length === 0 ? (
                  <div className={styles.stateBox}>
                    <Icon name="group_off" size={32} />
                    <strong>Вы пока не состоите ни в одном блоке</strong>
                    <span>Когда вас добавят в команду, она появится здесь.</span>
                  </div>
                ) : (
                  <div className={styles.itemsList}>
                    {userBlocks.map((block) => (
                      <article className={styles.listItem} key={block.name}>
                        <div className={styles.itemIcon} aria-hidden="true">
                          <Icon name="groups" size={24} />
                        </div>
                        <div className={styles.itemInfo}>
                          <h3>{block.name}</h3>
                          <span>{formatMembers(block.cnt_of_human)}</span>
                        </div>
                        <span className={styles.roleBadge}>
                          {getBlockRole(block, user.kkr_name)}
                        </span>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <section aria-labelledby="events-heading">
                <div className={styles.sectionHeading}>
                  <div>
                    <h2 id="events-heading">Участие в организации</h2>
                    <p>Ваши мероприятия и назначенные роли.</p>
                  </div>
                  <span className={styles.countBadge}>{eventRoles.length}</span>
                </div>

                {eventRoles.length === 0 ? (
                  <div className={styles.stateBox}>
                    <Icon name="event_busy" size={32} />
                    <strong>Мероприятий пока нет</strong>
                    <span>Назначенные роли появятся в этом разделе.</span>
                  </div>
                ) : (
                  <div className={styles.itemsList}>
                    {eventRoles.map((item, index) => (
                      <article
                        className={styles.listItem}
                        key={`${item.event}-${item.role}-${index}`}
                      >
                        <div className={styles.itemIcon} aria-hidden="true">
                          <Icon name="calendar_month" size={24} />
                        </div>
                        <div className={styles.itemInfo}>
                          <h3>{item.event}</h3>
                          <span>Участие в организации</span>
                        </div>
                        <span className={styles.roleBadge}>{item.role}</span>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>

        </section>
      </main>
    </div>
  );
};
