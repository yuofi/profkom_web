
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export const useGuides = () => {
  return useQuery({
    queryKey: ["guides"],
    queryFn: async () => {
      const response = await api.get("/guides");
      return response.data;
    },

    staleTime: 10 * 60 * 1000, 
  });
};