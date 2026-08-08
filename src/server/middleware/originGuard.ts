import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { getClientIp, getRequestId } from "../shared/utils/request";

function isAllowedOrigin(origin?: string) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    // Solo se relaja el origin en desarrollo: permitirlo también en
    // producción abriría la API (con credentials:true, es decir cookies de
    // sesión) a cualquier proceso que corra en localhost de la máquina del
    // cliente.
    if (!env.isProduction && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return true;
    }
  } catch {
    return false;
  }

  return env.allowedOrigins.has(origin);
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin no permitido por CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With", "X-Request-Id"],
  maxAge: 86400,
};

export function ensureAllowedOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");

  if (isAllowedOrigin(origin)) {
    return next();
  }

  if (req.log) {
    req.log.warn(
      { origin, ip: getClientIp(req), requestId: getRequestId(req) },
      "Solicitud bloqueada por origin no permitido"
    );
  } else {
    console.warn("Solicitud bloqueada por origin no permitido", {
      origin,
      ip: getClientIp(req),
      requestId: getRequestId(req),
    });
  }

  return res.status(403).json({ message: "Origin no permitido." });
}
