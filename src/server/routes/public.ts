/**src/server/routes/public.ts */

import { Router, type RequestHandler } from "express";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import { asyncHandler } from "../shared/utils/asyncHandler";
import rateLimiter from "../middleware/rateLimiter";

export function createPublicRouter() {
  const router = Router();

  // Ruta de estado general del servidor (útil para debugging)
  router.get(
    "/status",
    rateLimiter,
    asyncHandler(async (_req, res) => {
      const redis = getRedis();
      let redisStatus = "disabled";

      if (redis) {
        try {
          await redis.ping();
          redisStatus = "connected";
        } catch {
          redisStatus = "error";
        }
      }

      return res.json({
        ok: true,
        message: "MinCore ERP API running",
        port: env.port,
        redis: redisStatus,
        environment: env.isProduction ? "production" : "development",
        timestamp: new Date().toISOString(),
      });
    })
  );

  // Ruta de health check simple (útil para frontend)
  const health: RequestHandler = (_req, res) => {
    res.json({
      status: "healthy",
      service: "mincoreerp",
      version: "1.0.0", // puedes cambiarlo después
      uptime: process.uptime(),
    });
  };

  router.get("/health", health);
  // Mismo handler bajo /api: lo usa el probe de conectividad del cliente
  // (client/src/offline/connectivity.ts) para distinguir "hay wifi" de "hay
  // salida real a internet", y en desarrollo el proxy de Vite solo reenvía
  // /api al backend (ver client/vite.config.js) — sin este alias el probe
  // le pegaría al dev server y respondería 200 aunque el backend esté caído.
  //
  // Elegido a propósito en vez de /api/auth/refresh: ese endpoint ROTA el
  // refresh token y trata un reuso como robo de sesión (auth.service.ts),
  // así que usarlo como latido de conectividad desloguearía al usuario de
  // todos sus dispositivos.
  router.get("/api/health", health);

  return router;
}
