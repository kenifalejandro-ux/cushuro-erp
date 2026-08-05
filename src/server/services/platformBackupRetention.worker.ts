/** src/server/services/platformBackupRetention.worker.ts
 *
 * Poda periódica OPCIONAL de backups, por política GFS
 * (grandfather-father-son). Deshabilitada por default —las dos variables
 * de retención en 0—, mismo criterio que platformAuditRetention.worker.ts:
 * borrar backups automáticamente es una decisión de negocio/compliance, no
 * algo que este código deba asumir solo. Ver
 * docs/architecture/backups-s3.md.
 *
 * ── La política ──────────────────────────────────────────────────────────
 *
 *   Últimos BACKUP_RETENTION_DIARIO_DIAS días  → se conservan TODOS.
 *   Más viejos que eso, hasta BACKUP_RETENTION_MENSUAL_MESES meses
 *                                              → se conserva SOLO el
 *                                                primero de cada mes.
 *   Más viejos que eso                         → se borran.
 *
 * "El primero de cada mes" se calcula al podar, no se marca al crear. Es a
 * propósito: si el mensual de marzo se borró por otra vía, el siguiente
 * backup de marzo pasa a ocupar ese lugar solo. Marcarlo al crear dejaría
 * un mes sin ningún backup conservado.
 *
 * ── Por qué un worker y no solo una S3 Lifecycle Rule ───────────────────
 *
 * Una lifecycle rule borra el objeto pero NO la fila de tenant_backups /
 * platform_backups que lo referencia: quedarían filas apuntando a objetos
 * inexistentes, que el panel sigue ofreciendo restaurar y que fallan recién
 * al intentarlo — durante un incidente. Este worker borra las dos cosas, y
 * solo borra la fila si el objeto se borró de verdad (ver `fallidas`).
 *
 * Las lifecycle rules siguen siendo útiles como red de seguridad a nivel
 * bucket, con un umbral MÁS LARGO que esta política, para que no compitan.
 * Ver la sección de Lifecycle en la documentación.
 */
