/** tests/idempotencia-offline-repuestos.test.ts
 *
 * Mismo motivo que tests/idempotencia-offline-combustible.test.ts, aplicado
 * a registrar un movimiento de stock (entrada/salida): un POST que se
 * commiteó pero cuya respuesta se perdió no debe convertirse en dos
 * movimientos al reintentar, ni descontar/sumar el stock dos veces.
 *
 * A diferencia de Combustible, acá no hay "orden de llegada" que resolver:
 * un movimiento es un DELTA, y sumar deltas es conmutativo -- el segundo
 * describe de este archivo prueba justamente eso (mismo resultado final sin
 * importar el orden), en vez del caso "la lectura vieja no pisa la nueva"
 * que sí necesita Combustible.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

async function crearRepuesto(
  tenantId: string,
  data: { codigo: string; nombre: string; stock: number }
): Promise<number> {
  const fila = await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO repuestos (tenant_id, codigo, nombre, stock) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, data.codigo, data.nombre, data.stock]
    )
  );
  return fila.rows[0].id;
}

async function stockDelRepuesto(tenantId: string, repuestoId: number): Promise<number> {
  const res = await withTenant(tenantId, (client) =>
    client.query(`SELECT stock FROM repuestos WHERE id = $1 AND tenant_id = $2`, [
      repuestoId,
      tenantId,
    ])
  );
  return res.rows[0].stock;
}

describe("idempotencia de escrituras offline (Repuestos: movimientos)", () => {
  let tenantId: string;
  let repuestoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    repuestoId = await crearRepuesto(tenantId, {
      codigo: "IDEMP-001",
      nombre: "Repuesto idempotencia",
      stock: 100,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function contarMovimientos(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM repuestos_movimientos WHERE tenant_id = $1 AND repuesto_id = $2`,
        [tenantId, repuestoId]
      )
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UN solo movimiento, devuelve el mismo id, y el stock se mueve una sola vez", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      repuesto_id: repuestoId,
      tipo: "salida",
      cantidad: 10,
      registrado_en: new Date().toISOString(),
    };

    const antesMovs = await contarMovimientos();
    const antesStock = await stockDelRepuesto(tenantId, repuestoId);

    const primera = await agente.post("/api/erp/repuestos/movimientos").send(cuerpo);
    expect(primera.status).toBe(201);

    const reintento = await agente.post("/api/erp/repuestos/movimientos").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.movimiento.id).toBe(primera.body.movimiento.id);

    expect(await contarMovimientos()).toBe(antesMovs + 1);
    expect(await stockDelRepuesto(tenantId, repuestoId)).toBe(antesStock - 10);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican ni descuentan dos veces", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 5,
      registrado_en: new Date().toISOString(),
    };

    const antesMovs = await contarMovimientos();
    const antesStock = await stockDelRepuesto(tenantId, repuestoId);

    const [a, b] = await Promise.all([
      agente.post("/api/erp/repuestos/movimientos").send(cuerpo),
      agente.post("/api/erp/repuestos/movimientos").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.movimiento.id).toBe(b.body.movimiento.id);
    expect(await contarMovimientos()).toBe(antesMovs + 1);
    expect(await stockDelRepuesto(tenantId, repuestoId)).toBe(antesStock + 5);
  });

  it("cliente_uuid distintos SÍ crean movimientos distintos", async () => {
    const antesMovs = await contarMovimientos();

    const a = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });
    const b = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.movimiento.id).not.toBe(b.body.movimiento.id);
    expect(await contarMovimientos()).toBe(antesMovs + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea un movimiento", async () => {
    const antesMovs = await contarMovimientos();
    const cuerpo = { repuesto_id: repuestoId, tipo: "entrada", cantidad: 1 };

    expect((await agente.post("/api/erp/repuestos/movimientos").send(cuerpo)).status).toBe(201);
    expect((await agente.post("/api/erp/repuestos/movimientos").send(cuerpo)).status).toBe(201);

    expect(await contarMovimientos()).toBe(antesMovs + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: "no-soy-un-uuid",
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });
    expect(res.status).toBe(400);
  });

  it("un repuesto_id que no existe en este tenant da 400, no 500", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: 999999999,
      tipo: "entrada",
      cantidad: 1,
    });
    expect(res.status).toBe(400);
  });

  it("el evento de tiempo real NO se repite en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 2,
    };

    const primera = await agente.post("/api/erp/repuestos/movimientos").send(cuerpo);
    await agente.post("/api/erp/repuestos/movimientos").send(cuerpo);

    // Filtra por el id del MOVIMIENTO (único por test), no por repuestoId --
    // el repuesto se comparte entre todos los `it` de este describe, así
    // que filtrar por repuestoId contaría eventos de otros casos.
    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'repuestos.movimiento_registrado' AND tenant_id = $1
           AND payload->>'movimientoId' = $2`,
        [tenantId, String(primera.body.movimiento.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención compartido, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: vigente,
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });

    const vencido = crypto.randomUUID();
    await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: vencido,
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
    });
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND modulo = 'repuestos' AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1 AND modulo = 'repuestos'`,
        [tenantId]
      )
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});

describe("Repuestos: el stock aplica movimientos como delta conmutativo", () => {
  let tenantId: string;
  let repuestoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    repuestoId = await crearRepuesto(tenantId, {
      codigo: "STOCK-001",
      nombre: "Repuesto stock",
      stock: 50,
    });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("una entrada suma al stock", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 20,
    });
    expect(res.status).toBe(201);
    expect(res.body.repuesto.stock).toBe(70);
    expect(await stockDelRepuesto(tenantId, repuestoId)).toBe(70);
  });

  it("una salida resta del stock", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "salida",
      cantidad: 15,
    });
    expect(res.status).toBe(201);
    expect(res.body.repuesto.stock).toBe(55);
    expect(await stockDelRepuesto(tenantId, repuestoId)).toBe(55);
  });

  it("una salida puede dejar el stock en negativo sin rechazar el movimiento", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: crypto.randomUUID(),
      repuesto_id: repuestoId,
      tipo: "salida",
      cantidad: 1000,
    });
    expect(res.status).toBe(201);
    expect(res.body.repuesto.stock).toBeLessThan(0);
  });

  it("el resultado final es el mismo sin importar en qué orden sincronizan dos movimientos", async () => {
    const otroRepuestoId = await crearRepuesto(tenantId, {
      codigo: "ORDEN-001",
      nombre: "Repuesto orden",
      stock: 100,
    });

    // Orden A: entrada, después salida.
    const clienteA1 = crypto.randomUUID();
    const clienteA2 = crypto.randomUUID();
    await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: clienteA1,
      repuesto_id: otroRepuestoId,
      tipo: "entrada",
      cantidad: 30,
    });
    await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: clienteA2,
      repuesto_id: otroRepuestoId,
      tipo: "salida",
      cantidad: 10,
    });
    const stockOrdenA = await stockDelRepuesto(tenantId, otroRepuestoId);

    // Mismos dos movimientos, para un repuesto gemelo, pero en el orden
    // INVERSO -- simula que la cola offline drenó en otro orden.
    const gemeloId = await crearRepuesto(tenantId, {
      codigo: "ORDEN-002",
      nombre: "Repuesto orden gemelo",
      stock: 100,
    });
    const clienteB1 = crypto.randomUUID();
    const clienteB2 = crypto.randomUUID();
    await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: clienteB2,
      repuesto_id: gemeloId,
      tipo: "salida",
      cantidad: 10,
    });
    await agente.post("/api/erp/repuestos/movimientos").send({
      cliente_uuid: clienteB1,
      repuesto_id: gemeloId,
      tipo: "entrada",
      cantidad: 30,
    });
    const stockOrdenB = await stockDelRepuesto(tenantId, gemeloId);

    expect(stockOrdenA).toBe(stockOrdenB);
    expect(stockOrdenA).toBe(120);
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en tests/combustible.test.ts).
afterAll(async () => {
  await closeDatabase();
});
