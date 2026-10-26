import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
} from "../../components/Workspace/WorkspaceUI";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { LegacyGuideNotice } from "../../components/Workspace/LegacyGuideNotice";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { guidesApi } from "../../utils/api/guides.api";
import { useMe } from "../../utils/me";
import type { GuideOut } from "../../utils/api/types";
function GuideEditor({ guide }: { guide: GuideOut }) {
  const [body, setBody] = useState(guide.text);
  const client = useQueryClient();
  return (
    <Card title="Редактирование документа">
      <LegacyGuideNotice />
      <ActionForm
        fields={[]}
        allowExitSave={false}
        externalState={body}
        savedExternalState={guide.text}
        submitLabel="Опубликовать изменения гайда"
        onSubmit={async () => {
          await guidesApi.update(guide.guide_id, {
            expected_revision: guide.revision,
            title: guide.title,
            text: body,
            owner_block: guide.owner_block,
          });
          await Promise.all([
            client.invalidateQueries({ queryKey: ["guide"] }),
            client.invalidateQueries({ queryKey: ["guides"] }),
          ]);
        }}
      >
        <MarkdownEditor value={body} onChange={setBody} draft={false} />
      </ActionForm>
    </Card>
  );
}
export function DocEditPage() {
  const user = useMe();
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: ["guide", id, user?.user_id ?? "anon"],
    queryFn: () => guidesApi.getById(id),
    enabled: !!id,
    retry: false,
  });
  if (query.data?.material_id) return <Navigate to={`/materials/${encodeURIComponent(query.data.material_id)}`} replace />;
  return (
    <Page
      title={query.data?.title ?? "Редактор"}
      actions={
        <RouteLink to={`/docs/${encodeURIComponent(id)}`}>
          К документу
        </RouteLink>
      }
    >
      <QueryState loading={query.isLoading} error={query.error}>
        {query.data && <GuideEditor key={id} guide={query.data} />}
      </QueryState>
    </Page>
  );
}
export default DocEditPage;
