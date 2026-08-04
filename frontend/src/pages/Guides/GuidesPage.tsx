import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { GuideChip } from "../../components/ContactChip/GuideChip";
import { useGuides } from "../../utils/hooks/useGuides";
import { getDocRoute } from "../../utils/routes";
import { Icon } from "../../components/Icon";
import styles from "./GuidesPage.module.css";

export const GuidesPage = () => {
  const { data: guides, isLoading } = useGuides();
  const navigate = useNavigate();

  const handleGuideClick = (id: number) => {
    navigate(getDocRoute(id));
  };

  const groupedGuides = useMemo(() => {
    if (!guides) return {};

    const groups: Record<string, typeof guides> = {};

    guides.forEach((guide) => {
      const rawBlock = guide.owner_block?.trim();
      const isGlobal =
        !rawBlock ||
        rawBlock.toLowerCase() === "none" ||
        rawBlock.toLowerCase() === "all";
      const blockKey = isGlobal ? "Общие" : rawBlock;

      if (!groups[blockKey]) {
        groups[blockKey] = [];
      }
      if (guide.title !== "КМБ") {
        groups[blockKey].push(guide);
      }
    });

    return groups;
  }, [guides]);

  const sortedBlockKeys = useMemo(() => {
    const keys = Object.keys(groupedGuides);
    return keys.sort((a, b) => {
      if (a === "Общие") return -1;
      if (b === "Общие") return 1;
      return a.localeCompare(b);
    });
  }, [groupedGuides]);

  if (isLoading) {
    return (
      <div className={styles.guidesPage}>
        <div className={styles.emptyState}>
          <Icon name="sync" size={32} />
          <span>Загрузка гайдов...</span>
        </div>
      </div>
    );
  }

  if (!guides || guides.length === 0) {
    return (
      <div className={styles.guidesPage}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Гайды</h1>
        </div>
        <div className={styles.emptyState}>
          <Icon name="menu_book" size={48} />
          <span>Гайды пока не добавлены</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.guidesPage}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Гайды</h1>
        <p className={styles.pageSubtitle}>
          Полезные инструкции и материалы для каждого блока
        </p>
      </div>

      <div className={styles.columnsContainer}>
        {sortedBlockKeys.map((blockKey) => {
          const blockGuides = groupedGuides[blockKey];
          return (
            <div key={blockKey} className={styles.blockColumn}>
              <div className={styles.blockHeader}>
                <div className={styles.blockTitleWrapper}>
                  <h2 className={styles.blockTitle}>
                    {blockKey === "Общие" ? "Общие гайды" : `${blockKey}`}
                  </h2>
                </div>
                <span className={styles.blockBadge}>{blockGuides.length}</span>
              </div>

              <div className={styles.columnGuidesList}>
                {blockGuides.map((guide) => (
                  <GuideChip
                    key={guide.guide_id}
                    title={guide.title}
                    description={guide.description}
                    owner_block={guide.owner_block}
                    onClick={() => handleGuideClick(guide.guide_id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
