import { useQuery } from "@tanstack/react-query";
import { QueryState } from "../../components/Workspace/WorkspaceUI";
import { ActionForm } from "../../components/Workspace/ActionForm";
import { text } from "../../components/Workspace/formValues";
import { membershipApi } from "../../utils/api/membership.api";
import { can, useSession } from "../../utils/session";
import { useWorkspaceActions } from "../../utils/hooks/useWorkspace";

export function ParticipantCategoryPanel({ userId }: { userId: number }) {
  const { session } = useSession();
  const { perform, refresh } = useWorkspaceActions();
  const query = useQuery({
    queryKey: ["participantCategory", userId],
    queryFn: () => membershipApi.category(userId),
    enabled: can(session, "edit_participant_category"),
  });
  const category = query.data;
  if (!can(session, "edit_participant_category")) return null;
  return (
    <QueryState keepDataOnError={!!query.data}
        loading={query.isLoading} error={query.error}>
      {category && (
        <div>
          <p>
            Глобальная категория:{" "}
            {category.category === "junior" ? "Джуниор" : "Активист"}. Новичок
            отдельного блока — другая отметка.
          </p>
          {can(category, "edit_participant_category") && (
            <ActionForm
              key={category.user_id}
              revision={category.revision}
              changeRequired={["category"]}
              fields={[
                {
                  name: "category",
                  label: "Категория участника",
                  type: "select",
                  required: true,
                  value: category.category,
                  options: [
                    { value: "junior", label: "Джуниор" },
                    { value: "activist", label: "Активист" },
                  ],
                },
                {
                  name: "reason",
                  label: "Причина ручной смены",
                  type: "textarea",
                  required: true,
                },
              ]}
              onSubmit={async (v, expectedRevision) => {
                return perform(() =>
                  membershipApi.updateCategory(userId, {
                    expected_revision: expectedRevision!,
                    category: text(v, "category") as "junior" | "activist",
                    reason: text(v, "reason"),
                  }),
                );
              }}
              onConflict={refresh}
            />
          )}
        </div>
      )}
    </QueryState>
  );
}
