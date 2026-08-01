/** src/modules/iperc/iperc.routes.ts */

import { Router } from "express";
import { validate } from "../../server/middleware/validate";
import { requireRole } from "../../server/shared/middlewares/roles.middleware";
import { crearIpercSchema, cambiarEstadoIpercSchema } from "../../server/schemas/iperc.schema";
import { IpercController } from "./iperc.controller";

const router = Router();

router.get("/", IpercController.getAll);
router.get("/:id", IpercController.getById);
router.post("/", requireRole("admin", "operador"), validate(crearIpercSchema), IpercController.crear);

// Aprobar/rechazar: solo admin — se reutiliza el rol existente en vez de
// sumar un rol "supervisor" nuevo (decisión documentada en el plan de esta
// funcionalidad; si en la práctica hace falta un rol intermedio, se ajusta
// después sin tocar el resto del sistema de auth).
router.patch(
  "/:id/estado",
  requireRole("admin"),
  validate(cambiarEstadoIpercSchema),
  IpercController.cambiarEstado
);

router.delete("/:id", requireRole("admin"), IpercController.eliminar);

export default router;
