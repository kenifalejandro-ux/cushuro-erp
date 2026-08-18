/** tests/idempotencia-offline-combustible.test.ts
 *
 * Mismo motivo que tests/idempotencia-offline-iperc.test.ts, aplicado a
 * registrar una lectura de combustible: un POST que se commiteó pero cuya
 * respuesta se perdió no debe convertirse en dos lecturas al reintentar.
 *
 * Suma además los casos propios de Combustible que Checklists/IPERC no
 * tienen: el UPDATE condicional de `nivel_actual` según `leido_en` (ver
 * combustible.repository.ts) tiene que quedar bien sin importar el ORDEN
 * DE LLEGADA de las lecturas, no solo su unicidad.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

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
       VALUES ($1, 'TQ-TEST', $2, 'diesel_b5', 'gal', 'fijo', $3, $4) RETURNING id`,
      [tenantId, data.tanqueNombre, data.capacidadTotal, data.nivelActual]
    )
  );
  return fila.rows[0].id;
}

describe("idempotencia de escrituras offline (Combustible)", () => {
  let tenantId: string;
  let tanqueId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    tanqueId = await crearTanque(tenantId, {
      tanqueNombre: "Tanque idempotencia",
      capacidadTotal: 1000,
      nivelActual: 100,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function contarLecturas(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM combustible_lecturas WHERE tenant_id = $1 AND combustible_id = $2`,
        [tenantId, tanqueId]
      )
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UNA sola lectura y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      combustible_id: tanqueId,
      nivel: 500,
      leido_en: new Date().toISOString(),
    };

    const antes = await contarLecturas();

    const primera = await agente.post("/api/erp/combustible/lecturas").send(cuerpo);
    expect(primera.status).toBe(201);

    const reintento = await agente.post("/api/erp/combustible/lecturas").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.lectura.id).toBe(primera.body.lectura.id);

    expect(await contarLecturas()).toBe(antes + 1);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      combustible_id: tanqueId,
      nivel: 600,
      leido_en: new Date().toISOString(),
    };

    const antes = await contarLecturas();

    const [a, b] = await Promise.all([
      agente.post("/api/erp/combustible/lecturas").send(cuerpo),
      agente.post("/api/erp/combustible/lecturas").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.lectura.id).toBe(b.body.lectura.id);
    expect(await contarLecturas()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean lecturas distintas", async () => {
    const antes = await contarLecturas();

    const a = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: tanqueId,
      nivel: 700,
      leido_en: new Date().toISOString(),
    });
    const b = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: tanqueId,
      nivel: 710,
      leido_en: new Date().toISOString(),
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.lectura.id).not.toBe(b.body.lectura.id);
    expect(await contarLecturas()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea una lectura", async () => {
    const antes = await contarLecturas();
    const cuerpo = { combustible_id: tanqueId, nivel: 720, leido_en: new Date().toISOString() };

    expect((await agente.post("/api/erp/combustible/lecturas").send(cuerpo)).status).toBe(201);
    expect((await agente.post("/api/erp/combustible/lecturas").send(cuerpo)).status).toBe(201);

    expect(await contarLecturas()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: "no-soy-un-uuid",
      combustible_id: tanqueId,
      nivel: 500,
      leido_en: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("un combustible_id que no existe en este tenant da 400, no 500", async () => {
    const res = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: 999999999,
      nivel: 500,
      leido_en: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it("el evento de tiempo real NO se repite en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      combustible_id: tanqueId,
      nivel: 550,
      leido_en: new Date().toISOString(),
    };

    const primera = await agente.post("/api/erp/combustible/lecturas").send(cuerpo);
    await agente.post("/api/erp/combustible/lecturas").send(cuerpo);

    // Filtra por el id de la LECTURA (único por test), no por combustibleId
    // -- el tanque se comparte entre todos los `it` de este describe, así
    // que filtrar por combustibleId contaría eventos de otros casos.
    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'combustible.lectura_registrada' AND tenant_id = $1
           AND payload->>'lecturaId' = $2`,
        [tenantId, String(primera.body.lectura.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención compartido, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: vigente,
      combustible_id: tanqueId,
      nivel: 500,
      leido_en: new Date().toISOString(),
    });

    const vencido = crypto.randomUUID();
    await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: vencido,
      combustible_id: tanqueId,
      nivel: 500,
      leido_en: new Date().toISOString(),
    });
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND modulo = 'combustible' AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1 AND modulo = 'combustible'`,
        [tenantId]
      )
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});

describe("Combustible: nivel_actual resiste el orden de llegada (offline)", () => {
  let tenantId: string;
  let tanqueId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    tanqueId = await crearTanque(tenantId, {
      tanqueNombre: "Tanque orden temporal",
      capacidadTotal: 1000,
      nivelActual: 100,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function nivelActualDelTanque(): Promise<number> {
    const res = await agente.get(`/api/erp/combustible/${tanqueId}`);
    return Number(res.body.nivel_actual);
  }

  it("una lectura VIEJA que llega DESPUÉS de una más nueva no pisa nivel_actual", async () => {
    // Relativas a AHORA, no fechas fijas: `fecha_actualizacion` del tanque
    // se pisa con la hora real de creación (en el beforeAll de este
    // describe), así que una fecha fija del pasado quedaría "vieja" contra
    // ESE dato también, y el UPDATE condicional jamás se dispararía --
    // arruinando la premisa del test antes de llegar a lo que quiere probar.
    const base = Date.now();
    const masNueva = new Date(base + 10 * 60_000).toISOString();
    const masVieja = new Date(base + 5 * 60_000).toISOString();

    // Llega primero la más nueva (ej. con señal perfecta al momento de
    // apretar el botón)...
    const resNueva = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: tanqueId,
      nivel: 850,
      leido_en: masNueva,
    });
    expect(resNueva.status).toBe(201);
    expect(await nivelActualDelTanque()).toBe(850);

    // ...y la vieja recién sincroniza después (se cargó offline minutos
    // antes, en campo, y quedó en la cola del dispositivo).
    const resVieja = await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: tanqueId,
      nivel: 800,
      leido_en: masVieja,
    });
    expect(resVieja.status).toBe(201);

    // nivel_actual sigue siendo el de la lectura más nueva, no el último
    // POST que llegó -- la lectura vieja SÍ quedó en el historial, solo no
    // movió la caché.
    expect(await nivelActualDelTanque()).toBe(850);

    const historial = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT nivel FROM combustible_lecturas WHERE combustible_id = $1 ORDER BY leido_en`,
        [tanqueId]
      )
    );
    expect(historial.rows.map((f) => Number(f.nivel))).toEqual([800, 850]);
  });

  it("cuando SÍ llegan en orden cronológico, nivel_actual sigue a la más reciente", async () => {
    const base = Date.now();
    const primera = new Date(base + 20 * 60_000).toISOString();
    const segunda = new Date(base + 25 * 60_000).toISOString();

    await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: tanqueId,
      nivel: 300,
      leido_en: primera,
    });
    expect(await nivelActualDelTanque()).toBe(300);

    await agente.post("/api/erp/combustible/lecturas").send({
      cliente_uuid: crypto.randomUUID(),
      combustible_id: tanqueId,
      nivel: 200,
      leido_en: segunda,
    });
    expect(await nivelActualDelTanque()).toBe(200);
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en tests/combustible.test.ts).
afterAll(async () => {
  await closeDatabase();
});
