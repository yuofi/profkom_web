import { useQuery } from "@tanstack/react-query";
import { guidesApi } from "../api/guides.api";
import { useMe } from "../me";

export const useGuides = () => {
  const user = useMe();
  return useQuery({
    queryKey: ["guides", user?.user_id ?? "anon"],
    queryFn: guidesApi.getAll,
    staleTime: 5 * 60 * 1000,
  });
};