/** src/server/services/eventosTiempoRealRetention.worker.ts
 *
 * Poda periódica de eventos_tiempo_real / platform_eventos_tiempo_real
 * (migración 0042) -- a diferencia de platformAuditRetention.worker.ts,
 * esta va ENCENDIDA por default (ver env.eventosTiempoRealRetentionMinutes):
 * no es una decisión de compliance, es un buffer de reposición para SSE
 * que no debe crecer sin límite.
 *
 * Dos tablas, DOS estrategias de borrado -- no es simetría gratuita:
 *
 * - platform_eventos_tiempo_real no tiene RLS (mismo criterio que
 *   platform_outbox): un DELETE por `pool` directo alcanza.
 * - eventos_tiempo_real SÍ tiene RLS FORZADO (migración 0042), y sin
 *   `missing_ok` en `current_setting('app.tenant_id')` -- un `pool.query`
 *   directo acá no filtra de más ni de menos, revienta con
 *   `invalid input syntax for type uuid: ""`. Es EXACTAMENTE la trampa
 *   documentada en la memoria del proyecto (feedback_trampa_rls_withtenant):
 *   la primera versión de este worker cayó en ella -- lo agarró el test
 *   de retención, no una revisión manual. La única forma correcta de
 *   borrar acá es tenant por tenant, con `app.tenant_id` seteado en la
 *   misma transacción que hace el DELETE.
 *
 * Iterar tenant por tenant en cada corrida es O(tenants), no O(filas
 * viejas) -- aceptable a la escala actual (unos pocos tenants). Si esto
 * llega a cientos de tenants activos, vale la pena revisar el costo de
 * abrir una transacción corta por tenant en cada intervalo.
 *
 * Mismo patrón de lock por lote que platformAuditRetention.worker.ts (ver
 * ese archivo para el porqué del lock POR LOTE, no uno solo para toda la
 * corrida). Un solo LOCK_ID cubre las dos tablas -- siempre se podan en
 * la misma pasada, no hay motivo para coordinarlas por separado.
 */
import type { Pool, PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";

const LOTE = 5000;

async function borrarLotePlataforma(
  ejecutor: Pool | PoolClient,
  retentionMinutes: number
): Promise<number> {
  const result = await ejecutor.query(
    `DELETE FROM platform_eventos_tiempo_real
     WHERE id IN (
       SELECT id FROM platform_eventos_tiempo_real
       WHERE creado_en < now() - make_interval(mins => $1)
       ORDER BY creado_en
       LIMIT $2
     )`,
    [retentionMinutes, LOTE]
  );
  return result.rowCount ?? 0;
}

/** `client` ya tiene que estar en una transacción con `app.tenant_id`
 *  seteado para `tenantId` (vía withTenant() o set_config manual) -- acá
 *  solo se hace el DELETE en sí. */
async function borrarLoteTenant(
  client: PoolClient,
  tenantId: string,
  retentionMinutes: number
): Promise<number> {
  const result = await client.query(
    `DELETE FROM eventos_tiempo_real
     WHERE id IN (
       SELECT id FROM eventos_tiempo_real
       WHERE tenant_id = $1 AND creado_en < now() - make_interval(mins => $2)
       ORDER BY creado_en
       LIMIT $3
     )`,
    [tenantId, retentionMinutes, LOTE]
  );
  return result.rowCount ?? 0;
}

/** tenants no tiene RLS (ver ALLOWLIST_SIN_RLS en rls-coverage.test.ts) --
 *  pool.query directo es seguro acá. */
async function idsDeTenants(): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM tenants`);
  return result.rows.map((fila) => fila.id);
}

function logSiHuboBorrados(tabla: string, total: number, retentionMinutes: number): void {
  if (total > 0) {
    logger.info(
      { tabla, filasBorradas: total, retentionMinutes },
      "Retención de eventos_tiempo_real: filas más viejas que la política borradas"
    );
  }
}

/** Uso directo, sin coordinación entre instancias -- para tests y una
 *  corrida manual. */
export async function limpiarEventosTiempoRealViejos(opciones?: {
  retentionMinutes?: number;
}): Promise<{ filasBorradas: number }> {
  const retentionMinutes = opciones?.retentionMinutes ?? env.eventosTiempoRealRetentionMinutes;
  if (!retentionMinutes || retentionMinutes <= 0) {
    return { filasBorradas: 0 };
  }

  let totalPlataforma = 0;
  for (;;) {
    const borradas = await borrarLotePlataforma(pool, retentionMinutes);
    totalPlataforma += borradas;
    if (borradas < LOTE) break;
  }
  logSiHuboBorrados("platform_eventos_tiempo_real", totalPlataforma, retentionMinutes);

  let totalTenant = 0;
  for (const tenantId of await idsDeTenants()) {
    for (;;) {
      const borradas = await withTenant(tenantId, (client) =>
        borrarLoteTenant(client, tenantId, retentionMinutes)
      );
      totalTenant += borradas;
      if (borradas < LOTE) break;
    }
  }
  logSiHuboBorrados("eventos_tiempo_real", totalTenant, retentionMinutes);

  return { filasBorradas: totalPlataforma + totalTenant };
}

/** Uso del worker periódico: lock por lote, no uno solo para toda la
 *  corrida -- ver el comentario del archivo. */
async function correrRetencionEventosCoordinada(): Promise<void> {
  const retentionMinutes = env.eventosTiempoRealRetentionMinutes;
  if (!retentionMinutes || retentionMinutes <= 0) return;

  let totalPlataforma = 0;
  for (;;) {
    const borradas = await runSiPrimero(LOCK_IDS.eventosTiempoRealRetention, (client) =>
      borrarLotePlataforma(client, retentionMinutes)
    );
    if (borradas === undefined) break; // el lock de este lote ya lo tiene otra instancia
    totalPlataforma += borradas;
    if (borradas < LOTE) break;
  }
  logSiHuboBorrados("platform_eventos_tiempo_real", totalPlataforma, retentionMinutes);

  let totalTenant = 0;
  for (const tenantId of await idsDeTenants()) {
    for (;;) {
      const borradas = await runSiPrimero(LOCK_IDS.eventosTiempoRealRetention, async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return borrarLoteTenant(client, tenantId, retentionMinutes);
      });
      if (borradas === undefined) break; // el lock de este lote ya lo tiene otra instancia
      totalTenant += borradas;
      if (borradas < LOTE) break;
    }
  }
  logSiHuboBorrados("eventos_tiempo_real", totalTenant, retentionMinutes);
}

setInterval(() => {
  correrRetencionEventosCoordinada().catch((err) => {
    logger.warn({ err }, "Error inesperado en la retención de eventos_tiempo_real");
    capturarError(err, { worker: "eventosTiempoRealRetention" });
  });
}, env.eventosTiempoRealRetentionCheckIntervalMs).unref();
