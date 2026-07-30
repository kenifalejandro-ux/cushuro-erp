/** src/server/shared/middlewares/auth.middleware.ts */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { pool } from "../../config/database";
import { getRedis } from "../../config/redis";
import { logger } from "../../config/logger";
import type { UsuarioPayload } from "../../services/auth.service";
import { requerirJwtSecret } from "../utils/jwt-secret";
import { getCachedTokenVersion, setCachedTokenVersion } from "../utils/token-version-cache";

const JWT_SECRET = requerirJwtSecret();

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // Sesión de navegador: cookie httpOnly (no accesible por JS, a salvo de robo por XSS).
    // Header Bearer: vía alterna para clientes no-navegador (scripts, integraciones API).
    const authHeader = req.headers.authorization;
    const tokenCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[env.authCookieName];
    const tokenHeader = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : undefined;
    const token = tokenCookie || tokenHeader;

    if (!token) {
      return res.status(401).json({ ok: false, message: "Token no proporcionado" });
    }

    const payload = jwt.verify(token, JWT_SECRET) as UsuarioPayload;

    // token_version: única verificación de revocación que no depende de
    // Redis. Se cachea 60s (ver token-version-cache.ts) para no consultar
    // Postgres en cada request; ese es el retraso máximo con el que se
    // propaga un logout o una revocación de admin.
    let versionActual = await getCachedTokenVersion(payload.id);
    if (versionActual === undefined) {
      const resultado = await pool.query(
        `SELECT token_version FROM usuarios WHERE id = $1 AND activo = true`,
        [payload.id]
      );
      if (resultado.rows.length === 0) {
        return res.status(401).json({ ok: false, message: "Sesión inválida" });
      }
      const versionDesdeBd: number = resultado.rows[0].token_version;
      versionActual = versionDesdeBd;
      await setCachedTokenVersion(payload.id, versionDesdeBd);
    }

    if (payload.tokenVersion !== versionActual) {
      return res.status(401).json({ ok: false, message: "Sesión inválida, inicia sesión nuevamente" });
    }

    const redis = getRedis();
    if (redis) {
      try {
        const sesionToken = await redis.get(`session:${payload.id}`);
        if (!sesionToken || sesionToken !== token) {
          return res.status(401).json({ ok: false, message: "Sesión expirada o inválida" });
        }
      } catch (err) {
        logger.warn({ err }, "Error al verificar sesión en Redis, continuando sin Redis");
      }
    }

    req.usuario = payload;
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ ok: false, message: "Token expirado" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ ok: false, message: "Token inválido" });
    }
    logger.error({ err }, "Error en authMiddleware");
    return res.status(500).json({ ok: false, message: "Error de autenticación" });
  }
}
