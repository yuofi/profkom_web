import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { endSession } from "../authSession";
import { userMessage } from "../api/messages";

export function useLogout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logout = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await endSession(client);
      navigate("/auth", { replace: true });
    } catch (failure) {
      setError(`Не удалось завершить сессию. ${userMessage(failure)}`);
    } finally { setBusy(false); }
  };
  return { logout, busy, error };
}
