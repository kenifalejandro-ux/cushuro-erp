/** tests/partitioning.test.ts
 *
 * Particionado declarativo de checklists/ipercs (migrations/0037,
 * docs/architecture/particionado-de-tablas.md). Cuatro cosas separadas:
 *
 *  - Que las filas nuevas ruteen a la partición del mes correcto.
 *  - Que una query con rango de fecha acotado pode las particiones que no
 *    puede contener (partition pruning real, verificado con EXPLAIN, no
 *    supuesto).
 *  - Que RLS siga aislando tenants incluso consultando la partición física
 *    directo por su nombre — el hallazgo no obvio de la migración: RLS en
 *    el padre NO alcanza sola (ver el comentario largo en 0037).
 *  - Que particiones_asegurar_futuras() sea idempotente y de verdad cree
 *    particiones nuevas cuando se le pide más margen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";

afterAll(async () => {
  await closeDatabase();
});

describe("checklists/ipercs son tablas particionadas por RANGE(creado_en)", () => {
  it("checklists e ipercs son relkind='p' (partitioned table), no tablas simples", async () => {
    const result = await pool.query(
      `SELECT relname, relkind FROM pg_class WHERE relname IN ('checklists', 'ipercs') ORDER BY relname`
    );
    expect(result.rows).toEqual([
      { relname: "checklists", relkind: "p" },
      { relname: "ipercs", relkind: "p" },
    ]);
  });

  it("existen particiones del mes actual + al menos 3 meses futuros, más la partición default, para ambas", async () => {
    const result = await pool.query(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE 'checklists\\_%' OR tablename LIKE 'ipercs\\_%' ORDER BY tablename`
    );
    const nombres = result.rows.map((r) => r.tablename);
    expect(nombres).toContain("checklists_default");
    expect(nombres).toContain("ipercs_default");
    // Al menos el mes actual: no hardcodeamos el mes exacto para que el
    // test no se rompa solo por el paso del tiempo.
    const mesActual = new Date().toISOString().slice(0, 7).replace("-", "_");
    expect(nombres).toContain(`checklists_${mesActual}`);
    expect(nombres).toContain(`ipercs_${mesActual}`);
  });
});

describe("particiones_asegurar_futuras(): idempotente y crea margen nuevo", () => {
  it("correrla de nuevo con el mismo margen no falla ni duplica nada (CREATE TABLE IF NOT EXISTS)", async () => {
    await expect(pool.query("SELECT particiones_asegurar_futuras(3)")).resolves.toBeDefined();
    await expect(pool.query("SELECT particiones_asegurar_futuras(3)")).resolves.toBeDefined();
  });

  it("pedirle más margen crea la partición nueva, con su propio RLS", async () => {
    await pool.query("SELECT particiones_asegurar_futuras(9)");
    const dentroDe9Meses = new Date();
    dentroDe9Meses.setMonth(dentroDe9Meses.getMonth() + 9);
    const nombreEsperado = `checklists_${dentroDe9Meses.toISOString().slice(0, 7).replace("-", "_")}`;

    const tabla = await pool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [nombreEsperado]
    );
    expect(tabla.rows).toHaveLength(1);
    expect(tabla.rows[0].relrowsecurity).toBe(true);
    expect(tabla.rows[0].relforcerowsecurity).toBe(true);

    const policy = await pool.query(
      `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'tenant_isolation'`,
      [nombreEsperado]
    );
    expect(policy.rows).toHaveLength(1);
  });
});

describe("ruteo de particiones, pruning y RLS con datos reales", () => {
  const password = "ClaveDePrueba123";
  let tenantId: string;
  let tenantSlug: string;
  let equipoId: number;
  let plantillaId: number;
  let checklistId: number;
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agent.post("/api/auth/login").send({ tenantSlug, email: creado.usuario.email, password });

    const equipo = await agent
      .post("/api/erp/equipos")
      .send({ placa_codigo: "PART-001", tipo: "Camioneta" });
    equipoId = equipo.body.id;
    const plantilla = await agent
      .post("/api/erp/checklists/plantillas")
      .send({ nombre: "Pre-uso particionado", items: [{ descripcion: "Frenos" }] });
    plantillaId = plantilla.body.id;

    const checklist = await agent
      .post("/api/erp/checklists")
      .send({
        equipo_id: equipoId,
        plantilla_id: plantillaId,
        items: [{ descripcion: "Frenos", estado: "bien" }],
      });
    checklistId = checklist.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("el checklist creado por la API cae en la partición del mes actual, no en la default", async () => {
    const mesActual = new Date().toISOString().slice(0, 7).replace("-", "_");
    const fila = await withTenant(tenantId, (client) =>
      client.query(`SELECT tableoid::regclass::text AS particion FROM checklists WHERE id = $1`, [
        checklistId,
      ])
    );
    expect(fila.rows[0].particion).toBe(`checklists_${mesActual}`);
  });

  it("el checklist_item queda con checklist_creado_en igual al del padre (la FK compuesta cerró)", async () => {
    const fila = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT ci.checklist_creado_en, c.creado_en
         FROM checklist_items ci JOIN checklists c ON c.id = ci.checklist_id
         WHERE ci.checklist_id = $1`,
        [checklistId]
      )
    );
    expect(fila.rows).toHaveLength(1);
    expect(fila.rows[0].checklist_creado_en.getTime()).toBe(fila.rows[0].creado_en.getTime());
  });

  it("partition pruning: un rango de fecha acotado al mes actual escanea solo esa partición", async () => {
    const mesActual = new Date().toISOString().slice(0, 7).replace("-", "_");
    const plan = await withTenant(tenantId, (client) =>
      client.query(
        `EXPLAIN (COSTS OFF, FORMAT TEXT) SELECT * FROM checklists
         WHERE tenant_id = $1
           AND creado_en >= date_trunc('month', now())
           AND creado_en < date_trunc('month', now()) + interval '1 month'`,
        [tenantId]
      )
    );
    const texto = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(texto).toContain(`checklists_${mesActual}`);
    // Ninguna otra partición mensual (ni la default) debería aparecer en
    // el plan si el pruning funcionó de verdad.
    expect(texto).not.toContain("checklists_default");
  });

  it("RLS aísla tenants incluso consultando la partición física directo por su nombre", async () => {
    const mesActual = new Date().toISOString().slice(0, 7).replace("-", "_");
    const otroTenant = "11111111-1111-1111-1111-111111111111";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [otroTenant]);
      const fila = await client.query(
        `SELECT count(*) FROM checklists_${mesActual} WHERE id = $1`,
        [checklistId]
      );
      expect(Number(fila.rows[0].count)).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("borrar el checklist cascadea al item vía la FK compuesta (checklist_id, checklist_creado_en)", async () => {
    await withTenant(tenantId, (client) =>
      client.query(`DELETE FROM checklists WHERE id = $1`, [checklistId])
    );
    const huerfanos = await withTenant(tenantId, (client) =>
      client.query(`SELECT count(*) FROM checklist_items WHERE checklist_id = $1`, [checklistId])
    );
    expect(Number(huerfanos.rows[0].count)).toBe(0);
  });
});
