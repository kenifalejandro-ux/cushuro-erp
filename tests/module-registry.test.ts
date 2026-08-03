/** tests/module-registry.test.ts
 *
 * Parte del Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md):
 * src/modules/registry.ts es la fuente de verdad en código de qué módulos
 * existen, pero el enum `modulo_erp` de Postgres (migrations/0008 en
 * adelante) sigue siendo una lista aparte a propósito — da un CHECK real
 * a nivel de base de datos que TypeScript no puede dar. Este test es el
 * único lugar que garantiza que ambas listas coincidan; si alguien agrega
 * un módulo al registry sin la migración que suma el valor al enum (o al
 * revés), este test falla en vez de fallar en silencio la primera vez que
 * alguien intente activar ese módulo desde el panel de plataforma.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, closeDatabase } from "../src/server/config/database";
import { MODULOS_ERP } from "../src/modules/registry";

describe("registry de módulos vs enum modulo_erp de Postgres", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("MODULOS_ERP (código) y el enum modulo_erp (BD) tienen exactamente el mismo set", async () => {
    const result = await pool.query<{ modulo: string }>(
      `SELECT unnest(enum_range(NULL::modulo_erp))::text AS modulo`
    );
    const modulosEnBd = result.rows.map((r) => r.modulo).sort();
    const modulosEnCodigo = [...MODULOS_ERP].sort();

    expect(modulosEnCodigo).toEqual(modulosEnBd);
  });

  it("cada módulo del registry declara sus tablas de backup como subconjunto válido de raices", async () => {
    const { MODULOS } = await import("../src/modules/registry");
    for (const modulo of MODULOS) {
      const nombresTablas = new Set(modulo.tablas.map((t) => t.nombre));
      for (const raiz of modulo.raices) {
        expect(
          nombresTablas.has(raiz),
          `El módulo "${modulo.id}" declara "${raiz}" en raices pero no está en tablas`
        ).toBe(true);
      }
    }
  });
});
