import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Page,
  Card,
  QueryState,
  RouteLink,
} from "../../components/Workspace/WorkspaceUI";
import { MarkdownEditor } from "../../components/Workspace/MarkdownEditor";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { guidesApi } from "../../utils/api/guides.api";
import { useMe } from "../../utils/me";
import type { GuideOut } from "../../utils/api/types";
function GuideEditor({ guide }: { guide: GuideOut }) {
  const [body, setBody] = useState(guide.text);
  const client = useQueryClient();
  return (
    <Card title="Редактирование документа">
      <ActionForm
        fields={[]}
        submitLabel="Сохранить документ"
        onSubmit={async () => {
          await guidesApi.update(guide.guide_id, {
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
        <MarkdownEditor value={body} onChange={setBody} />
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
