// client/src/services/authApi.ts

import { apiFetch } from "./apiClient";

export interface UsuarioPayload {
  id: string;
  tenantId: string;
  nombre: string;
  email: string;
  rol: "admin" | "operador" | "lectura";
  modulosPermitidos: string[];
}

async function parseOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Error HTTP ${res.status}`);
  }
  return data;
}

export async function loginApi(
  tenantSlug: string,
  email: string,
  password: string
): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, email, password }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function googleLoginApi(
  tenantSlug: string,
  credential: string
): Promise<UsuarioPayload> {
  const res = await apiFetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, credential }),
  });
  const data = await parseOrThrow(res);
  return data.usuario;
}

export async function forgotPasswordApi(tenantSlug: string, email: string): Promise<string> {
  const res = await apiFetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, email }),
  });
  const data = await parseOrThrow(res);
  return data.message;
}

export async function resetPasswordApi(token: string, newPassword: string): Promise<void> {
  const res = await apiFetch("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  await parseOrThrow(res);
}

export async function logoutApi(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
}

export async function ssoDisponibleApi(tenantSlug: string): Promise<boolean> {
  const res = await apiFetch(
    `/api/auth/sso-disponible?tenantSlug=${encodeURIComponent(tenantSlug)}`
  );
  const data = await parseOrThrow(res);
  return data.disponible;
}

/** No es un fetch: el login SSO es un redirect real de navegador (baile de
 *  Authorization Code con el IdP), no algo que se pueda resolver con XHR —
 *  el caller hace `window.location.href = ssoIniciarUrl(...)`. */
export function ssoIniciarUrl(tenantSlug: string): string {
  return `/api/auth/sso/iniciar?tenantSlug=${encodeURIComponent(tenantSlug)}`;
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
