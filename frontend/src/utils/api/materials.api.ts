import type { Material, MaterialText, Revision } from "./contract";
import { idPath, allPages as page, request } from "./request";
export const materialsApi = {
  resolveLegacyGuide: (id: string | number) => request<{ guide_id: number; material_id: string; revision: number }>("get", `/materials/legacy-guides/${idPath(id)}`),
  list: () => page<Material>("/materials"),
  get: (id: string) => request<Material>("get", `/materials/${idPath(id)}`),
  create: (data: {
    kind: string;
    owner_block_id?: string;
    title: string;
    description: string;
    content: MaterialText;
    original_link?: string;
  }) => request<Material>("post", "/materials", data),
  update: (
    id: string,
    data: Revision & {
      title?: string;
      description?: string;
      content?: MaterialText;
      original_link?: string | null;
    },
  ) => request<Material>("patch", `/materials/${idPath(id)}`, data),
  /** Placement is changed separately, without creating or publishing a content draft. */
  catalogSection: (id: string, catalog_section: "guide" | "general" | null, data: Revision) =>
    request<Material>("patch", `/materials/${idPath(id)}`, { ...data, catalog_section }),
  preview: (id: string, data: Revision & { content: MaterialText }, signal?: AbortSignal) =>
    request<MaterialText>("post", `/materials/${idPath(id)}/preview`, data, undefined, signal),
  publish: (id: string, data: Revision) =>
    request<Material>("post", `/materials/${idPath(id)}/publish`, data),
  /** Delete is revision-safe like every other command (GL-27). */
  remove: (id: string, data: Revision) => request<void>("delete", `/materials/${idPath(id)}`, data),
  deleted: () => page<Material>("/materials/deleted"),
  restore: (id: string, data: Revision) =>
    request<Material>("post", `/materials/${idPath(id)}/restore`, data),
  audience: (id: string, audience: "block" | "everyone" | "leadership", data: Revision) =>
    request<Material>("put", `/materials/${idPath(id)}/audience`, { audience, ...data }),
  editors: (id: string, user_ids: number[], data: Revision) =>
    request<{
      material_id: string;
      editor_user_ids: number[];
      revision: number;
    }>("put", `/materials/${idPath(id)}/editors`, { user_ids, ...data }),
};
