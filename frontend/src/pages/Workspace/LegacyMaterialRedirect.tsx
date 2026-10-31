import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { materialsApi } from "../../utils/api/materials.api";
import { normalizeApiError } from "../../utils/api/request";
import { getMaterialRoute } from "../../utils/routes";
import { useSession } from "../../utils/session";
import { Empty, Page, QueryState } from "../../components/Workspace/WorkspaceUI";
import s from "../../components/Workspace/Workspace.module.css";

/** Bookmarked guides always enter the current, initially read-only material screen. Old guide
 * links carry a number; a material id goes straight to its page, a missing guide is said so
 * without a retry (GL-28). */
export function LegacyMaterialRedirect() {
  const { id = "" } = useParams(), { session } = useSession(), legacy = /^\d+$/.test(id);
  const query = useQuery({ queryKey: ["material-legacy-guide", id, session?.user_id], queryFn: () => materialsApi.resolveLegacyGuide(id), enabled: legacy, retry: false });
  if (id && !legacy) return <Navigate to={getMaterialRoute(id)} replace />;
  if (query.data && !query.error) return <Navigate to={getMaterialRoute(query.data.material_id)} replace />;
  const missing = !id || (!!query.error && [403, 404, 422].includes(normalizeApiError(query.error).status));
  return <Page title="Материал">
    {missing ? <div role="alert"><Empty>Материал не найден или больше недоступен.</Empty></div> : <QueryState loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{null}</QueryState>}
    {!query.isLoading && <Link className={s.linkButton} to="/materials">Все материалы</Link>}
  </Page>;
}
