/** scripts/diagnosticoQueries.ts
 *
 * Diagnóstico de queries pesadas — parte de la auditoría de rendimiento
 * multi-tenant (docs/architecture/database-performance-guidelines.md).
 *
 * Uso:
 *   npx tsx scripts/diagnosticoQueries.ts                    # top 10, tenant automático
 *   npx tsx scripts/diagnosticoQueries.ts --top=20            # top 20
 *   npx tsx scripts/diagnosticoQueries.ts --tenant=cushuro    # tenant puntual
 *
 * Dos modos, no uno solo:
 *
 *   1) pg_stat_statements — el diagnóstico real de producción: qué se
 *      ejecutó de verdad, cuánto tiempo acumulado, cuántas veces. Requiere
 *      que la extensión esté en `shared_preload_libraries` (config a nivel
 *      de servidor, necesita reinicio) — algo que este script NO puede
 *      hacer por sí solo, y que el rol de la app (mincoreerp_app, no
 *      superuser — ver .env.example) tampoco puede instalar. Si no está
 *      disponible, el script lo dice explícito con los pasos exactos.
 *
 *   2) EXPLAIN ANALYZE contra las queries reales de cada uno de los 7
 *      módulos — corre siempre, no depende de ninguna extensión ni de
 *      configuración de servidor. Sirve tanto de fallback en un entorno
 *      sin pg_stat_statements (como este sandbox) como de smoke test
 *      rápido después de tocar índices: si algo que debería usar un
 *      Index Scan aparece como Seq Scan, este script lo marca con ⚠.
 *
 * Corre con withTenant() — igual que la app real — para que las policies
 * de RLS se evalúen exactamente como en producción, no con un client
 * "de superusuario" que se saltee la parte que más importa auditar.
 */
import { pool, withTenant, closeDatabase } from "../src/server/config/database";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  })
);
const TOP_N = Number(args.get("top") ?? 10);
const TENANT_SLUG = args.get("tenant");

async function resolverTenantId(): Promise<{ id: string; slug: string } | null> {
  const result = TENANT_SLUG
    ? await pool.query(`SELECT id, slug FROM tenants WHERE slug = $1`, [TENANT_SLUG])
    : await pool.query(`SELECT id, slug FROM tenants ORDER BY creado_en ASC LIMIT 1`);
  return result.rows[0] ?? null;
}

// ── Modo 1: pg_stat_statements ──────────────────────────────────────────

async function diagnosticoPgStatStatements(): Promise<boolean> {
  const instalada = await pool.query(
    `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`
  );

  if (instalada.rows.length === 0) {
    console.log("\n─── pg_stat_statements: NO instalada ───────────────────────────────");
    console.log("Para habilitarla en un servidor con acceso de superusuario:");
    console.log("  1) agregar 'pg_stat_statements' a shared_preload_libraries en postgresql.conf");
    console.log("     (Railway/managed Postgres: suele ser un toggle en el panel del proveedor)");
    console.log("  2) reiniciar el servidor de Postgres (cambio a nivel de proceso, no de sesión)");
    console.log("  3) como superuser: CREATE EXTENSION pg_stat_statements;");
    console.log("El rol de la app (mincoreerp_app) no tiene permiso para hacer esto solo —");
    console.log("es intencional, ver .env.example sobre por qué la app no corre como superuser.");
    console.log("Mientras tanto, este script sigue con el diagnóstico por EXPLAIN ANALYZE.\n");
    return false;
  }

  // total_exec_time/mean_exec_time (PG13+) vs total_time/mean_time (PG<13)
  // — se intenta el nombre nuevo primero, se cae al viejo si la columna
  // no existe, en vez de asumir una sola versión de Postgres.
  const columnas = { tiempoTotal: "total_exec_time", tiempoPromedio: "mean_exec_time" };
  let filas;
  try {
    filas = await pool.query(`
      SELECT query, calls, ${columnas.tiempoTotal} AS tiempo_total_ms, ${columnas.tiempoPromedio} AS tiempo_promedio_ms, rows
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY ${columnas.tiempoTotal} DESC
      LIMIT $1
    `, [TOP_N]);
  } catch {
    filas = await pool.query(`
      SELECT query, calls, total_time AS tiempo_total_ms, mean_time AS tiempo_promedio_ms, rows
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_time DESC
      LIMIT $1
    `, [TOP_N]);
  }

  console.log(`\n─── Top ${TOP_N} queries por tiempo total acumulado (pg_stat_statements) ───`);
  for (const [i, fila] of filas.rows.entries()) {
    const queryCorta = String(fila.query).replace(/\s+/g, " ").slice(0, 140);
    console.log(
      `${i + 1}. [${Number(fila.tiempo_total_ms).toFixed(1)}ms total, ` +
        `${Number(fila.tiempo_promedio_ms).toFixed(2)}ms promedio, ${fila.calls} llamadas] ${queryCorta}`
    );
  }
  console.log("");
  return true;
}

