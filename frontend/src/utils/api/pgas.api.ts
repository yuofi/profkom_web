import { api } from "./index";
import type { PgasEntryIn, PgasEntryOut } from "./types";

export const pgasApi = {
  getAll: async (): Promise<PgasEntryOut[]> => {
    const response = await api.get<PgasEntryOut[]>("/pgas");
    return response.data;
  },

  create: async (data: PgasEntryIn): Promise<PgasEntryOut> => {
    const response = await api.post<PgasEntryOut>("/pgas", data);
    return response.data;
  },

  delete: async (entryId: number): Promise<void> => {
    await api.delete(`/pgas/${entryId}`);
  },
};
