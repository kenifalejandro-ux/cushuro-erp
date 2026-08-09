/** src/server/shared/middlewares/cuota.middleware.ts
 *
 * Aplica la cuota de volumen de un módulo antes de dejar crear un registro
 * más. Ver docs/architecture/cuotas-por-tenant.md.
 *
 * Se monta una vez por módulo en routes/index.ts, junto a requireModulo() —
 * así un módulo nuevo queda cubierto por el solo hecho de declarar `cuota`
 * en el registry, sin tocar sus controllers ni este archivo (mismo criterio
 * que el resto del Contrato de Módulo, ADR-0002).
 *
 * ── Por qué solo POST ────────────────────────────────────────────────────
 *
 * Una cuota es un tope de CRECIMIENTO. GET, PUT/PATCH y DELETE no aumentan
 * el conteo, y bloquearlos dejaría a un tenant que llegó al límite sin
 * poder ni consultar ni borrar lo que tiene — es decir, sin forma de bajar
 * por debajo del límite. Un tenant excedido siempre puede leer y borrar.
 *
 * ── El caso bulk ─────────────────────────────────────────────────────────
 *
 * POST /repuestos/bulk y POST /documentos/bulk reciben un ARRAY y crean N
 * filas de un saque. Un chequeo ingenuo ("¿hay lugar para una más?") dejaría
 * pasar una importación de 10.000 filas con un solo cupo libre. Por eso el
 * incremento sale del largo del array cuando el body es una lista.
 */
import type { Request, Response, NextFunction } from "express";
import { getTenantId } from "../utils/request";
import { verificarCuota, CuotaExcedidaError } from "../../services/platformCuotas.service";
import { registrarAuditoria } from "../../services/platformAudit.service";
import { contextoAuditoriaModulo } from "../utils/moduleAudit";
import { obtenerModulo } from "../../../modules/registry";
import { logger } from "../../config/logger";
import { asyncHandler } from "../utils/asyncHandler";

/** Cuántos registros va a crear este request. El body de los endpoints
 *  /bulk es un array crudo (ver repuestos.controller.ts); cualquier otro
 *  POST crea uno solo.
 *
 *  No intenta adivinar nada más: un POST que crea un padre con hijos (un
 *  checklist con sus ítems, un IPERC con sus líneas) cuenta como 1, que es
 *  lo correcto — la cuota del módulo se define sobre la entidad principal,
 *  no sobre sus filas de detalle (ver `cuota.tabla` en el registry). */
function cantidadACrear(req: Request): number {
  return Array.isArray(req.body) ? req.body.length : 1;
}

/** Debe usarse después de authMiddleware + tenantMiddleware. Sin efecto en
 *  módulos que no declaran `cuota` en el registry. */
export function requireCuota(moduloId: string) {
  const modulo = obtenerModulo(moduloId);

  // Se resuelve al montar y no en cada request: si el módulo no tiene cuota
  // declarada, el middleware es un passthrough sin costo.
  if (!modulo?.cuota) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();

    try {
      const tenantId = getTenantId(req);
      await verificarCuota(tenantId, moduloId, cantidadACrear(req));
      next();
    } catch (err) {
      if (err instanceof CuotaExcedidaError) {
        // Se audita el bloqueo: que un cliente choque contra su límite es
        // justamente la señal comercial/operativa que hay que poder ver
        // después, no un error más. No bloquea la respuesta si falla
        // (registrarAuditoria nunca tira).
        await registrarAuditoria({
          accion: "cuota.bloqueo",
          tenantId: req.tenantId,
          usuarioId: req.usuario?.id,
          detalle: {
            recurso: err.recurso,
            limite: err.limite,
            uso: err.uso,
            incremento: err.incremento,
            ruta: req.originalUrl,
          },
          contexto: contextoAuditoriaModulo(req),
          resultado: "failure",
        });

        logger.warn(
          { tenantId: req.tenantId, recurso: err.recurso, limite: err.limite, uso: err.uso },
          "Creación bloqueada por cuota de tenant"
        );

        // Cuerpo estructurado y no solo un mensaje: el cliente necesita
        // poder mostrar "usaste X de Y" sin parsear texto.
        return res.status(403).json({
          ok: false,
          error: "cuota_excedida",
          recurso: err.recurso,
          limite: err.limite,
          uso: err.uso,
          message: err.message,
        });
      }
      next(err);
    }
  });
}
