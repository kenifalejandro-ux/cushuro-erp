/** src/server/services/platformAdminSso.service.ts
 *
 * SSO de Platform Admin — un solo proveedor OIDC global (config en env,
 * ver PLATFORM_SSO_* en env.ts), a diferencia del SSO por tenant
 * (tenantSso.service.ts) que sí necesita un proveedor por empresa. Mismo
 * criterio de "no auto-registro" que el resto del SSO: solo resuelve a un
 * platform_admins YA existente (alta manual vía POST /api/platform/admins).
 *
 * Reutiliza la infraestructura de sesión de plataforma ya existente
 * (crearSesion de platformSession.service.ts) — SSO solo cambia CÓMO se
 * resuelve el admin, la sesión que se crea después es idéntica a la de
 * /admin-sesion (mismo actor `platform_admin`, misma cookie, mismo TTL).
 */
import { pool } from "../config/database";
import { env } from "../config/env";
import { AppError } from "../shared/middlewares/error.middleware";
import type { PlatformAdmin } from "./platformAdminAccount.service";
import {
  descubrirConfiguracion,
  construirUrlAutorizacion,
  intercambiarCodigoPorClaims,
  type ClaimsOidc,
} from "./platformOidc.service";
import { guardarFlujo, tomarFlujo } from "./platformSsoFlow.service";
import * as client from "openid-client";

export function ssoDisponibleParaPlatformAdmin(): boolean {
  return !!(env.platformSsoIssuerUrl && env.platformSsoClientId && env.platformSsoClientSecret);
}

function baseUrlCallback(): string {
  return `${env.appPublicUrl}/api/platform/sso/callback`;
}

function requerirConfigurado() {
  if (!ssoDisponibleParaPlatformAdmin()) {
    throw new AppError(503, "SSO de Platform Admin no está configurado");
  }
}

export interface InicioSso {
  redirectUrl: string;
}

export async function iniciarSsoPlatformAdminService(): Promise<InicioSso> {
  requerirConfigurado();

  const oidcConfig = await descubrirConfiguracion(
    env.platformSsoIssuerUrl,
    env.platformSsoClientId,
    env.platformSsoClientSecret
  );

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const nonce = client.randomNonce();

  const state = await guardarFlujo({ contexto: "platform_admin", codeVerifier, nonce });

  const url = construirUrlAutorizacion(oidcConfig, {
    redirectUri: baseUrlCallback(),
    state,
    nonce,
    codeChallenge,
  });

  return { redirectUrl: url.href };
}

/** Igual criterio de linking que tenantSso.service.ts: primer login SSO
 *  exitoso vincula por email si el admin todavía no tiene sso_subject de
 *  este proveedor; de ahí en más entra siempre por (sso_provider,
 *  sso_subject). */
async function resolverAdminSso(claims: ClaimsOidc): Promise<PlatformAdmin> {
  if (!claims.email || !claims.emailVerificado) {
    throw new AppError(401, "Tu proveedor de identidad no confirma un email verificado");
  }

  const porSubject = await pool.query(
    `SELECT id, email, nombre, rol, activo, creado_en AS "creadoEn"
     FROM platform_admins WHERE sso_provider = 'oidc' AND sso_subject = $1 AND activo = true`,
    [claims.sub]
  );
  if (porSubject.rows[0]) return porSubject.rows[0];

  const linkeado = await pool.query(
    `UPDATE platform_admins SET sso_provider = 'oidc', sso_subject = $1
     WHERE email = $2 AND activo = true AND sso_provider IS NULL
     RETURNING id, email, nombre, rol, activo, creado_en AS "creadoEn"`,
    [claims.sub, claims.email]
  );
  if (linkeado.rows[0]) return linkeado.rows[0];

  throw new AppError(401, "Esta cuenta no tiene acceso al panel de plataforma");
}

export interface ResultadoCallbackSsoAdmin {
  admin: PlatformAdmin;
  claims: ClaimsOidc;
}

export async function manejarCallbackSsoPlatformAdminService(
  state: string,
  currentUrl: URL
): Promise<ResultadoCallbackSsoAdmin> {
  requerirConfigurado();

  const flujo = await tomarFlujo(state);
  if (!flujo || flujo.contexto !== "platform_admin") {
    throw new AppError(401, "El enlace de inicio de sesión expiró o ya se usó — intentá de nuevo");
  }

  const oidcConfig = await descubrirConfiguracion(
    env.platformSsoIssuerUrl,
    env.platformSsoClientId,
    env.platformSsoClientSecret
  );

  const claims = await intercambiarCodigoPorClaims(oidcConfig, currentUrl, {
    codeVerifier: flujo.codeVerifier,
    state,
    nonce: flujo.nonce,
  });

  const admin = await resolverAdminSso(claims);
  return { admin, claims };
}
