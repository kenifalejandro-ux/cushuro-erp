/** src/server/services/platformAuditRetention.worker.ts
 *
 * Borrado periódico OPCIONAL de platform_audit_log — deshabilitado por
 * default (PLATFORM_AUDIT_RETENTION_DAYS sin configurar o en 0). Ver
 * migrations/0019_platform_audit_log_retencion.sql para la política de
 * retención recomendada y por qué "guardar de más" es el default seguro:
 * habilitar esto es una decisión de negocio/compliance, no algo que este
 * código deba asumir por sí solo.
 *
 * Nunca borra nada silenciosamente: cada corrida que efectivamente borra
 * algo deja un resumen estructurado en el log (cuántas filas). No escribe
 * ese resumen en platform_audit_log mismo — inflaría la propia tabla que
 * se está podando, y no debería depender de que la escritura de auditoría
 * esté disponible justo en el momento de limpiar.
 *
 * ── Por qué hay DOS funciones que borran, no una ─────────────────────────
 *
 * limpiarAuditoriaVieja() es la de uso directo (tests, una corrida manual):
 * sin coordinación entre instancias, todo en un solo proceso — ahí el lock
 * no pinta nada.
 *
 * El worker periódico de más abajo necesita coordinación (más de una
 * instancia del server no puede podar la misma tabla en paralelo), pero
 * NO puede pedir el advisory lock una sola vez para TODA la corrida: un
 * lock transaccional (pg_advisory_xact_lock, ver advisoryLock.ts) vive
 * atado a la transacción que lo tomó, así que sostenerlo durante toda la
 * poda exigiría envolver TODOS los lotes en una única transacción larga —
 * exactamente lo que el batching (LOTE) existe para evitar: no tomar un
 * lock de fila largo sobre una tabla que se sigue escribiendo en paralelo.
 * Por eso correrRetencionAuditoriaCoordinada() pide el lock UNA VEZ POR
 * LOTE — cada lote es su propia transacción corta, protegida por su propio
 * lock, y si en algún momento el lock ya lo tiene otra instancia, esta
 * corrida se detiene ahí: la próxima vuelta del setInterval (o la otra
 * instancia, ahora mismo) se encarga del resto.
 */
import type { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";

const LOTE = 5000; // borra en lotes para no tomar un lock largo sobre una tabla que se sigue escribiendo en paralelo

async function borrarUnLote(ejecutor: Pool | PoolClient, retentionDays: number): Promise<number> {
  const result = await ejecutor.query(
    `DELETE FROM platform_audit_log
     WHERE id IN (
       SELECT id FROM platform_audit_log
       WHERE creado_en < now() - make_interval(days => $1)
       ORDER BY creado_en
       LIMIT $2
     )`,
    [retentionDays, LOTE]
  );
  return result.rowCount ?? 0;
}

function logSiHuboBorrados(total: number, retentionDays: number): void {
  if (total > 0) {
    logger.info(
      { filasBorradas: total, retentionDays },
      "Retención de platform_audit_log: filas más viejas que la política borradas"
    );
  }
}

/** Uso directo, sin coordinación entre instancias — ver el comentario del
 *  archivo. Es la que usan los tests y una corrida manual. */
export async function limpiarAuditoriaVieja(opciones?: {
  retentionDays?: number;
}): Promise<{ filasBorradas: number }> {
  const retentionDays = opciones?.retentionDays ?? env.platformAuditRetentionDays;
  if (!retentionDays || retentionDays <= 0) {
    return { filasBorradas: 0 };
  }

  let total = 0;
  for (;;) {
    const borradas = await borrarUnLote(pool, retentionDays);
    total += borradas;
    if (borradas < LOTE) break;
  }

  logSiHuboBorrados(total, retentionDays);
  return { filasBorradas: total };
}

/** Uso del worker periódico: lock por lote, no uno solo para toda la
 *  corrida — ver el comentario del archivo. */
async function correrRetencionAuditoriaCoordinada(): Promise<void> {
  const retentionDays = env.platformAuditRetentionDays;
  if (!retentionDays || retentionDays <= 0) return;

  let total = 0;
  for (;;) {
    const borradas = await runSiPrimero(LOCK_IDS.auditRetention, (client) =>
      borrarUnLote(client, retentionDays)
    );
    if (borradas === undefined) break; // el lock de este lote ya lo tiene otra instancia
    total += borradas;
    if (borradas < LOTE) break;
  }

  logSiHuboBorrados(total, retentionDays);
}

setInterval(() => {
  correrRetencionAuditoriaCoordinada().catch((err) => {
    logger.warn({ err }, "Error inesperado en la retención de platform_audit_log");
    capturarError(err, { worker: "platformAuditRetention" });
  });
}, env.platformAuditRetentionCheckIntervalMs).unref();
