/** src/server/routes/facturacion.ts
 *
 * Facturación no es un módulo del ADR-0002 (no se activa/desactiva por
 * tenant desde el panel de plataforma como equipos/checklists/etc.) -- es
 * infraestructura de cuenta, visible para cualquier tenant autenticado
 * siempre. Por eso se monta directo en app.ts, no vía MODULOS/registry.
 */
import { Router } from "express";
import { authMiddleware } from "../shared/middlewares/auth.middleware";
import { tenantMiddleware } from "../shared/middlewares/tenant.middleware";
import { asyncHandler } from "../shared/utils/asyncHandler";
import { getTenantId } from "../shared/utils/request";
import {
  listarComprobantesTenantService,
  generarComprobantePagoPdfService,
} from "../services/facturacion.service";

export const facturacionRouter = Router();

facturacionRouter.use(authMiddleware, tenantMiddleware);

facturacionRouter.get(
  "/comprobantes",
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    const comprobantes = await listarComprobantesTenantService(tenantId);
    res.json({ comprobantes });
  })
);

facturacionRouter.get(
  "/comprobantes/:id/pdf",
  asyncHandler(async (req, res) => {
    const tenantId = getTenantId(req);
    const pdf = await generarComprobantePagoPdfService(tenantId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="comprobante-${req.params.id}.pdf"`);
    res.send(pdf);
  })
);
