import { api } from "./index";
import type { ContactInfoOut, ProfileUpdate, UserOut } from "./types";

export const contactsApi = {
  getAll: async (): Promise<ContactInfoOut[]> => {
    const response = await api.get<ContactInfoOut[]>("/contacts");
    return response.data;
  },

  update: async (userId: number, data: ProfileUpdate): Promise<UserOut> => {
    const response = await api.patch<UserOut>(`/profile/${userId}`, data);
    return response.data;
  },
};