// ── Modo 2: EXPLAIN ANALYZE contra queries representativas ──────────────

interface QueryRepresentativa {
  nombre: string;
  sql: string;
  params: (tenantId: string) => unknown[];
}

// Misma forma exacta que cada *.repository.ts — no una aproximación. Si
// el repository cambia una query, esta lista puede quedar desactualizada;
// es una lista mantenida a mano a propósito, mismo tradeoff que
// TABLAS_EXCLUIDAS en los tests de auditoría (ver ADR-0002: no todo vale
// la pena derivarlo de una sola fuente).
const QUERIES_REPRESENTATIVAS: QueryRepresentativa[] = [
  {
    nombre: "repuestos.findAll (listado paginado)",
    sql: `SELECT id, codigo, nombre, categoria, stock, COUNT(*) OVER() AS total_count
          FROM repuestos WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "combustible.findAll (listado paginado)",
    sql: `SELECT id, COUNT(*) OVER() AS total_count
          FROM combustible WHERE tenant_id = $1 ORDER BY id ASC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "documentos.findAll (listado por vencimiento)",
    sql: `SELECT id, COUNT(*) OVER() AS total_count
          FROM documentos WHERE tenant_id = $1 ORDER BY fecha_vencimiento ASC NULLS LAST LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "equipos.findAll (listado paginado)",
    sql: `SELECT id, placa_codigo, COUNT(*) OVER() AS total_count
          FROM equipos WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "checklists.findPlantillas (listado paginado)",
    sql: `SELECT id, nombre, COUNT(*) OVER() AS total_count
          FROM checklist_plantillas WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "checklists.findAll (con JOIN a equipos/usuarios)",
    sql: `SELECT c.id, c.equipo_id, e.placa_codigo, c.usuario_id, u.nombre AS usuario_nombre,
                 COUNT(*) OVER() AS total_count
          FROM checklists c
          JOIN equipos e ON e.id = c.equipo_id
          JOIN usuarios u ON u.id = c.usuario_id
          WHERE c.tenant_id = $1 ORDER BY c.id DESC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "iperc.findLineasBase (listado paginado)",
    sql: `SELECT id, proceso_actividad, COUNT(*) OVER() AS total_count
          FROM iperc_lineas_base WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
  {
    nombre: "iperc.findAll (con JOIN a equipos/usuarios, LEFT JOIN aprobador)",
    sql: `SELECT i.id, i.tipo, i.area_frente, i.equipo_id, e.placa_codigo,
                 i.usuario_id, u.nombre AS usuario_nombre, ap.nombre AS aprobado_por_nombre,
                 COUNT(*) OVER() AS total_count
          FROM ipercs i
          JOIN usuarios u ON u.id = i.usuario_id
          LEFT JOIN equipos e ON e.id = i.equipo_id
          LEFT JOIN usuarios ap ON ap.id = i.aprobado_por
          WHERE i.tenant_id = $1 ORDER BY i.id DESC LIMIT $2 OFFSET $3`,
    params: (t) => [t, 50, 0],
  },
];

async function diagnosticoExplainRepresentativo(tenantId: string, tenantSlug: string): Promise<void> {
  console.log(`─── EXPLAIN ANALYZE de las queries representativas de cada módulo ───`);
  console.log(`Tenant usado: ${tenantSlug} (${tenantId})`);
  console.log(
    "Ojo: con pocas filas, Postgres elige Seq Scan porque ES más barato que el índice " +
      "(el planner no es tonto) — un ⚠ acá solo importa si el tenant tiene volumen real de datos.\n"
  );

  for (const q of QUERIES_REPRESENTATIVAS) {
    await withTenant(tenantId, async (client) => {
      const explain = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`,
        q.params(tenantId)
      );
      const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
      const tieneSeqScan = /Seq Scan/.test(plan);
      const tiempoMatch = plan.match(/Execution Time: ([\d.]+) ms/);
      const tiempo = tiempoMatch ? `${tiempoMatch[1]}ms` : "?";

      console.log(`${tieneSeqScan ? "⚠ " : "✓ "}${q.nombre} — ${tiempo}${tieneSeqScan ? "  (Seq Scan detectado, revisar índices)" : ""}`);
      if (tieneSeqScan) {
        console.log(plan.split("\n").map((l) => `    ${l}`).join("\n"));
      }
    });
  }
  console.log("");
}

async function main() {
  const usoPgStatStatements = await diagnosticoPgStatStatements();

  const tenant = await resolverTenantId();
  if (!tenant) {
    console.log("No hay ningún tenant en la base — nada contra qué correr EXPLAIN ANALYZE.");
    if (!usoPgStatStatements) {
      console.log("Creá un tenant de prueba (POST /api/platform/tenants) y volvé a correr este script.");
    }
  } else {
    await diagnosticoExplainRepresentativo(tenant.id, tenant.slug);
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error("Error corriendo el diagnóstico:", err);
  process.exit(1);
});
