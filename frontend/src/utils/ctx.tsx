import { authApi } from "./api/auth.api";
import { useQuery } from "@tanstack/react-query";
import { UserContext } from "./me";
import { demoUser, isDemoMode } from "./demoData";


export const UserProvider = ({ children }: { children: React.ReactNode }) => {
  const { data, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: authApi.getMe,
    retry: false,
    enabled: !isDemoMode,
  });

  if (!isDemoMode && isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <UserContext.Provider value={isDemoMode ? demoUser : data?.data || null}>
      {children}
    </UserContext.Provider>
  );
};
