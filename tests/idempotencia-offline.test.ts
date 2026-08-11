/** tests/idempotencia-offline.test.ts
 *
 * Cubre la garantía que sostiene todo el offline de campo: un checklist
 * llenado sin señal se puede reintentar tantas veces como haga falta sin
 * que aparezca duplicado (migración 0044 + idempotentInsert.ts).
 *
 * El caso real que se reproduce acá es el que NO se ve venir: el POST llega
 * al servidor, se commitea bien, y la respuesta se pierde de vuelta porque
 * se cortó la señal justo ahí. El dispositivo nunca se entera, así que
 * vuelve a mandar exactamente el mismo envío cuando recupera red. Sin la
 * clave de idempotencia eso son dos inspecciones distintas en la base para
 * un solo trabajo real — y en un registro de seguridad minera eso no es un
 * detalle cosmético.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

describe("idempotencia de escrituras offline (checklists)", () => {
  let tenantId: string;
  let equipoId: number;
  let plantillaId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  const items = [
    { descripcion: "Frenos", estado: "bien" as const },
    { descripcion: "Luces", estado: "bien" as const },
  ];

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: "OFF-001", tipo: "Camioneta" });
    equipoId = equipo.body.id;

    const plantilla = await agente.post("/api/erp/checklists/plantillas").send({
      nombre: "Pre-uso offline",
      items: [{ descripcion: "Frenos" }, { descripcion: "Luces" }],
    });
    plantillaId = plantilla.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  async function contarChecklistsDelEquipo(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(`SELECT COUNT(*)::int AS total FROM checklists WHERE equipo_id = $1`, [equipoId])
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UNA sola fila y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      items,
    };

    const antes = await contarChecklistsDelEquipo();

    const primera = await agente.post("/api/erp/checklists").send(cuerpo);
    expect(primera.status).toBe(201);

    // El reintento del dispositivo: byte por byte el mismo envío.
    const reintento = await agente.post("/api/erp/checklists").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada. Sigue siendo 2xx a propósito,
    // porque para la cola del dispositivo es un éxito (puede borrar la
    // entrada), no un error a reintentar para siempre.
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    expect(await contarChecklistsDelEquipo()).toBe(antes + 1);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican", async () => {
    // La carrera real: el operario tiene dos pestañas abiertas, o la cola
    // se drena mientras el reintento manual ya está en vuelo. No hay lock
    // en el cliente que lo impida — la serialización la da el índice único
    // de idempotency_keys, y esto lo comprueba.
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      items,
    };

    const antes = await contarChecklistsDelEquipo();

    const [a, b] = await Promise.all([
      agente.post("/api/erp/checklists").send(cuerpo),
      agente.post("/api/erp/checklists").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await contarChecklistsDelEquipo()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean filas distintas (dos operarios, mismo equipo)", async () => {
    // Que Carlos y María revisen el mismo camión en el mismo turno son dos
    // inspecciones legítimas. La idempotencia compara la clave, no el
    // contenido: fusionarlas sería perder un registro real.
    const antes = await contarChecklistsDelEquipo();

    const carlos = await agente.post("/api/erp/checklists").send({
      cliente_uuid: crypto.randomUUID(),
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      items,
    });
    const maria = await agente.post("/api/erp/checklists").send({
      cliente_uuid: crypto.randomUUID(),
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      items,
    });

    expect(carlos.status).toBe(201);
    expect(maria.status).toBe(201);
    expect(carlos.body.id).not.toBe(maria.body.id);
    expect(await contarChecklistsDelEquipo()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea una fila", async () => {
    // Compatibilidad hacia atrás: la columna es opcional, un cliente que no
    // la manda (o una versión vieja de la app) no cambia de comportamiento.
    const antes = await contarChecklistsDelEquipo();
    const cuerpo = { equipo_id: equipoId, plantilla_id: plantillaId, items };

    expect((await agente.post("/api/erp/checklists").send(cuerpo)).status).toBe(201);
    expect((await agente.post("/api/erp/checklists").send(cuerpo)).status).toBe(201);

    expect(await contarChecklistsDelEquipo()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente.post("/api/erp/checklists").send({
      cliente_uuid: "no-soy-un-uuid",
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      items,
    });
    expect(res.status).toBe(400);
  });

  it("la auditoría y el evento de tiempo real NO se repiten en el reintento", async () => {
    // Si el reintento volviera a auditar/publicar, el panel mostraría dos
    // "checklist creado" para un solo checklist — y quien mire la auditoría
    // mañana creería que hubo dos inspecciones.
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      equipo_id: equipoId,
      plantilla_id: plantillaId,
      items,
    };

    const primera = await agente.post("/api/erp/checklists").send(cuerpo);
    await agente.post("/api/erp/checklists").send(cuerpo);

    const auditoria = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM platform_audit_log
         WHERE accion = 'checklists.crear' AND tenant_id = $1 AND detalle->>'checklistId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(auditoria.rows[0].total).toBe(1);

    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'checklists.creado' AND tenant_id = $1 AND payload->>'checklistId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente
      .post("/api/erp/checklists")
      .send({ cliente_uuid: vigente, equipo_id: equipoId, plantilla_id: plantillaId, items });

    const vencido = crypto.randomUUID();
    await agente
      .post("/api/erp/checklists")
      .send({ cliente_uuid: vencido, equipo_id: equipoId, plantilla_id: plantillaId, items });
    // Se envejece a mano en vez de esperar 72h reales.
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(`SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1`, [tenantId])
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});
