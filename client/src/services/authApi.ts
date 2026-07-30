// client/src/services/authApi.ts

import { apiFetch } from "./apiClient";

export interface UsuarioPayload {
  id: string;
  tenantId: string;
  nombre: string;
  email: string;
  rol: "admin" | "operador" | "lectura";
}

async function parseOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Error HTTP ${res.status}`);
  }
  return data;
}

export async function loginApi(email: string, password: string): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function logoutApi(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}

export async function getMeApi(): Promise<UsuarioPayload> {
  // Si el access token ya expiró (usuario dejó la pestaña abierta más de
  // 30 min), apiFetch intenta /api/auth/refresh solo y reintenta antes de
  // rendirse — así no se fuerza un re-login mientras el refresh token siga
  // vigente (hasta 30 días).
  const res = await apiFetch("/api/auth/me");
  const data = await parseOrThrow(res);
  return data.usuario;
}
