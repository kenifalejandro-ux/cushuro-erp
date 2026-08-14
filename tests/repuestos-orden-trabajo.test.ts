/** tests/repuestos-orden-trabajo.test.ts
 *
 * Vínculo opcional de un movimiento de repuestos a una Orden de Trabajo
 * (ver migrations/0050) -- el motivo original que hizo saltar la
 * necesidad de todo el módulo `ordenes_trabajo`. Sin reserva de stock ni
 * estado de la OT en este PR: el movimiento se comporta exactamente igual
 * que uno sin vincular, solo queda trazado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

async function crearRepuesto(tenantId: string, stock = 10): Promise<number> {
  const fila = await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO repuestos (tenant_id, codigo, nombre, stock) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, idUnico("REP"), "Repuesto de prueba", stock]
    )
  );
  return fila.rows[0].id;
}

describe("Repuestos ↔ Orden de Trabajo: vínculo opcional en movimientos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);
  let repuestoId: number;
  let ordenTrabajoId: number;

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    repuestoId = await crearRepuesto(tenantId);

    const equipo = await agente
      .post("/api/erp/equipos")
      .send({ placa_codigo: idUnico("REP-OT-EQ"), tipo: "Camioneta" });
    const ot = await agente
      .post("/api/erp/ordenes_trabajo")
      .send({ equipo_id: equipo.body.id, titulo: "Cambio de filtro" });
    ordenTrabajoId = ot.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("un movimiento con orden_trabajo_id válido se guarda y queda trazado", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      repuesto_id: repuestoId,
      tipo: "salida",
      cantidad: 1,
      registrado_en: new Date().toISOString(),
      orden_trabajo_id: ordenTrabajoId,
    });

    expect(res.status).toBe(201);
    expect(res.body.movimiento.orden_trabajo_id).toBe(ordenTrabajoId);

    const fila = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT orden_trabajo_id FROM repuestos_movimientos WHERE id = $1 AND tenant_id = $2`,
        [res.body.movimiento.id, tenantId]
      )
    );
    expect(fila.rows[0].orden_trabajo_id).toBe(ordenTrabajoId);
  });

  it("orden_trabajo_id inexistente en el tenant → 400, no 500 de FK", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
      registrado_en: new Date().toISOString(),
      orden_trabajo_id: 999999999,
    });
    expect(res.status).toBe(400);
  });

  it("orden_trabajo_id de OTRO tenant → 400 (aislamiento)", async () => {
    const otroTenant = await crearTenantDePrueba(password);
    try {
      const agenteOtro = request.agent(app);
      await agenteOtro.post("/api/auth/login").send({
        tenantSlug: otroTenant.tenant.slug,
        email: otroTenant.usuario.email,
        password,
      });
      const equipoOtro = await agenteOtro
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("AISL-EQ"), tipo: "Camioneta" });
      const otDeOtroTenant = await agenteOtro
        .post("/api/erp/ordenes_trabajo")
        .send({ equipo_id: equipoOtro.body.id, titulo: "OT de otro tenant" });

      // El tenant original intenta vincular un movimiento a la OT ajena.
      const res = await agente.post("/api/erp/repuestos/movimientos").send({
        repuesto_id: repuestoId,
        tipo: "entrada",
        cantidad: 1,
        registrado_en: new Date().toISOString(),
        orden_trabajo_id: otDeOtroTenant.body.id,
      });
      expect(res.status).toBe(400);
    } finally {
      await borrarTenantDePrueba(otroTenant.tenant.id);
    }
  });

  it("sin orden_trabajo_id se comporta igual que siempre: se guarda con el campo en null", async () => {
    const res = await agente.post("/api/erp/repuestos/movimientos").send({
      repuesto_id: repuestoId,
      tipo: "entrada",
      cantidad: 1,
      registrado_en: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
    expect(res.body.movimiento.orden_trabajo_id).toBeNull();
  });
});

afterAll(async () => {
  await closeDatabase();
});
