import { useMemo } from "react";
import { useGuides } from "../../utils/hooks/useGuides";
import { getDocRoute } from "../../utils/routes";
import { Badge, Card, Empty, Loading, Page, RouteLink } from "../../components/Workspace/WorkspaceUI";
import s from "../../components/Workspace/Workspace.module.css";

export const GuidesPage = () => {
  const { data: guides, isLoading } = useGuides();

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

  return (
    <Page
      title="Гайды"
      description="Ранее сохранённые инструкции и материалы для каждого блока"
      actions={<RouteLink to="/materials">Все материалы</RouteLink>}
    >
      {isLoading ? (
        <Loading />
      ) : !guides || guides.length === 0 ? (
        <Empty>Гайды пока не добавлены</Empty>
      ) : (
        <div className={s.grid}>
          {sortedBlockKeys.map((blockKey) => {
            const blockGuides = groupedGuides[blockKey];
            return (
              <Card key={blockKey}>
                <div className={s.between}>
                  <h2>{blockKey === "Общие" ? "Общие гайды" : blockKey}</h2>
                  <Badge tone="rose">{blockGuides.length}</Badge>
                </div>
                <ul className={s.list}>
                  {blockGuides.map((guide) => (
                    <li key={guide.guide_id}>
                      <RouteLink to={getDocRoute(guide.guide_id)}>{guide.title}</RouteLink>
                      {guide.description && <p>{guide.description}</p>}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
};
