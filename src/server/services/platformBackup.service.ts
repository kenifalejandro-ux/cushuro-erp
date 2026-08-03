/** src/server/services/platformBackup.service.ts
 *
 * Backup y restore por tenant — "mecanismo mínimo viable", no un sistema
 * de disaster recovery completo. Exporta a JSON (sin dependencia de
 * pg_dump ni de un binario externo) todas las tablas de negocio de un
 * tenant, y puede restaurar ese export sobre un tenant (vacío, o como
 * "punto de restauración" que reemplaza lo que ese tenant tenga hoy).
 *
 * TABLAS: la misma lista y el mismo orden de dependencias que ya usa
 * tests/helpers.ts (borrarTenantDePrueba) para limpiar un tenant de
 * prueba — se reutiliza ese orden porque ya está probado contra las FK
 * reales, en vez de derivarlo de nuevo acá. A diferencia de ese helper
 * (que no necesita tocar las tablas "hijas" de detalle porque tienen ON
 * DELETE CASCADE desde su padre), acá SÍ hace falta listarlas
 * explícitamente: un backup que omitiera checklist_items/iperc_items/
 * iperc_linea_base_items/checklist_plantilla_items estaría incompleto —
 * ahí vive el contenido real de un checklist o un IPERC, no solo su
 * encabezado.
 *
 * SEGURIDAD: el JSON de un backup incluye usuarios.password_hash (bcrypt,
 * nunca en texto plano) — mismo nivel de sensibilidad que tenerlo en la
 * base. El storage (BACKUPS_DIR) tiene que estar tan protegido como la
 * base de datos misma; nunca se sirve por una ruta estática.
 */
import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { pool, withTenant } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import { guardarArchivoBackup, leerArchivoBackup } from "./platformBackupStorage";

interface MetaTabla {
  nombre: string;
  pk: "serial" | "uuid";
  // Columnas GENERATED ALWAYS AS (...) STORED — Postgres rechaza un
  // INSERT que las mencione explícitamente.
  columnasExcluidasAlRestaurar?: string[];
  // Columnas FK hacia otra tabla de este mismo backup — solo hace falta
  // declararlas cuando se restaura con remapeo de ids (ver
  // restaurarTablas): { columnaFK: tablaReferenciada }.
  fks?: Record<string, string>;
}

// Orden de INSERT en restore: padres antes que hijos, respetando cada FK
// real (ver migrations/0001, 0002, 0006, 0007). El wipe (DELETE) en
// restaurarBackupService recorre esta misma lista al revés.
const TABLAS_TENANT: MetaTabla[] = [
  { nombre: "usuarios", pk: "uuid" },
  { nombre: "equipos", pk: "serial" },
  { nombre: "checklist_plantillas", pk: "serial" },
  { nombre: "checklist_plantilla_items", pk: "serial", fks: { plantilla_id: "checklist_plantillas" } },
  { nombre: "checklists", pk: "serial", fks: { equipo_id: "equipos", plantilla_id: "checklist_plantillas", usuario_id: "usuarios" } },
  { nombre: "checklist_items", pk: "serial", fks: { checklist_id: "checklists" } },
  { nombre: "iperc_lineas_base", pk: "serial", fks: { aprobado_por: "usuarios", creado_por: "usuarios" } },
  {
    nombre: "iperc_linea_base_items",
    pk: "serial",
    columnasExcluidasAlRestaurar: ["nivel_riesgo"],
    fks: { linea_base_id: "iperc_lineas_base" },
  },
  {
    nombre: "ipercs",
    pk: "serial",
    fks: { equipo_id: "equipos", usuario_id: "usuarios", aprobado_por: "usuarios", linea_base_id: "iperc_lineas_base" },
  },
  {
    nombre: "iperc_items",
    pk: "serial",
    columnasExcluidasAlRestaurar: ["nivel_riesgo"],
    fks: { iperc_id: "ipercs", linea_base_item_id: "iperc_linea_base_items" },
  },
  { nombre: "repuestos", pk: "serial" },
  { nombre: "combustible", pk: "serial" },
  { nombre: "documentos", pk: "serial" },
];

interface ContenidoBackup {
  version: 1;
  tenantId: string;
  tenantSlug: string;
  tenantNombre: string;
  creadoEn: string;
  tablas: Record<string, Record<string, unknown>[]>;
}

export interface TenantBackup {
  id: string;
  tenantId: string;
  archivo: string;
  tamanoBytes: number;
  tablas: Record<string, number>;
  estado: "completo" | "fallido";
  creadoEn: string;
}

