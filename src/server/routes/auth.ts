/** src/server/routes/auth.ts */

import { Router, type Response } from "express";
import { env } from "../config/env";
import { validate } from "../middleware/validate";
import rateLimiter from "../middleware/rateLimiter";
import loginEmailRateLimiter from "../middleware/loginEmailRateLimiter";
import forgotPasswordEmailRateLimiter from "../middleware/forgotPasswordEmailRateLimiter";
import { verifyRecaptcha } from "../middleware/verifyRecaptcha";
import { resolveTenantSubdomain } from "../middleware/resolveTenantSubdomain";
import {
  loginSchema,
  googleLoginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  type LoginInput,
  type GoogleLoginInput,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from "../schemas/auth.schema";
import {
  loginService,
  googleLoginService,
  logoutService,
  refrescarTokenService,
  solicitarRecuperacionService,
  restablecerPasswordService,
  aPublico,
} from "../services/auth.service";
import {
  ssoDisponibleParaTenantService,
  iniciarSsoTenantService,
  manejarCallbackSsoTenantService,
} from "../services/tenantSso.service";
import { getClientIp, getRequestId, getUserAgent } from "../shared/utils/request";
import { authMiddleware } from "../shared/middlewares/auth.middleware";
import { asyncHandler } from "../shared/utils/asyncHandler";

export const authRouter = Router();

const REFRESH_COOKIE_NAME = `${env.authCookieName}_refresh`;
// Solo se envía a /api/auth/* (login, refresh, logout) — nunca al resto de
// la API, así que aunque un endpoint de negocio tenga un bug que refleje
// cookies en una respuesta, el refresh token no queda expuesto por ahí.
const REFRESH_COOKIE_PATH = "/api/auth";

/** Cookie httpOnly: invisible para JS del navegador (a salvo de robo por
 *  XSS). SameSite=strict basta si frontend y API viven en el mismo origen
 *  (proxy de Vite en dev, mismo dominio detrás de un solo host en prod). */
function setCookieSesion(res: Response, token: string) {
  res.cookie(env.authCookieName, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "strict",
    // El navegador puede conservar la cookie más tiempo del que el JWT
    // dentro es válido (JWT_EXPIRES, 30 min) — eso está bien: cuando el
    // JWT expira, authMiddleware responde 401 y el frontend debe llamar a
    // /api/auth/refresh para obtener uno nuevo con este mismo maxAge.
    maxAge: env.sessionTtlSeconds * 1000,
    path: "/",
  });
}

function setCookieRefresh(res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "strict",
    maxAge: env.sessionTtlSeconds * 1000,
    path: REFRESH_COOKIE_PATH,
  });
}

