import { api } from "./index";
import type { BlockIn, BlockOut, BlockUpdate } from "./types";

export const blocksApi = {
  getAll: async (): Promise<BlockOut[]> => {
    const response = await api.get<BlockOut[]>("/blocks");
    return response.data;
  },

  create: async (data: BlockIn): Promise<BlockOut> => {
    const response = await api.post<BlockOut>("/blocks", data);
    return response.data;
  },

  update: async (blockName: string, data: BlockUpdate): Promise<BlockOut> => {
    const response = await api.patch<BlockOut>(`/blocks/${blockName}`, data);
    return response.data;
  },

  delete: async (blockName: string): Promise<void> => {
    await api.delete(`/blocks/${blockName}`);
  },

  enter: async (blockName: string): Promise<BlockOut> => {
    const response = await api.post<BlockOut>(`/blocks/${blockName}/enter`);
    return response.data;
  },

  exit: async (blockName: string): Promise<BlockOut> => {
    const response = await api.post<BlockOut>(`/blocks/${blockName}/exit`);
    return response.data;
  }
};