export async function exportarTenantService(tenantId: string, contexto: ContextoAuditoria): Promise<TenantBackup> {
  const tenant = await pool.query(`SELECT id, nombre, slug FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  // withTenant() por las tablas con RLS (todas, salvo la propia
  // tenants) — una sola transacción de solo lectura para todo el export.
  const tablas: Record<string, Record<string, unknown>[]> = await withTenant(tenantId, async (client) => {
    const resultado: Record<string, Record<string, unknown>[]> = {};
    for (const { nombre } of TABLAS_TENANT) {
      const filas = await client.query(`SELECT * FROM ${nombre} WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
      resultado[nombre] = filas.rows;
    }
    return resultado;
  });

  const backup: ContenidoBackup = {
    version: 1,
    tenantId,
    tenantSlug: tenant.rows[0].slug,
    tenantNombre: tenant.rows[0].nombre,
    creadoEn: new Date().toISOString(),
    tablas,
  };

  const resumenTablas = Object.fromEntries(Object.entries(tablas).map(([nombre, filas]) => [nombre, filas.length]));
  const contenidoSerializado = JSON.stringify(backup);
  const nombreArchivo = `${tenantId}-${Date.now()}.json`;

  await guardarArchivoBackup(nombreArchivo, contenidoSerializado);

  const registro = await pool.query(
    `INSERT INTO tenant_backups (tenant_id, archivo, tamano_bytes, tablas, estado)
     VALUES ($1, $2, $3, $4, 'completo')
     RETURNING id, tenant_id AS "tenantId", archivo, tamano_bytes AS "tamanoBytes", tablas, estado, creado_en AS "creadoEn"`,
    [tenantId, nombreArchivo, Buffer.byteLength(contenidoSerializado), JSON.stringify(resumenTablas)]
  );

  await registrarAuditoria({
    accion: "crear_backup_tenant",
    tenantId,
    detalle: { backupId: registro.rows[0].id, archivo: nombreArchivo, tablas: resumenTablas },
    contexto,
  });

  return registro.rows[0];
}

export async function listarBackupsTenantService(tenantId: string): Promise<TenantBackup[]> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const result = await pool.query(
    `SELECT id, tenant_id AS "tenantId", archivo, tamano_bytes AS "tamanoBytes", tablas, estado, creado_en AS "creadoEn"
     FROM tenant_backups WHERE tenant_id = $1 ORDER BY creado_en DESC`,
    [tenantId]
  );
  return result.rows;
}

/** Wipe en orden que respeta las FK — el reverso del orden de inserción
 *  de TABLAS_TENANT. Se apoya en ON DELETE CASCADE de las tablas "hijas"
 *  (checklist_items, checklist_plantilla_items, iperc_items,
 *  iperc_linea_base_items) igual que tests/helpers.ts. */
async function vaciarDatosDeTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`DELETE FROM checklists WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM checklist_plantillas WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM ipercs WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM iperc_lineas_base WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM equipos WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM repuestos WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM combustible WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM documentos WHERE tenant_id = $1`, [tenantId]);
  await client.query(`DELETE FROM usuarios WHERE tenant_id = $1`, [tenantId]);
}

/** `remapearIds` decide cómo se restauran los ids de cada fila:
 *
 *  - false (restaurar sobre el MISMO tenant que originó el backup): los
 *    ids se preservan tal cual — es seguro porque vaciarDatosDeTenant ya
 *    liberó esos mismos ids antes de insertar, y ningún otro tenant puede
 *    tener una fila con esos ids (son globalmente únicos por tabla). Hace
 *    falta un setval() manual después de cada tabla porque un INSERT con
 *    id explícito no avisa a la secuencia que ese valor ya está en uso.
 *
 *  - true (restaurar en un tenant DISTINTO — clonar): los ids originales
 *    siguen existiendo de verdad en el tenant de origen (no se tocó), así
 *    que reusarlos chocaría contra la PK. Se genera un id nuevo por fila
 *    (UUID nuevo, o dejar que SERIAL asigne el suyo) y se recuerda el
 *    mapeo viejo→nuevo por tabla, para reescribir cualquier FK de una
 *    fila posterior que apunte a esa fila (ver `fks` en TABLAS_TENANT). */
