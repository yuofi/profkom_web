import { createContext, useContext } from "react";
import type { UserOut } from "./api/types";

export const UserContext = createContext<UserOut | null>(null);

const useUser = () => {
  return useContext(UserContext);
};

export const useMe = () => {
    const me = useUser();
    return me;
}