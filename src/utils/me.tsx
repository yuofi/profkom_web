import { createContext, useContext } from "react";
import type { MeOut } from "./api/types";

export const UserContext = createContext<MeOut | null>(null);

const useUser = () => {
  return useContext(UserContext);
};

export const useMe = () => {
    const me = useUser();
    return me;
}