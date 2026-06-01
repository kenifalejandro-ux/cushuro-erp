/**src/server/routes/formulario.ts */


import { Router } from "express";
import { emailConfigured, env } from "../config/env";
import { getRedis } from "../config/redis";
import { ensureAllowedOrigin } from "../middleware/originGuard";

export function createSystemRouter() {
  const router = Router();

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
      port: env.port,
      redis: redisStatus,
      recaptchaConfigured: Boolean(env.recaptchaSiteKey),
      emailConfigured,
      allowedOrigins: env.allowedOrigins.size,
    });
  });

  router.get("/api/recaptcha-site-key", ensureAllowedOrigin, (_req, res) => {
    if (!env.recaptchaSiteKey) {
      return res
        .status(500)
        .json({ message: "RECAPTCHA_SITE_KEY no esta configurado en el servidor." });
    }

    return res.json({ siteKey: env.recaptchaSiteKey });
  });

  return router;
}
