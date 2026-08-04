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
import { pool, closeDatabase } from "../src/server/config/database";

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
  afterAll(async () => {
    await closeDatabase();
  });

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