function limpiarCookiesSesion(res: Response) {
  res.clearCookie(env.authCookieName, { path: "/" });
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

authRouter.post(
  "/login",
  rateLimiter,
  resolveTenantSubdomain,
  validate(loginSchema),
  loginEmailRateLimiter,
  ...(env.isProduction ? [verifyRecaptcha] : []),
  asyncHandler(async (req, res, next) => {
    try {
      const result = await loginService(req.validatedBody as LoginInput);
      setCookieSesion(res, result.token);
      setCookieRefresh(res, result.refreshToken);
      res.status(200).json({ ok: true, usuario: aPublico(result.usuario) });
    } catch (err) {
      // Se delega al errorHandler central: solo expone err.message cuando es
      // un AppError deliberado (ej. "Credenciales inválidas"); cualquier otro
      // error queda oculto detrás de un mensaje genérico, nunca el mensaje
      // crudo de la BD u otra dependencia interna.
      next(err);
    }
  })
);

authRouter.post(
  "/google",
  rateLimiter,
  resolveTenantSubdomain,
  validate(googleLoginSchema),
  asyncHandler(async (req, res, next) => {
    try {
      const result = await googleLoginService(req.validatedBody as GoogleLoginInput);
      setCookieSesion(res, result.token);
      setCookieRefresh(res, result.refreshToken);
      res.status(200).json({ ok: true, usuario: aPublico(result.usuario) });
    } catch (err) {
      next(err);
    }
  })
);

// ── SSO por tenant (OIDC) ────────────────────────────────────────────────
// Separado del resto (login/google) porque es un baile de redirects reales
// de navegador, no un POST con JSON — ver tenantSso.service.ts.

authRouter.get(
  "/sso-disponible",
  rateLimiter,
  resolveTenantSubdomain,
  asyncHandler(async (req, res, next) => {
    try {
      const tenantSlug = (
        (req.body as { tenantSlug?: string })?.tenantSlug ||
        (req.query.tenantSlug as string) ||
        ""
      ).trim();
      if (!tenantSlug) return res.status(200).json({ ok: true, disponible: false });
      const disponible = await ssoDisponibleParaTenantService(tenantSlug);
      res.status(200).json({ ok: true, disponible });
    } catch (err) {
      next(err);
    }
  })
);

authRouter.get(
  "/sso/iniciar",
  rateLimiter,
  resolveTenantSubdomain,
  asyncHandler(async (req, res, next) => {
    try {
      const tenantSlug = (
        (req.body as { tenantSlug?: string })?.tenantSlug ||
        (req.query.tenantSlug as string) ||
        ""
      ).trim();
      if (!tenantSlug) {
        return res.status(400).json({ ok: false, message: "Falta identificar la empresa" });
      }
      const { redirectUrl } = await iniciarSsoTenantService(tenantSlug);
      res.redirect(redirectUrl);
    } catch (err) {
      next(err);
    }
  })
);

authRouter.get(
  "/sso/callback",
  rateLimiter,
  asyncHandler(async (req, res) => {
    const contexto = {
      ip: getClientIp(req),
      requestId: getRequestId(req),
      userAgent: getUserAgent(req),
      actorType: "unauthenticated" as const,
      actorLabel: "sso-tenant",
    };

    try {
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const currentUrl = new URL(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
      const resultado = await manejarCallbackSsoTenantService(state, currentUrl, contexto);

      setCookieSesion(res, resultado.token);
      setCookieRefresh(res, resultado.refreshToken);
      res.redirect(resultado.urlDestino);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "No se pudo iniciar sesión con SSO";
      res.redirect(`${env.appPublicUrl}/login?ssoError=${encodeURIComponent(mensaje)}`);
    }
  })
);

authRouter.post(
  "/refresh",
  rateLimiter,
  asyncHandler(async (req, res, next) => {
    try {
      const refreshTokenCookie = (req as typeof req & { cookies?: Record<string, string> })
        .cookies?.[REFRESH_COOKIE_NAME];

      if (!refreshTokenCookie) {
        return res
          .status(401)
          .json({ ok: false, message: "Sesión inválida, inicia sesión nuevamente" });
      }

      const result = await refrescarTokenService(refreshTokenCookie);
      setCookieSesion(res, result.token);
      setCookieRefresh(res, result.refreshToken);
      res.status(200).json({ ok: true, usuario: aPublico(result.usuario) });
    } catch (err) {
      // Si el refresh falla (token inválido, reusado o expirado) las
      // cookies ya no sirven — se limpian para que el frontend redirija
      // a /login en vez de reintentar con las mismas cookies muertas.
      limpiarCookiesSesion(res);
      next(err);
    }
  })
);

authRouter.post(
  "/forgot-password",
  rateLimiter,
  resolveTenantSubdomain,
  validate(forgotPasswordSchema),
  forgotPasswordEmailRateLimiter,
  asyncHandler(async (req, res, next) => {
    try {
      const result = await solicitarRecuperacionService(req.validatedBody as ForgotPasswordInput);
      res.status(200).json({ ok: true, message: result.message });
    } catch (err) {
      next(err);
    }
  })
);

authRouter.post(
  "/reset-password",
  rateLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res, next) => {
    try {
      await restablecerPasswordService(req.validatedBody as ResetPasswordInput);
      res.status(200).json({ ok: true, message: "Contraseña actualizada correctamente" });
    } catch (err) {
      next(err);
    }
  })
);

authRouter.post(
  "/logout",
  rateLimiter,
  authMiddleware,
  asyncHandler(async (req, res, next) => {
    try {
      await logoutService(req.usuario!.id, req.usuario!.tenantId);
      limpiarCookiesSesion(res);
      res.status(200).json({ ok: true, message: "Sesión cerrada correctamente" });
    } catch (err) {
      next(err);
    }
  })
);

authRouter.get("/me", rateLimiter, authMiddleware, (req, res) => {
  res.status(200).json({ ok: true, usuario: aPublico(req.usuario!) });
});
