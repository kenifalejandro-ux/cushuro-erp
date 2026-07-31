/** src/server/routes/platform.ts */

import { Router } from "express";
import { validate } from "../middleware/validate";
import rateLimiter from "../middleware/rateLimiter";
import { platformAdminMiddleware } from "../shared/middlewares/platformAdmin.middleware";
import { crearTenantSchema } from "../schemas/platform.schema";
import { crearTenantConAdminService } from "../services/platform.service";

export function createPlatformRouter() {
  const router = Router();

  router.post(
    "/tenants",
    rateLimiter,
    platformAdminMiddleware,
    validate(crearTenantSchema),
    async (req, res, next) => {
      try {
        const resultado = await crearTenantConAdminService(req.validatedBody as any);
        res.status(201).json({ ok: true, ...resultado });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
