/** tests/combustible.test.ts
 *
 * El módulo no tiene POST de creación (ver combustible.routes.ts: solo GET
 * y PUT /:id/nivel) -- los tanques se cargan directo en la base, no desde
 * la API. Por eso el setup de estos tests inserta filas con withTenant()
 * en vez de un POST, a diferencia del resto de los módulos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";

async function crearTanque(
  tenantId: string,
  data: { tanqueNombre: string; capacidadTotal: number; nivelActual: number }
): Promise<number> {
  const fila = await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO combustible (tenant_id, tanque_nombre, capacidad_total, nivel_actual)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, data.tanqueNombre, data.capacidadTotal, data.nivelActual]
    )
  );
  return fila.rows[0].id;
}

describe("combustible: lectura, actualización de nivel y reglas de negocio", () => {
  let tenantId: string;
  let tenantSlug: string;
  let tanqueId: number;
  const password = "ClaveDePrueba123";
  const agentAdmin = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agentAdmin
      .post("/api/auth/login")
      .send({ tenantSlug, email: creado.usuario.email, password });

    tanqueId = await crearTanque(tenantId, {
      tanqueNombre: "Tanque principal",
      capacidadTotal: 1000,
      nivelActual: 250,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("lista tanques y calcula 'porcentaje' en la BD, no en la app", async () => {
    const res = await agentAdmin.get("/api/erp/combustible");
    expect(res.status).toBe(200);
    const tanque = res.body.find((t: { id: number }) => t.id === tanqueId);
    expect(tanque).toBeTruthy();
    expect(Number(tanque.porcentaje)).toBe(25); // 250/1000 * 100
  });

  it("GET /:id devuelve el tanque con su porcentaje", async () => {
    const res = await agentAdmin.get(`/api/erp/combustible/${tanqueId}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.porcentaje)).toBe(25);
  });

  it("GET /:id de un tanque inexistente da 404", async () => {
    const res = await agentAdmin.get("/api/erp/combustible/999999999");
    expect(res.status).toBe(404);
  });

  it("PUT /:id/nivel actualiza nivel_actual y recalcula porcentaje", async () => {
    const res = await agentAdmin
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 800 });
    expect(res.status).toBe(200);
    expect(Number(res.body.nivel_actual)).toBe(800);
    expect(Number(res.body.porcentaje)).toBe(80); // 800/1000 * 100
  });

  it("PUT nivel de un tanque inexistente da 404", async () => {
    const res = await agentAdmin
      .put("/api/erp/combustible/999999999/nivel")
      .send({ nivel_actual: 500 });
    expect(res.status).toBe(404);
  });

  it("PUT /:id/nivel deja rastro en el historial, no solo sobreescribe nivel_actual", async () => {
    const antes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE combustible_id = $1`,
        [tanqueId]
      )
    );

    const res = await agentAdmin
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 900 });
    expect(res.status).toBe(200);
    expect(Number(res.body.nivel_actual)).toBe(900);

    const despues = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE combustible_id = $1`,
        [tanqueId]
      )
    );
    expect(despues.rows[0].total).toBe(antes.rows[0].total + 1);
  });

  it("un usuario con rol 'lectura' no puede actualizar el nivel (403), pero sí puede leer", async () => {
    const email = `lectura-combustible-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura.post("/api/auth/login").send({ tenantSlug, email, password });

    const lectura = await agentLectura.get("/api/erp/combustible");
    expect(lectura.status).toBe(200);

    const intentoUpdate = await agentLectura
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 100 });
    expect(intentoUpdate.status).toBe(403);
  });
});

describe("combustible: aislamiento entre tenants", () => {
  let tenantAId: string;
  let tenantBId: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    await borrarTenantDePrueba(tenantAId);
    await borrarTenantDePrueba(tenantBId);
  });

  it("un tenant no ve ni puede actualizar el tanque de otro", async () => {
    const a = await crearTenantDePrueba(password);
    const b = await crearTenantDePrueba(password);
    tenantAId = a.tenant.id;
    tenantBId = b.tenant.id;

    const tanqueDeB = await crearTanque(tenantBId, {
      tanqueNombre: "Tanque de B",
      capacidadTotal: 500,
      nivelActual: 100,
    });

    const agentA = request.agent(app);
    await agentA
      .post("/api/auth/login")
      .send({ tenantSlug: a.tenant.slug, email: a.usuario.email, password });

    const listadoDeA = await agentA.get("/api/erp/combustible");
    expect(listadoDeA.body.find((t: { id: number }) => t.id === tanqueDeB)).toBeUndefined();

    const getDirecto = await agentA.get(`/api/erp/combustible/${tanqueDeB}`);
    expect(getDirecto.status).toBe(404);

    const updateAjeno = await agentA
      .put(`/api/erp/combustible/${tanqueDeB}/nivel`)
      .send({ nivel_actual: 0 });
    expect(updateAjeno.status).toBe(404);

    // La fila de B no debe haber cambiado a pesar del intento.
    const filaB = await withTenant(tenantBId, (client) =>
      client.query(`SELECT nivel_actual FROM combustible WHERE id = $1`, [tanqueDeB])
    );
    expect(Number(filaB.rows[0].nivel_actual)).toBe(100);
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en equipos-checklist-iperc.test.ts).
afterAll(async () => {
  await closeDatabase();
});
