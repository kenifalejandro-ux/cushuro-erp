/** src/server/services/combustibleConciliacion.worker.ts
 *
 * Cierra el ciclo del punto 4 de docs/architecture/control-de-combustible.md:
 * lo que pasó la ventana de gracia sin explicarse deja de ser un aviso vivo
 * y se congela como hallazgo permanente en `combustible_anomalias`
 * (migraciones 0071 y 0072).
 *
 * ── Por qué automático y no un botón ────────────────────────────────────
 *
 * Decidido explícitamente por Kenif: "la idea es que el ERP no acumule los
 * huecos porque no será escalable con el tiempo y todo será desordenado...
 * eso tienen que solucionar en el momento aunque haya plazo de 3 días".
 *
 * El aviso al momento ya existe (alertas por correo/campanita, migración
 * 0068) -- para eso está la ventana: dar tiempo a que se explique. Lo que
 * NO puede pasar es que, agotado ese tiempo, el hallazgo quede esperando
 * que alguien apriete un botón: ahí es donde se acumulan.
 *
 * ── Iterar tenants bajo RLS DENTRO del lock ─────────────────────────────
 *
 * Copiado de eventosTiempoRealRetention.worker.ts, que es el que ya resolvió
 * este caso: `combustible_alertas`, `combustible_anomalias` y
 * `combustible_config` tienen RLS FORZADO, así que un `pool.query` directo
 * acá no filtra de más ni de menos -- revienta con `invalid input syntax
 * for type uuid: ""`. Es la trampa documentada en la memoria del proyecto
 * (feedback_trampa_rls_withtenant), que ya se cometió una vez en ese
 * worker. Por eso `set_config('app.tenant_id', ...)` va DENTRO del mismo
 * client que sostiene el advisory lock: usar `withTenant()` acá abriría
 * una conexión distinta, y el trabajo quedaría fuera de la transacción que
 * protege el lock.
 *
 * Un lock POR TENANT y no uno para toda la corrida (mismo criterio que el
 * lock por lote de platformAuditRetention.worker.ts): el trabajo protegido
 * corre dentro de la transacción del lock, así que tomarlo una sola vez
 * para todos los tenants lo mantendría agarrado durante toda la pasada.
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";
import { capturarError } from "../config/sentry";
import { CombustibleService } from "../../modules/combustible/combustible.service";

const service = new CombustibleService();

/** `tenants` no tiene RLS (ver ALLOWLIST_SIN_RLS en rls-coverage.test.ts) --
 *  pool.query directo es seguro acá. Mismo helper que el worker de
 *  retención de eventos. */
async function idsDeTenants(): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM tenants`);
  return result.rows.map((fila) => fila.id);
}

/** Uso directo, sin coordinación entre instancias -- para tests y una
 *  corrida manual. Mismo par que limpiarEventosTiempoRealViejos()/
 *  correrRetencionEventosCoordinada() en el worker de retención. */
export async function correrConciliacion(): Promise<{ congeladas: number }> {
  let total = 0;
  for (const tenantId of await idsDeTenants()) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      // El orden importa: primero se crean las alertas de diferencia, después
      // se congela lo vencido. Al revés, una diferencia recién detectada
      // tendría que esperar a la corrida siguiente para poder congelarse.
      await service.alertarDiferenciasDeRecepcion(client, tenantId);
      const { congeladas } = await service.congelarAlertasVencidas(client, tenantId);
      await client.query("COMMIT");
      total += congeladas;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return { congeladas: total };
}

/** Uso del worker periódico: un lock por tenant -- ver el comentario del
 *  archivo. */
async function correrConciliacionCoordinada(): Promise<void> {
  let total = 0;
  let ultimaVentana = 0;

  for (const tenantId of await idsDeTenants()) {
    const resultado = await runSiPrimero(LOCK_IDS.combustibleConciliacion, async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await service.alertarDiferenciasDeRecepcion(client, tenantId);
      return service.congelarAlertasVencidas(client, tenantId);
    });
    // undefined = otra instancia tiene el lock; se salta este tenant, la
    // próxima corrida lo agarra.
    if (resultado === undefined) continue;
    total += resultado.congeladas;
    ultimaVentana = resultado.ventanaHoras;
  }

  // Una corrida sin nada que congelar es lo NORMAL (todas las alertas se
  // resolvieron dentro de su ventana) -- loguearlo cada hora sería ruido.
  if (total > 0) {
    logger.info(
      { anomaliasCongeladas: total, ventanaHoras: ultimaVentana },
      "Conciliación de combustible: alertas sin explicación congeladas como anomalías"
    );
  }
}

setInterval(() => {
  correrConciliacionCoordinada().catch((err) => {
    logger.warn({ err }, "Error inesperado en la conciliación de combustible");
    capturarError(err, { worker: "combustibleConciliacion" });
  });
}, env.combustibleConciliacionCheckIntervalMs).unref();
