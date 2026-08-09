/** tests/rls-coverage.test.ts
 *
 * Parte del Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md):
 * antes de este test, que una tabla nueva con tenant_id tuviera RLS
 * dependía por completo de que quien escribiera la migración copiara a
 * mano el bloque `ENABLE/FORCE ROW LEVEL SECURITY` + policy
 * `tenant_isolation` de una migración anterior — nada fallaba si se le
 * olvidaba. Este test recorre pg_class/information_schema directamente
 * (no una lista mantenida a mano) y falla si aparece una tabla con
 * tenant_id sin ese blindaje, salvo que esté en ALLOWLIST_SIN_RLS con una
 * razón documentada.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";
import { crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";

// Un solo afterAll para todo el archivo, no uno por describe: closeDatabase()
// cierra el pool COMPARTIDO de la app -- si quedara anidado dentro del
// primer describe, se dispararía apenas ese describe terminara sus tests,
// cerrando el pool mientras el segundo describe todavía lo necesita (nuevas
// llamadas a pool.connect() después de pool.end() fallan de inmediato).
// Mismo patrón que tests/scim.test.ts, que también tiene más de un describe.
afterAll(async () => {
  await closeDatabase();
});

// Tablas de PLATAFORMA (dueño del ERP) que a propósito no tienen RLS: el
// panel necesita leer/escribir cualquier tenant fuera de una transacción
// con app.tenant_id seteado (nunca pasan por withTenant()) — mismo
// criterio documentado en migrations/0008, 0011, 0012, 0022, 0023, 0026,
// 0028, y en refresh_tokens/reset_tokens (hace falta resolver el tenant
// ANTES de poder leer usuarios bajo RLS).
const ALLOWLIST_SIN_RLS = new Set([
  "tenant_modulos",
  // Límites de volumen por tenant (migración 0033). Mismo criterio que
  // tenant_modulos: los administra el panel de plataforma para cualquier
  // tenant, fuera de toda transacción con app.tenant_id seteado. Además,
  // un tenant nunca lee su propia cuota directamente — la ve resuelta en
  // la respuesta de la API cuando se le bloquea una creación.
  "tenant_cuotas",
  "platform_audit_log",
  "tenant_scim_config",
  "refresh_tokens",
  "reset_tokens",
  "tenant_metricas_horarias",
  "tenant_backups",
  "tenant_sso_config",
]);

interface FilaTabla {
  tabla: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  tiene_policy_tenant_isolation: boolean;
}

describe("cobertura de RLS: toda tabla con tenant_id debe tener FORCE RLS + policy tenant_isolation", () => {
  it("no hay tablas de negocio con tenant_id sin RLS forzado (o sin estar en la allowlist)", async () => {
    const result = await pool.query<FilaTabla>(`
      SELECT
        c.relname AS tabla,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation'
        ) AS tiene_policy_tenant_isolation
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
        )
      ORDER BY c.relname
    `);

    const sinRlsCompleto = result.rows.filter(
      (fila) =>
        !ALLOWLIST_SIN_RLS.has(fila.tabla) &&
        (!fila.rls_enabled || !fila.rls_forced || !fila.tiene_policy_tenant_isolation)
    );

    expect(
      sinRlsCompleto,
      `Tablas con tenant_id sin RLS completo (ENABLE + FORCE + policy tenant_isolation): ` +
        JSON.stringify(sinRlsCompleto, null, 2) +
        `\nSi es intencional (tabla de plataforma), agregala a ALLOWLIST_SIN_RLS en este archivo con el motivo.`
    ).toEqual([]);

    // Extra: nada en la allowlist debería haber quedado obsoleto (tabla
    // borrada) — no falla el test, pero avisa si el registro divergió.
    const nombresReales = new Set(result.rows.map((f) => f.tabla));
    const allowlistObsoleta = [...ALLOWLIST_SIN_RLS].filter((t) => !nombresReales.has(t));
    if (allowlistObsoleta.length > 0) {
      console.warn("ALLOWLIST_SIN_RLS tiene tablas que ya no existen:", allowlistObsoleta);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// El test de arriba solo audita CATÁLOGO (¿existe la policy?) -- no prueba
// que la policy filtre de verdad. Eso fue justo lo que dejó pasar, durante
// meses, que `mincoreerp_app` fuera el rol SUPERUSER de Postgres en CI (un
// superuser se salta RLS siempre, con o sin FORCE): el catálogo decía que
// todo estaba bien, porque las policies existían -- solo que nadie las
// hacía cumplir. Ver ci.yml, paso "Crear el rol de la app".
//
// Este bloque ejercita RLS de verdad: dos tenants reales, una fila de cada
// uno en `repuestos`, y una lectura desde la sesión de un tenant SIN
// `WHERE tenant_id` en el SQL -- si alguien debilita la policy (o si vuelve
// el bug del rol superuser en CI), este test falla porque la fila ajena
// aparece en el resultado, no porque un catálogo diga que algo falta.
// ═══════════════════════════════════════════════════════════════════════════
describe("RLS: comportamiento real, no solo catálogo", () => {
  it("una sesión con app.tenant_id de A no ve la fila de B en repuestos, sin filtrar por tenant_id en el SQL", async () => {
    const tenantA = await crearTenantDePrueba();
    const tenantB = await crearTenantDePrueba();

    try {
      await withTenant(tenantA.tenant.id, (client) =>
        client.query(
          `INSERT INTO repuestos (tenant_id, codigo, nombre) VALUES ($1, 'RLS-TEST-A', 'Repuesto de A')`,
          [tenantA.tenant.id]
        )
      );
      await withTenant(tenantB.tenant.id, (client) =>
        client.query(
          `INSERT INTO repuestos (tenant_id, codigo, nombre) VALUES ($1, 'RLS-TEST-B', 'Repuesto de B')`,
          [tenantB.tenant.id]
        )
      );

      // Sin "WHERE tenant_id = ..." a propósito: si esta query devolviera
      // la fila de B, sería porque la policy de Postgres no está filtrando
      // -- no porque el código de la app se haya olvidado del filtro (esa
      // defensa en profundidad es justamente lo que este test NO debe
      // depender de ella).
      const desdeA = await withTenant(tenantA.tenant.id, (client) =>
        client.query(`SELECT codigo, tenant_id FROM repuestos WHERE codigo LIKE 'RLS-TEST-%'`)
      );
      const codigosVistosPorA = desdeA.rows.map((f) => f.codigo);
      expect(codigosVistosPorA).toContain("RLS-TEST-A");
      expect(codigosVistosPorA).not.toContain("RLS-TEST-B");
      expect(desdeA.rows.every((f) => f.tenant_id === tenantA.tenant.id)).toBe(true);

      // Y en la otra dirección, para no probar solo un sentido de la policy.
      const desdeB = await withTenant(tenantB.tenant.id, (client) =>
        client.query(`SELECT codigo, tenant_id FROM repuestos WHERE codigo LIKE 'RLS-TEST-%'`)
      );
      const codigosVistosPorB = desdeB.rows.map((f) => f.codigo);
      expect(codigosVistosPorB).toContain("RLS-TEST-B");
      expect(codigosVistosPorB).not.toContain("RLS-TEST-A");
    } finally {
      await borrarTenantDePrueba(tenantA.tenant.id);
      await borrarTenantDePrueba(tenantB.tenant.id);
    }
  });
});
