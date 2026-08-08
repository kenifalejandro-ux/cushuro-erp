/** src/modules/iperc/iperc.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import {
  crearIpercSchema,
  cambiarEstadoIpercSchema,
  crearLineaBaseSchema,
} from "../../server/schemas/iperc.schema";
import { IpercController } from "./iperc.controller";

const router = Router();

// Línea Base
router.get("/lineas-base", IpercController.getLineasBase);
router.get("/lineas-base/:id", IpercController.getLineaBase);
router.post(
  "/lineas-base",
  requireRole("admin", "operador"),
  validate(crearLineaBaseSchema),
  IpercController.crearLineaBase
);
router.patch(
  "/lineas-base/:id/estado",
  requireRole("admin"),
  validate(cambiarEstadoIpercSchema),
  IpercController.cambiarEstadoLineaBase
);
router.delete("/lineas-base/:id", requireRole("admin"), IpercController.eliminarLineaBase);

// Continuo / Específico (ver campo `tipo`)
router.get("/", IpercController.getAll);
router.get("/:id", IpercController.getById);
router.post(
  "/",
  requireRole("admin", "operador"),
  validate(crearIpercSchema),
  IpercController.crear
);

// Aprobar/rechazar: solo admin — se reutiliza el rol existente en vez de
// sumar un rol "supervisor" nuevo (decisión documentada desde que se armó
// este módulo; si en la práctica hace falta un rol intermedio, se ajusta
// después sin tocar el resto del sistema de auth).
router.patch(
  "/:id/estado",
  requireRole("admin"),
  validate(cambiarEstadoIpercSchema),
  IpercController.cambiarEstado
);

router.delete("/:id", requireRole("admin"), IpercController.eliminar);

export default router;