import type { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { borrarBackupsEnLote, type UbicacionBackup, type DriverStorage } from "./platformBackupStorage";
import { runSiPrimero, LOCK_IDS } from "../shared/utils/advisoryLock";

interface FilaBackup {
  id: string;
  storage: DriverStorage;
  storage_key: string;
  creado_en: Date;
  /** null en platform_backups (no pertenecen a ningún tenant). */
  tenant_id: string | null;
}

/** Decide qué backups sobreviven. Exportada para poder testear la política
 *  sola, con fechas fabricadas y sin tocar la base ni el storage — que es
 *  la parte donde un error se paga borrando backups que había que
 *  conservar. */
export function clasificarBackupsAPodar(
  backups: FilaBackup[],
  opciones: { diarioDias: number; mensualMeses: number; ahora?: Date }
): { conservar: FilaBackup[]; borrar: FilaBackup[] } {
  const ahora = opciones.ahora ?? new Date();
  const corteDiario = new Date(ahora);
  corteDiario.setUTCDate(corteDiario.getUTCDate() - opciones.diarioDias);
  const corteMensual = new Date(ahora);
  corteMensual.setUTCMonth(corteMensual.getUTCMonth() - opciones.mensualMeses);

  // Más viejo primero: el primero que aparece de cada mes es, por
  // definición, el mensual que se conserva.
  const ordenados = [...backups].sort((a, b) => a.creado_en.getTime() - b.creado_en.getTime());

  const conservar: FilaBackup[] = [];
  const borrar: FilaBackup[] = [];
  // La clave incluye el tenant: el "primero de marzo" se elige por tenant,
  // no globalmente. Sin esto, el primer backup de marzo de UN tenant haría
  // que se borraran los mensuales de todos los demás.
  const mensualYaElegido = new Set<string>();

  for (const backup of ordenados) {
    const fecha = backup.creado_en;

    if (fecha >= corteDiario) {
      conservar.push(backup); // dentro de la ventana diaria: todos
      continue;
    }

    if (fecha < corteMensual) {
      borrar.push(backup); // más allá de la ventana mensual: ninguno
      continue;
    }

    const claveMes = `${backup.tenant_id ?? "plataforma"}:${fecha.getUTCFullYear()}-${fecha.getUTCMonth()}`;
    if (mensualYaElegido.has(claveMes)) {
      borrar.push(backup);
    } else {
      mensualYaElegido.add(claveMes);
      conservar.push(backup);
    }
  }

  return { conservar, borrar };
}

async function podarTabla(
  ejecutor: Pool | PoolClient,
  tabla: "tenant_backups" | "platform_backups",
  diarioDias: number,
  mensualMeses: number,
  ahora?: Date
): Promise<{ borrados: number; fallidos: number }> {
  const columnaTenant = tabla === "tenant_backups" ? "tenant_id" : "NULL::uuid AS tenant_id";
  const filas = await ejecutor.query<FilaBackup>(
    `SELECT id, storage, storage_key, creado_en, ${columnaTenant} FROM ${tabla}`
  );

  const { borrar } = clasificarBackupsAPodar(filas.rows, { diarioDias, mensualMeses, ahora });
  if (borrar.length === 0) return { borrados: 0, fallidos: 0 };

  const ubicaciones: UbicacionBackup[] = borrar.map((b) => ({ storage: b.storage, key: b.storage_key }));
  const { fallidas } = await borrarBackupsEnLote(ubicaciones);

  // Solo se borra la fila si el objeto se borró de verdad. Al revés
  // —borrar la fila igual— el objeto quedaría en el bucket sin nada que lo
  // referencie: basura invisible que igual factura y que nadie va a
  // encontrar después.
  const keysFallidas = new Set(fallidas);
  const idsABorrar = borrar.filter((b) => !keysFallidas.has(b.storage_key)).map((b) => b.id);

  if (idsABorrar.length > 0) {
    await ejecutor.query(`DELETE FROM ${tabla} WHERE id = ANY($1::uuid[])`, [idsABorrar]);
  }

  return { borrados: idsABorrar.length, fallidos: fallidas.length };
}

/** `ejecutor` opcional: el worker de abajo pasa el client que sostiene el
 *  advisory lock (ver advisoryLock.ts); sin uno, usa el pool directo. */
export async function podarBackupsViejos(opciones?: {
  diarioDias?: number;
  mensualMeses?: number;
  ahora?: Date;
  ejecutor?: Pool | PoolClient;
}): Promise<{ tenants: { borrados: number; fallidos: number }; plataforma: { borrados: number; fallidos: number } }> {
  const diarioDias = opciones?.diarioDias ?? env.backupRetentionDiarioDias;
  const mensualMeses = opciones?.mensualMeses ?? env.backupRetentionMensualMeses;
  const ejecutor = opciones?.ejecutor ?? pool;

  const vacio = { tenants: { borrados: 0, fallidos: 0 }, plataforma: { borrados: 0, fallidos: 0 } };

  // Las DOS tienen que estar configuradas. Con solo una, la política queda
  // a medias y el default de la otra (0) haría que "más viejo que 0 meses"
  // borre todo lo que salga de la ventana diaria — exactamente el tipo de
  // error que no se puede permitir en un borrado automático de backups.
  if (diarioDias <= 0 || mensualMeses <= 0) return vacio;

  const tenants = await podarTabla(ejecutor, "tenant_backups", diarioDias, mensualMeses, opciones?.ahora);
  const plataforma = await podarTabla(ejecutor, "platform_backups", diarioDias, mensualMeses, opciones?.ahora);

  if (tenants.borrados + plataforma.borrados > 0 || tenants.fallidos + plataforma.fallidos > 0) {
    logger.info(
      { tenants, plataforma, diarioDias, mensualMeses },
      "Retención de backups: se podaron backups fuera de la política"
    );
  }
  if (tenants.fallidos + plataforma.fallidos > 0) {
    logger.error(
      { tenants, plataforma },
      "Retención de backups: algunos objetos no se pudieron borrar del storage; sus filas se conservan para reintentar"
    );
  }

  return { tenants, plataforma };
}

setInterval(() => {
  runSiPrimero(LOCK_IDS.backupRetention, (client) => podarBackupsViejos({ ejecutor: client })).catch((err) =>
    logger.error({ err }, "Error inesperado en la retención de backups")
  );
}, env.backupRetentionCheckIntervalMs).unref();
