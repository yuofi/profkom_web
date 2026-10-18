import { RouteLink } from "./WorkspaceUI";
import s from "./Workspace.module.css";

export function LegacyGuideNotice() {
  return (
    <div className={s.warning} role="note">
      <p>
        В старых гайдах изменения сразу видны читателям. Отдельный черновик и
        отложенная публикация здесь пока недоступны.
      </p>
      <RouteLink to="/materials">
        Материалы с черновиками и публикацией
      </RouteLink>
    </div>
  );
}
