/** tests/combustible.test.ts
 *
 * Hasta la Fase A (migrations/0057) el módulo no tenía POST de creación
 * (ver combustible.routes.ts: solo GET y PUT /:id/nivel) -- los tanques se
 * cargaban directo en la base. El helper de abajo sigue insertando con
 * withTenant() para los tests de lecturas/nivel (no dependen de la validación
 * Zod del ABM nuevo), pero ya completa las columnas NOT NULL que agregó
 * 0057 -- sin esto, el INSERT crudo revienta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { crearUsuarioService } from "../src/server/services/auth.service";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { MAX_FILAS_CARGA_MASIVA_TANQUES } from "../src/server/schemas/combustible.schema";

async function crearTanque(
  tenantId: string,
  data: { tanqueNombre: string; capacidadTotal: number; nivelActual: number }
): Promise<number> {
  const fila = await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO combustible (
         tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
         capacidad_total, nivel_actual
       )
       VALUES ($1, $2, $3, 'diesel_b5', 'gal', 'fijo', $4, $5) RETURNING id`,
      [tenantId, idUnico("TQ"), data.tanqueNombre, data.capacidadTotal, data.nivelActual]
    )
  );
  return fila.rows[0].id;
}

/** Payload mínimo válido para POST /api/erp/combustible -- reutilizado por
 *  los tests de CRUD de abajo. Trae también nivel_minimo/moneda/activo:
 *  crearTanqueCombustibleSchema los tiene con default y los ignora si
 *  sobran, pero actualizarTanqueCombustibleSchema (PUT) los EXIGE -- este
 *  mismo payload sirve para los dos sin duplicar el helper. */
function payloadTanque(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    codigo: idUnico("TQ"),
    tanque_nombre: "Tanque de prueba",
    tipo_combustible: "diesel_b5",
    unidad: "gal",
    tipo_punto: "fijo",
    capacidad_total: 1000,
    nivel_minimo: 0,
    moneda: "PEN",
    activo: true,
    ...overrides,
  };
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

  it("un tenant no puede editar ni desactivar el tanque de otro (404)", async () => {
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

    const updateAjeno = await agentA
      .put(`/api/erp/combustible/${tanqueDeB}`)
      .send(payloadTanque({ tanque_nombre: "Hackeado" }));
    expect(updateAjeno.status).toBe(404);

    const deleteAjeno = await agentA.delete(`/api/erp/combustible/${tanqueDeB}`);
    expect(deleteAjeno.status).toBe(404);

    const filaB = await withTenant(tenantBId, (client) =>
      client.query(`SELECT tanque_nombre, activo FROM combustible WHERE id = $1`, [tanqueDeB])
    );
    expect(filaB.rows[0].tanque_nombre).toBe("Tanque de B");
    expect(filaB.rows[0].activo).toBe(true);
  });
});

