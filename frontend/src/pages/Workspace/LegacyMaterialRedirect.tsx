import { Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { materialsApi } from "../../utils/api/materials.api";
import { useSession } from "../../utils/session";
import { Page, QueryState } from "../../components/Workspace/WorkspaceUI";

/** Bookmarked guides always enter the current, initially read-only material screen. */
export function LegacyMaterialRedirect() {
  const { id = "" } = useParams(), { session } = useSession();
  const query = useQuery({ queryKey: ["material-legacy-guide", id, session?.user_id], queryFn: () => materialsApi.resolveLegacyGuide(id), enabled: !!id, retry: false });
  if (query.data && !query.error) return <Navigate to={`/materials/${encodeURIComponent(query.data.material_id)}`} replace />;
  return <Page title="Материал"><QueryState loading={query.isLoading} error={query.error} retry={() => void query.refetch()}>{null}</QueryState></Page>;
}
