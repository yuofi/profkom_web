import { authApi } from "./api/auth.api";
import { useQuery } from "@tanstack/react-query";
import { UserContext } from "./me";


export const UserProvider = ({ children }: { children: React.ReactNode }) => {
  const { data, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: authApi.getMe,
    retry: false,
  });

  if (isLoading) {
    return <div>Loading...</div>;
  }

  // if (isError) {
  //   return <div>Error loading user data</div>;
  // }

  return (
    <UserContext.Provider value={data?.data || null}>
      {children}
    </UserContext.Provider>
  );
};