describe("combustible: ABM de tanques (Fase A)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("crea un tanque con los campos mínimos -- defaults de nivel_actual/nivel_minimo/moneda", async () => {
    const res = await agent.post("/api/erp/combustible").send(payloadTanque());
    expect(res.status).toBe(201);
    expect(Number(res.body.nivel_actual)).toBe(0);
    expect(Number(res.body.nivel_minimo)).toBe(0);
    expect(res.body.moneda).toBe("PEN");
    expect(res.body.activo).toBe(true);
    expect(Number(res.body.costo_promedio)).toBe(0);
    expect(Number(res.body.porcentaje)).toBe(0);
  });

  it("rechaza un tipo_combustible fuera del enum", async () => {
    const res = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ tipo_combustible: "gasolina_84" }));
    expect(res.status).toBe(400);
  });

  it("rechaza capacidad_total <= 0 (guarda del schema, antes de tocar la base)", async () => {
    const res = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ capacidad_total: 0 }));
    expect(res.status).toBe(400);
  });

  it("rechaza un código duplicado dentro del mismo tenant", async () => {
    const codigo = idUnico("DUP");
    const primero = await agent.post("/api/erp/combustible").send(payloadTanque({ codigo }));
    expect(primero.status).toBe(201);

    const segundo = await agent.post("/api/erp/combustible").send(payloadTanque({ codigo }));
    expect(segundo.status).toBe(500);
  });

  it("actualiza un tanque -- PUT no acepta nivel_actual, ese camino es /lecturas", async () => {
    const creado = await agent.post("/api/erp/combustible").send(payloadTanque());
    const res = await agent.put(`/api/erp/combustible/${creado.body.id}`).send({
      codigo: creado.body.codigo,
      tanque_nombre: "Editado",
      tipo_combustible: "gasolina_90",
      unidad: "L",
      tipo_punto: "surtidor",
      capacidad_total: 2000,
      nivel_minimo: 50,
      moneda: "USD",
      activo: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.tanque_nombre).toBe("Editado");
    expect(res.body.tipo_punto).toBe("surtidor");
    // nivel_actual sigue el que tenía antes de editar, no lo tocó el PUT.
    expect(Number(res.body.nivel_actual)).toBe(0);
  });

  it("PUT /:id de un tanque inexistente da 404", async () => {
    const res = await agent.put("/api/erp/combustible/999999999").send(payloadTanque());
    expect(res.status).toBe(404);
  });

  it("DELETE es soft-delete: la fila y su historial de lecturas sobreviven", async () => {
    const creado = await agent.post("/api/erp/combustible").send(payloadTanque());
    const tanqueId = creado.body.id;

    await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanqueId,
      nivel: 42,
    });

    const del = await agent.delete(`/api/erp/combustible/${tanqueId}`);
    expect(del.status).toBe(200);

    const filaDirecta = await withTenant(tenantId, (client) =>
      client.query(`SELECT activo FROM combustible WHERE id = $1`, [tanqueId])
    );
    expect(filaDirecta.rows[0].activo).toBe(false);

    const lecturas = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE combustible_id = $1`,
        [tanqueId]
      )
    );
    expect(lecturas.rows[0].total).toBeGreaterThan(0);

    // El tanque desactivado sigue apareciendo en el listado (soft-delete,
    // no desaparece) -- distinto de un DELETE real.
    const listado = await agent.get("/api/erp/combustible");
    const fila = listado.body.find((t: { id: number }) => t.id === tanqueId);
    expect(fila).toBeTruthy();
    expect(fila.activo).toBe(false);
  });

  it("DELETE de un tanque inexistente da 404", async () => {
    const res = await agent.delete("/api/erp/combustible/999999999");
    expect(res.status).toBe(404);
  });

  it("un usuario con rol 'lectura' no puede crear tanques (403) pero sí puede listarlos", async () => {
    const email = `lectura-tanques-${Date.now()}@test.local`;
    const tenantSlugRes = await withTenant(tenantId, (client) =>
      client.query(`SELECT slug FROM tenants WHERE id = $1`, [tenantId])
    );
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura
      .post("/api/auth/login")
      .send({ tenantSlug: tenantSlugRes.rows[0].slug, email, password });

    const intento = await agentLectura.post("/api/erp/combustible").send(payloadTanque());
    expect(intento.status).toBe(403);

    const listado = await agentLectura.get("/api/erp/combustible");
    expect(listado.status).toBe(200);
  });

  it("carga masiva (bulk) inserta varios tanques y reimportar el mismo código actualiza", async () => {
    const codigo = idUnico("BULK");
    const primera = await agent
      .post("/api/erp/combustible/bulk")
      .send([payloadTanque({ codigo, tanque_nombre: "Versión 1" })]);
    expect(primera.status).toBe(201);
    expect(primera.body.insertados).toBe(1);

    const segunda = await agent
      .post("/api/erp/combustible/bulk")
      .send([payloadTanque({ codigo, tanque_nombre: "Versión 2" })]);
    expect(segunda.status).toBe(201);

    const listado = await agent.get("/api/erp/combustible");
    const filasConEseCodigo = listado.body.filter((t: { codigo: string }) => t.codigo === codigo);
    expect(filasConEseCodigo).toHaveLength(1);
    expect(filasConEseCodigo[0].tanque_nombre).toBe("Versión 2");
  });

  it("bulk rechaza un array vacío", async () => {
    const res = await agent.post("/api/erp/combustible/bulk").send([]);
    expect(res.status).toBe(400);
  });

  it("bulk rechaza más filas que el máximo permitido", async () => {
    const filas = Array.from({ length: MAX_FILAS_CARGA_MASIVA_TANQUES + 1 }, (_, i) =>
      payloadTanque({ codigo: `MAX-${i}` })
    );
    const res = await agent.post("/api/erp/combustible/bulk").send(filas);
    expect(res.status).toBe(400);
  });

  it("GET /:id/lecturas devuelve el histórico paginado del tanque", async () => {
    const creado = await agent.post("/api/erp/combustible").send(payloadTanque());
    const tanqueId = creado.body.id;

    await agent.post("/api/erp/combustible/lecturas").send({ combustible_id: tanqueId, nivel: 10 });
    await agent.post("/api/erp/combustible/lecturas").send({ combustible_id: tanqueId, nivel: 20 });

    const res = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it("GET /:id/lecturas de un tanque inexistente da 404", async () => {
    const res = await agent.get("/api/erp/combustible/999999999/lecturas");
    expect(res.status).toBe(404);
  });
});

describe("combustible: una lectura no puede superar la capacidad del tanque", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let tanqueId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const tanque = await agent
      .post("/api/erp/combustible")
      .send(payloadTanque({ capacidad_total: 1000 }));
    tanqueId = tanque.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("rechaza con 400 una lectura mayor que la capacidad, y NO la guarda", async () => {
    const res = await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capacidad/i);

    // Ni la lectura entró al historial ni el tanque cambió de nivel.
    const lecturas = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    expect(lecturas.body.data.some((l: { nivel: string }) => Number(l.nivel) === 5000)).toBe(false);
  });

  it("acepta una lectura EXACTAMENTE igual a la capacidad (el tanque lleno es válido)", async () => {
    const res = await agent
      .post("/api/erp/combustible/lecturas")
      .send({ combustible_id: tanqueId, nivel: 1000 });
    expect(res.status).toBe(201);
  });

  it("el endpoint legacy PUT /:id/nivel también bloquea, con 400 y no 404", async () => {
    // El legacy mapea "no existe en este tenant" a 404 por compatibilidad;
    // esto NO es eso -- el tanque existe, el dato es imposible.
    const res = await agent
      .put(`/api/erp/combustible/${tanqueId}/nivel`)
      .send({ nivel_actual: 99999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capacidad/i);
  });
});

describe("combustible: anulación de lecturas (migración 0058)", () => {
  let tenantId: string;
  let tenantSlug: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    await agent.post("/api/auth/login").send({ tenantSlug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  /** Tanque nuevo + dos lecturas en orden cronológico. Devuelve los ids que
   *  hacen falta para anular y verificar el recálculo.
   *
   *  Los `leido_en` se calculan HACIA ADELANTE desde ahora, no con fechas
   *  fijas: `create` deja `fecha_actualizacion = NOW()`, y el UPDATE
   *  condicional de registrarLectura solo aplica una lectura si es
   *  POSTERIOR a esa marca. Con fechas fijas del pasado las lecturas se
   *  guardan pero no mueven `nivel_actual`, y el test mediría otra cosa. */
  async function tanqueConDosLecturas() {
    const tanque = await agent.post("/api/erp/combustible").send(payloadTanque());
    const base = Date.now();
    const primera = await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanque.body.id,
      nivel: 800,
      leido_en: new Date(base + 60_000).toISOString(),
    });
    const segunda = await agent.post("/api/erp/combustible/lecturas").send({
      combustible_id: tanque.body.id,
      nivel: 500,
      leido_en: new Date(base + 120_000).toISOString(),
    });
    return {
      tanqueId: tanque.body.id as number,
      primeraId: primera.body.lectura.id as number,
      segundaId: segunda.body.lectura.id as number,
    };
  }

  it("anular la lectura MÁS RECIENTE hace retroceder el nivel a la anterior", async () => {
    const { tanqueId, segundaId } = await tanqueConDosLecturas();

    const antes = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(antes.body.nivel_actual)).toBe(500);

    const res = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "error de tipeo: se registró 500 en vez de 800" });
    expect(res.status).toBe(200);
    expect(res.body.lectura.anulada_en).toBeTruthy();

    // El nivel vuelve a la lectura vigente anterior -- esto es lo que el
    // UPDATE condicional de registrarLectura NO puede hacer solo (solo sabe
    // avanzar en el tiempo, ver recalcularNivelDesdeUltimaLectura).
    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(despues.body.nivel_actual)).toBe(800);
  });

  it("la lectura anulada NO se borra: sigue en el historial con su motivo y autor", async () => {
    const { tanqueId, segundaId } = await tanqueConDosLecturas();
    await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "se midió el tanque equivocado" });

    const historial = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    const fila = historial.body.data.find((l: { id: number }) => l.id === segundaId);
    expect(fila).toBeTruthy();
    expect(Number(fila.nivel)).toBe(500); // el número original queda intacto
    expect(fila.motivo_anulacion).toBe("se midió el tanque equivocado");
    expect(fila.anulada_por_nombre).toBeTruthy();
  });

  it("anular una lectura que NO es la última deja el nivel donde está", async () => {
    const { tanqueId, primeraId } = await tanqueConDosLecturas();

    const res = await agent
      .patch(`/api/erp/combustible/lecturas/${primeraId}/anular`)
      .send({ motivo: "lectura vieja mal cargada" });
    expect(res.status).toBe(200);

    // La más reciente sigue vigente, así que manda ella.
    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    expect(Number(despues.body.nivel_actual)).toBe(500);
  });

  it("si se anulan TODAS las lecturas, el nivel queda como está (no se pone en 0)", async () => {
    const { tanqueId, primeraId, segundaId } = await tanqueConDosLecturas();
    await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "anulo la segunda" });
    await agent
      .patch(`/api/erp/combustible/lecturas/${primeraId}/anular`)
      .send({ motivo: "anulo la primera" });

    const despues = await agent.get(`/api/erp/combustible/${tanqueId}`);
    // Queda en 800: el valor de la última lectura vigente ANTES de anularla.
    // No se pone en 0 -- eso sería inventar una medición que nadie tomó.
    expect(Number(despues.body.nivel_actual)).toBe(800);
  });

  it("el motivo es obligatorio: sin motivo, o vacío, rechaza con 400", async () => {
    const { segundaId } = await tanqueConDosLecturas();

    const sinMotivo = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({});
    expect(sinMotivo.status).toBe(400);

    const vacio = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "   " });
    expect(vacio.status).toBe(400);
  });

  it("anular dos veces la misma lectura da 409, sin pisar el motivo original", async () => {
    const { tanqueId, segundaId } = await tanqueConDosLecturas();
    const primera = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "motivo original" });
    expect(primera.status).toBe(200);

    const segunda = await agent
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "intento pisar el motivo" });
    expect(segunda.status).toBe(409);

    const historial = await agent.get(`/api/erp/combustible/${tanqueId}/lecturas`);
    const fila = historial.body.data.find((l: { id: number }) => l.id === segundaId);
    expect(fila.motivo_anulacion).toBe("motivo original");
  });

  it("anular una lectura inexistente da 404", async () => {
    const res = await agent
      .patch("/api/erp/combustible/lecturas/999999999/anular")
      .send({ motivo: "no existe" });
    expect(res.status).toBe(404);
  });

  it("un usuario con rol 'lectura' no puede anular (403)", async () => {
    const { segundaId } = await tanqueConDosLecturas();
    const email = `lectura-anular-${Date.now()}@test.local`;
    await withTenant(tenantId, (client) =>
      crearUsuarioService(
        { tenantId, nombre: "Solo lectura", email, password, rol: "lectura" },
        client
      )
    );

    const agentLectura = request.agent(app);
    await agentLectura.post("/api/auth/login").send({ tenantSlug, email, password });

    const res = await agentLectura
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "no debería poder" });
    expect(res.status).toBe(403);
  });

  it("un tenant no puede anular la lectura de otro (404, y la lectura sigue vigente)", async () => {
    const { segundaId } = await tanqueConDosLecturas();

    const otro = await crearTenantDePrueba(password);
    const agentOtro = request.agent(app);
    await agentOtro
      .post("/api/auth/login")
      .send({ tenantSlug: otro.tenant.slug, email: otro.usuario.email, password });

    const res = await agentOtro
      .patch(`/api/erp/combustible/lecturas/${segundaId}/anular`)
      .send({ motivo: "lectura ajena" });
    expect(res.status).toBe(404);

    const sigueVigente = await withTenant(tenantId, (client) =>
      client.query(`SELECT anulada_en FROM combustible_lecturas WHERE id = $1`, [segundaId])
    );
    expect(sigueVigente.rows[0].anulada_en).toBeNull();

    await borrarTenantDePrueba(otro.tenant.id);
  });
});

describe("combustible: capacidad_total > 0 a nivel de base de datos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("un INSERT directo con capacidad_total <= 0 viola el CHECK de la migración 0057", async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;

    await expect(
      withTenant(tenantId, (client) =>
        client.query(
          `INSERT INTO combustible (
             tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto, capacidad_total
           ) VALUES ($1, $2, 'Tanque inválido', 'diesel_b5', 'gal', 'fijo', 0)`,
          [tenantId, idUnico("NEG")]
        )
      )
    ).rejects.toThrow();
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en equipos-checklist-iperc.test.ts).
afterAll(async () => {
  await closeDatabase();
});
