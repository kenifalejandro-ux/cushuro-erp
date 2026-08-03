/** src/server/shared/utils/moduleAudit.ts
 *
 * Parte del Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md): todo
 * módulo de negocio que crea/edita/borra algo debe dejar rastro en
 * platform_audit_log, igual que ya hace platform.service.ts para las
 * acciones del panel — antes de esto ningún módulo del ERP auditaba nada.
 *
 * Uso típico en un controller:
 *   await registrarAuditoria({
 *     accion: "equipos.crear",
 *     tenantId,
 *     usuarioId: req.usuario!.id,
 *     detalle: { equipoId: equipo.id },
 *     contexto: contextoAuditoriaModulo(req),
 *   });
 *
 * `detalle` debe llevar SOLO ids/referencias, nunca el contenido de negocio
 * (mismo criterio que platform.service.ts) — la auditoría registra qué se
 * hizo y quién, no una copia de los datos del tenant.
 */
import type { Request } from "express";
import type { ContextoAuditoria } from "../../services/platformAudit.service";
import { getClientIp, getRequestId, getUserAgent } from "./request";

export function contextoAuditoriaModulo(req: Request): ContextoAuditoria {
  const usuario = req.usuario;
  if (!usuario) {
    throw new Error("contextoAuditoriaModulo requiere authMiddleware antes en la cadena");
  }

  return {
    ip: getClientIp(req),
    requestId: getRequestId(req),
    userAgent: getUserAgent(req),
    actorType: "tenant_usuario",
    actorId: usuario.id,
    actorLabel: usuario.email,
  };
}
