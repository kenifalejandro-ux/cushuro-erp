/** tests/idempotencia-offline-iperc.test.ts
 *
 * Mismo motivo que tests/idempotencia-offline.test.ts (checklists), aplicado
 * a la creación de IPERC: un POST que se commiteó pero cuya respuesta se
 * perdió no debe convertirse en dos IPERC al reintentar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

describe("idempotencia de escrituras offline (IPERC)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  const items = [
    {
      etapa_actividad: "Carguío",
      peligro: "Volcamiento",
      riesgo: "Caída de material",
      probabilidad: 2,
      severidad: 3,
      medidas_control: "Cinturón de seguridad y check de vía",
    },
  ];

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function contarIpercsDelTenant(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(`SELECT COUNT(*)::int AS total FROM ipercs WHERE tenant_id = $1`, [tenantId])
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UN solo IPERC y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, area_frente: "Frente Norte", items };

    const antes = await contarIpercsDelTenant();

    const primera = await agente.post("/api/erp/iperc").send(cuerpo);
    expect(primera.status).toBe(201);

    // El reintento del dispositivo: byte por byte el mismo envío.
    const reintento = await agente.post("/api/erp/iperc").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    expect(await contarIpercsDelTenant()).toBe(antes + 1);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, area_frente: "Frente Sur", items };

    const antes = await contarIpercsDelTenant();

    const [a, b] = await Promise.all([
      agente.post("/api/erp/iperc").send(cuerpo),
      agente.post("/api/erp/iperc").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await contarIpercsDelTenant()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean IPERC distintos (dos operarios, misma área)", async () => {
    const antes = await contarIpercsDelTenant();

    const carlos = await agente
      .post("/api/erp/iperc")
      .send({ cliente_uuid: crypto.randomUUID(), area_frente: "Frente Este", items });
    const maria = await agente
      .post("/api/erp/iperc")
      .send({ cliente_uuid: crypto.randomUUID(), area_frente: "Frente Este", items });

    expect(carlos.status).toBe(201);
    expect(maria.status).toBe(201);
    expect(carlos.body.id).not.toBe(maria.body.id);
    expect(await contarIpercsDelTenant()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea un IPERC", async () => {
    const antes = await contarIpercsDelTenant();
    const cuerpo = { area_frente: "Frente Oeste", items };

    expect((await agente.post("/api/erp/iperc").send(cuerpo)).status).toBe(201);
    expect((await agente.post("/api/erp/iperc").send(cuerpo)).status).toBe(201);

    expect(await contarIpercsDelTenant()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente
      .post("/api/erp/iperc")
      .send({ cliente_uuid: "no-soy-un-uuid", area_frente: "Frente Norte", items });
    expect(res.status).toBe(400);
  });

  it("la auditoría y el evento de tiempo real NO se repiten en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = { cliente_uuid: clienteUuid, area_frente: "Frente Norte", items };

    const primera = await agente.post("/api/erp/iperc").send(cuerpo);
    await agente.post("/api/erp/iperc").send(cuerpo);

    const auditoria = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM platform_audit_log
         WHERE accion = 'iperc.crear' AND tenant_id = $1 AND detalle->>'ipercId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(auditoria.rows[0].total).toBe(1);

    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'iperc.creado' AND tenant_id = $1 AND payload->>'ipercId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención compartido, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente
      .post("/api/erp/iperc")
      .send({ cliente_uuid: vigente, area_frente: "Frente Norte", items });

    const vencido = crypto.randomUUID();
    await agente
      .post("/api/erp/iperc")
      .send({ cliente_uuid: vencido, area_frente: "Frente Norte", items });
    // Se envejece a mano en vez de esperar 72h reales.
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND modulo = 'iperc' AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1 AND modulo = 'iperc'`,
        [tenantId]
      )
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});
