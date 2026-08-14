/** tests/idempotencia-offline-ordenes-trabajo.test.ts
 *
 * Mismo motivo que tests/idempotencia-offline-iperc.test.ts, aplicado a la
 * creación de una Orden de Trabajo: un POST que se commiteó pero cuya
 * respuesta se perdió no debe convertirse en dos OT al reintentar. Es el
 * requisito no negociable del ADR §8 para que la creación participe del
 * offline (ver src/modules/registry.ts, entrada `ordenes_trabajo`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

describe("idempotencia de escrituras offline (Órdenes de Trabajo)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let equipoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("IDEM-EQ"), tipo: "Camioneta" });
    equipoId = equipo.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function contarOTDelTenant(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(`SELECT COUNT(*)::int AS total FROM ordenes_trabajo WHERE tenant_id = $1`, [
        tenantId,
      ])
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UNA sola OT y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, equipo_id: equipoId, titulo: "Motor" };

    const antes = await contarOTDelTenant();

    const primera = await agente.post("/api/erp/ordenes_trabajo").send(cuerpo);
    expect(primera.status).toBe(201);

    // El reintento del dispositivo: byte por byte el mismo envío.
    const reintento = await agente.post("/api/erp/ordenes_trabajo").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola offline del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    expect(await contarOTDelTenant()).toBe(antes + 1);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, equipo_id: equipoId, titulo: "Suspensión" };

    const antes = await contarOTDelTenant();

    const [a, b] = await Promise.all([
      agente.post("/api/erp/ordenes_trabajo").send(cuerpo),
      agente.post("/api/erp/ordenes_trabajo").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await contarOTDelTenant()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean OT distintas (dos técnicos, mismo equipo)", async () => {
    const antes = await contarOTDelTenant();

    const primera = await agente
      .post("/api/erp/ordenes_trabajo")
      .send({ cliente_uuid: crypto.randomUUID(), equipo_id: equipoId, titulo: "Ruido en cabina" });
    const segunda = await agente
      .post("/api/erp/ordenes_trabajo")
      .send({ cliente_uuid: crypto.randomUUID(), equipo_id: equipoId, titulo: "Ruido en cabina" });

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(primera.body.id).not.toBe(segunda.body.id);
    expect(await contarOTDelTenant()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea una OT", async () => {
    const antes = await contarOTDelTenant();
    const cuerpo = { equipo_id: equipoId, titulo: "Sin idempotencia" };

    expect((await agente.post("/api/erp/ordenes_trabajo").send(cuerpo)).status).toBe(201);
    expect((await agente.post("/api/erp/ordenes_trabajo").send(cuerpo)).status).toBe(201);

    expect(await contarOTDelTenant()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente
      .post("/api/erp/ordenes_trabajo")
      .send({ cliente_uuid: "no-soy-un-uuid", equipo_id: equipoId, titulo: "x" });
    expect(res.status).toBe(400);
  });

  it("la auditoría y el evento de tiempo real NO se repiten en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, equipo_id: equipoId, titulo: "Neumáticos" };

    const primera = await agente.post("/api/erp/ordenes_trabajo").send(cuerpo);
    await agente.post("/api/erp/ordenes_trabajo").send(cuerpo);

    const auditoria = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM platform_audit_log
         WHERE accion = 'ordenes_trabajo.crear' AND tenant_id = $1 AND detalle->>'ordenTrabajoId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(auditoria.rows[0].total).toBe(1);

    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'ordenes_trabajo.creada' AND tenant_id = $1 AND payload->>'ordenTrabajoId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención compartido, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente
      .post("/api/erp/ordenes_trabajo")
      .send({ cliente_uuid: vigente, equipo_id: equipoId, titulo: "Vigente" });

    const vencido = crypto.randomUUID();
    await agente
      .post("/api/erp/ordenes_trabajo")
      .send({ cliente_uuid: vencido, equipo_id: equipoId, titulo: "Vencido" });
    // Se envejece a mano en vez de esperar 72h reales.
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND modulo = 'ordenes_trabajo' AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1 AND modulo = 'ordenes_trabajo'`,
        [tenantId]
      )
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});
