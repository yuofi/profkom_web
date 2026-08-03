import { api } from "./index";
import type { GuideIn, GuideOut, GuideUpdate } from "./types";

export const guidesApi = {
  getAll: async (): Promise<GuideOut[]> => {
    const response = await api.get<GuideOut[]>("/guides");
    return response.data;
  },

  getById: async (id: number | string): Promise<GuideOut> => {
    const response = await api.get<GuideOut>(`/guides/${id}`);
    return response.data;
  },

  create: async (data: GuideIn): Promise<GuideOut> => {
    const response = await api.post<GuideOut>("/guides", data);
    return response.data;
  },

  update: async (id: number | string, data: GuideUpdate | Partial<GuideOut>): Promise<GuideOut> => {
    const response = await api.post<GuideOut>(`/guides/${id}`, data);
    return response.data;
  },

  delete: async (id: number | string): Promise<void> => {
    await api.delete(`/guides/${id}`);
  },
};
