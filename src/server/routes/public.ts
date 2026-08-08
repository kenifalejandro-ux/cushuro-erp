/**src/server/routes/public.ts */

import { Router } from "express";
import { env } from "../config/env";
import { getRedis } from "../config/redis";

export function createPublicRouter() {
  const router = Router();

  // Ruta de estado general del servidor (útil para debugging)
  router.get("/status", async (_req, res) => {
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
  });

  // Ruta de health check simple (útil para frontend)
  router.get("/health", (_req, res) => {
    res.json({
      status: "healthy",
      service: "mincoreerp",
      version: "1.0.0", // puedes cambiarlo después
      uptime: process.uptime(),
    });
  });

  return router;
}
