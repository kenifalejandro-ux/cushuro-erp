/** src/server/services/platformOidc.service.ts
 *
 * Wrapper delgado sobre `openid-client` (v6, API funcional) — el único
 * punto del código que sabe cómo hablar OIDC de verdad (discovery,
 * Authorization Code + PKCE, validación de id_token). tenantSso.service.ts
 * y platformAdminSso.service.ts arman el "para qué" (qué tenant, qué
 * usuario resolver); este archivo es solo el "cómo" del protocolo, para
 * poder reusarlo igual entre los dos flujos (SSO de tenant y SSO de
 * Platform Admin) sin duplicar la parte que si se hace mal es un agujero
 * de seguridad (validación de state/nonce/PKCE).
 */
import * as client from "openid-client";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";

// La configuración descubierta (metadata del issuer + JWKS) no cambia
// seguido — cachearla evita una ronda de discovery por cada intento de
// login. TTL corto igual (no es una clave/secreto, solo evita golpear el
// endpoint de discovery del IdP en cada request).
const TTL_CACHE_MS = 10 * 60_000;
const cacheConfiguracion = new Map<string, { config: client.Configuration; expiraEn: number }>();

export async function descubrirConfiguracion(
  issuerUrl: string,
  clientId: string,
  clientSecret: string
): Promise<client.Configuration> {
  const clave = `${issuerUrl}::${clientId}`;
  const cacheado = cacheConfiguracion.get(clave);
  if (cacheado && cacheado.expiraEn > Date.now()) return cacheado.config;

  let config: client.Configuration;
  try {
    config = await client.discovery(new URL(issuerUrl), clientId, clientSecret);
  } catch (err) {
    logger.warn({ err, issuerUrl }, "No se pudo descubrir la configuración OIDC del proveedor");
    throw new AppError(502, "No se pudo conectar con el proveedor de identidad");
  }

  cacheConfiguracion.set(clave, { config, expiraEn: Date.now() + TTL_CACHE_MS });
  return config;
}

/** Invalida la config cacheada de un issuer/client — para cuando se
 *  reconfigura el SSO de un tenant (client_secret rotado, etc.) y no hace
 *  falta esperar a que el TTL expire solo. */
export function invalidarCacheConfiguracion(issuerUrl: string, clientId: string): void {
  cacheConfiguracion.delete(`${issuerUrl}::${clientId}`);
}

export interface ParametrosAutorizacion {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function construirUrlAutorizacion(
  config: client.Configuration,
  params: ParametrosAutorizacion
): URL {
  return client.buildAuthorizationUrl(config, {
    redirect_uri: params.redirectUri,
    scope: "openid email profile",
    response_type: "code",
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
}

export interface ClaimsOidc {
  sub: string;
  email: string | undefined;
  emailVerificado: boolean;
}

/** Intercambia el `code` recibido en el callback por tokens y valida el
 *  id_token (firma, issuer, audience, exp, nonce — todo lo hace
 *  openid-client internamente). `currentUrl` es la URL completa del
 *  callback tal como llegó (con `code`/`state` en la query), necesaria
 *  para que la librería valide que coincide con lo que se armó al
 *  redirigir al usuario. */
export async function intercambiarCodigoPorClaims(
  config: client.Configuration,
  currentUrl: URL,
  checks: { codeVerifier: string; state: string; nonce: string }
): Promise<ClaimsOidc> {
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
    });
  } catch (err) {
    logger.warn({ err }, "Intercambio de código OIDC rechazado por el proveedor");
    throw new AppError(401, "No se pudo verificar tu identidad con el proveedor SSO");
  }

  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== "string") {
    throw new AppError(401, "El proveedor de identidad no devolvió una identidad válida");
  }

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email.toLowerCase() : undefined,
    emailVerificado: claims.email_verified === true,
  };
}
