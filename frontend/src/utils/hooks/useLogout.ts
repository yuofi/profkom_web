import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { endSession } from "../authSession";
import { userMessage } from "../api/messages";

/** What the login page is told after a sign-out on purpose: a note and the address (PE-21). */
export interface AuthNotice { notice: string; email?: string | null }

export function useLogout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logout = async (state?: AuthNotice) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await endSession(client);
      navigate("/auth", { replace: true, state });
    } catch (failure) {
      setError(`Не удалось завершить сессию. ${userMessage(failure)}`);
    } finally { setBusy(false); }
  };
  return { logout, busy, error };
}
