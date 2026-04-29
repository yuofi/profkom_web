import { api } from "./index";
import type { ContactInfoOut } from "./types";

export const contactsApi = {
  getAll: async (): Promise<ContactInfoOut[]> => {
    const response = await api.get<ContactInfoOut[]>("/contacts");
    return response.data;
  },
};