async function restaurarTablas(
  client: PoolClient,
  backup: ContenidoBackup,
  targetTenantId: string,
  remapearIds: boolean
): Promise<Record<string, number>> {
  const tablasRestauradas: Record<string, number> = {};
  const remapPorTabla: Record<string, Map<unknown, unknown>> = {};

  for (const meta of TABLAS_TENANT) {
    const filas = backup.tablas[meta.nombre] ?? [];
    tablasRestauradas[meta.nombre] = filas.length;
    const remapDeEstaTabla = new Map<unknown, unknown>();
    remapPorTabla[meta.nombre] = remapDeEstaTabla;

    for (const filaOriginal of filas) {
      const fila: Record<string, unknown> = { ...filaOriginal, tenant_id: targetTenantId };
      for (const columna of meta.columnasExcluidasAlRestaurar ?? []) {
        delete fila[columna];
      }

      const idOriginal = fila.id;
      if (remapearIds) {
        if (meta.pk === "uuid") {
          fila.id = randomUUID();
        } else {
          delete fila.id; // deja que la secuencia SERIAL asigne uno propio
        }
      }

      for (const [columnaFK, tablaReferenciada] of Object.entries(meta.fks ?? {})) {
        const valorFK = fila[columnaFK];
        if (valorFK != null && remapearIds) {
          fila[columnaFK] = remapPorTabla[tablaReferenciada]?.get(valorFK) ?? valorFK;
        }
      }

      const columnas = Object.keys(fila);
      const placeholders = columnas.map((_, i) => `$${i + 1}`).join(", ");
      const necesitaIdGenerado = remapearIds && meta.pk === "serial";
      const result = await client.query(
        `INSERT INTO ${meta.nombre} (${columnas.join(", ")}) VALUES (${placeholders})${
          necesitaIdGenerado ? " RETURNING id" : ""
        }`,
        columnas.map((c) => fila[c])
      );

      if (remapearIds) {
        remapDeEstaTabla.set(idOriginal, necesitaIdGenerado ? result.rows[0].id : fila.id);
      }
    }

    if (!remapearIds && meta.pk === "serial" && filas.length > 0) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${meta.nombre}', 'id'), COALESCE((SELECT MAX(id) FROM ${meta.nombre}), 1))`
      );
    }
  }

  return tablasRestauradas;
}

/** Restaura un backup sobre `targetTenantId` — SIEMPRE vacía primero los
 *  datos actuales de ese tenant en las tablas de negocio (ver
 *  vaciarDatosDeTenant): es tanto "restaurar sobre un tenant vacío"
 *  (vaciar ahí no hace nada) como "punto de restauración" (vaciar
 *  reemplaza lo que había). Nunca parcial: todo corre en una sola
 *  transacción, si algo falla no queda un tenant a medio restaurar.
 *
 *  token_version de cada usuario restaurado se incrementa después de
 *  insertarlo (no se restaura el valor tal cual venía en el backup): un
 *  restore es, en los hechos, un rollback de estado — cualquier JWT
 *  emitido después del momento del backup tiene que dejar de servir. Sin
 *  este bump, restaurar un backup viejo podría revivir por accidente un
 *  token_version que coincide con el de un JWT que ya se creía revocado. */
export async function restaurarBackupService(
  backupId: string,
  targetTenantId: string,
  contexto: ContextoAuditoria
): Promise<{ tablasRestauradas: Record<string, number> }> {
  const backupRow = await pool.query(`SELECT * FROM tenant_backups WHERE id = $1`, [backupId]);
  if (backupRow.rows.length === 0) {
    throw new AppError(404, "Backup no encontrado");
  }

  const targetTenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [targetTenantId]);
  if (targetTenant.rows.length === 0) {
    throw new AppError(404, "Tenant destino no encontrado");
  }

  const crudo = await leerArchivoBackup(backupRow.rows[0].archivo);
  const backup = JSON.parse(crudo) as ContenidoBackup;
  const remapearIds = targetTenantId !== backup.tenantId;

  const tablasRestauradas = await withTenant(targetTenantId, async (client) => {
    await vaciarDatosDeTenant(client, targetTenantId);
    const resultado = await restaurarTablas(client, backup, targetTenantId, remapearIds);

    if (resultado.usuarios > 0) {
      await client.query(`UPDATE usuarios SET token_version = token_version + 1000 WHERE tenant_id = $1`, [
        targetTenantId,
      ]);
    }

    return resultado;
  });

  await registrarAuditoria({
    accion: "restaurar_backup_tenant",
    tenantId: targetTenantId,
    detalle: { backupId, backupTenantOriginal: backup.tenantId, tablasRestauradas },
    contexto,
  });

  return { tablasRestauradas };
}
