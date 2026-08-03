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
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";

const LOTE = 5000; // borra en lotes para no tomar un lock largo sobre una tabla que se sigue escribiendo en paralelo

export async function limpiarAuditoriaVieja(opciones?: { retentionDays?: number }): Promise<{ filasBorradas: number }> {
  const retentionDays = opciones?.retentionDays ?? env.platformAuditRetentionDays;
  if (!retentionDays || retentionDays <= 0) {
    return { filasBorradas: 0 };
  }

  let total = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM platform_audit_log
       WHERE id IN (
         SELECT id FROM platform_audit_log
         WHERE creado_en < now() - make_interval(days => $1)
         ORDER BY creado_en
         LIMIT $2
       )`,
      [retentionDays, LOTE]
    );
    const borradas = result.rowCount ?? 0;
    total += borradas;
    if (borradas < LOTE) break;
  }

  if (total > 0) {
    logger.info(
      { filasBorradas: total, retentionDays },
      "Retención de platform_audit_log: filas más viejas que la política borradas"
    );
  }

  return { filasBorradas: total };
}

setInterval(() => {
  limpiarAuditoriaVieja().catch((err) =>
    logger.warn({ err }, "Error inesperado en la retención de platform_audit_log")
  );
}, env.platformAuditRetentionCheckIntervalMs).unref();
