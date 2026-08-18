/** tests/platform-billing-alertas.test.ts
 *
 * obtenerAlertasBillingService() (platformBilling.service.ts): cruza
 * vencidas/fallidas/próximas de TODOS los tenants en un solo query -- lo
 * que alimenta la vista "Alertas" del panel. Se testea vía la ruta HTTP
 * GET /billing/alertas para cubrir también el wiring de la ruta.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado.tenant.id;
}

async function obtenerAlertas() {
  const res = await request(app).get("/api/platform/billing/alertas").set("Authorization", BEARER);
  expect(res.status).toBe(200);
  return res.body.alertas as {
    vencidas: any[];
    fallidas: any[];
    proximas: any[];
  };
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("alertas de billing", () => {
  it("un cobro de implementación pendiente y ya vencido aparece en 'vencidas' con el tenant correcto", async () => {
    const tenantId = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenantId}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() - interval '3 days' WHERE id = $1`,
      [cobroId]
    );

    const alertas = await obtenerAlertas();
    const fila = alertas.vencidas.find((a) => a.cobroId === cobroId);
    expect(fila).toBeDefined();
    expect(fila.tenantId).toBe(tenantId);
    expect(fila.diasAtraso).toBeGreaterThanOrEqual(3);
    expect(fila.saldo).toBe(800);
  });

  it("un cobro pendiente que vence DENTRO de 3 días aparece en 'proximas', no en 'vencidas'", async () => {
    const tenantId = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenantId}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 100, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() + interval '1 day' WHERE id = $1`,
      [cobroId]
    );

    const alertas = await obtenerAlertas();
    expect(alertas.proximas.some((a) => a.cobroId === cobroId)).toBe(true);
    expect(alertas.vencidas.some((a) => a.cobroId === cobroId)).toBe(false);
  });

  it("un cobro pendiente que vence MÁS ALLÁ de 3 días no aparece en ninguna lista", async () => {
    const tenantId = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenantId}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 100, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() + interval '10 days' WHERE id = $1`,
      [cobroId]
    );

    const alertas = await obtenerAlertas();
    expect(alertas.proximas.some((a) => a.cobroId === cobroId)).toBe(false);
    expect(alertas.vencidas.some((a) => a.cobroId === cobroId)).toBe(false);
  });

  it("un pago que salda el cobro lo saca de 'vencidas'", async () => {
    const tenantId = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenantId}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 100, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() - interval '1 day' WHERE id = $1`,
      [cobroId]
    );
    expect((await obtenerAlertas()).vencidas.some((a) => a.cobroId === cobroId)).toBe(true);

    await request(app)
      .post(`/api/platform/tenants/${tenantId}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 100 });

    expect((await obtenerAlertas()).vencidas.some((a) => a.cobroId === cobroId)).toBe(false);
  });

  it("un cobro fallido reciente aparece en 'fallidas' con el motivo", async () => {
    const tenantId = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenantId}/suscripcion`)
      .set("Authorization", BEARER)
      .send({ plan: "mype", ciclo: "mensual", metodoFacturacion: "tarjeta", precioReferencia: 49 });

    // Sembramos un cobro 'fallido' directo para probar la lista (el camino
    // real que lo produce -- el motor automático -- ya está cubierto en
    // platform-billing-vencimientos.test.ts).
    const suscripcion = await pool.query(`SELECT id FROM suscripciones WHERE tenant_id = $1`, [
      tenantId,
    ]);
    const cobro = await pool.query(
      `INSERT INTO cobros (tenant_id, suscripcion_id, tipo, moneda, monto, estado, motivo_fallo)
       VALUES ($1, $2, 'suscripcion', 'PEN', 184.50, 'fallido', 'Fondos insuficientes')
       RETURNING id`,
      [tenantId, suscripcion.rows[0].id]
    );

    const alertas = await obtenerAlertas();
    const fila = alertas.fallidas.find((a) => a.cobroId === cobro.rows[0].id);
    expect(fila).toBeDefined();
    expect(fila.motivoFallo).toBe("Fondos insuficientes");
  });

  it("una tarjeta rechazada que luego se cobra exitosamente sale de 'fallidas'", async () => {
    const tenantId = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenantId}/suscripcion`)
      .set("Authorization", BEARER)
      .send({ plan: "mype", ciclo: "mensual", metodoFacturacion: "tarjeta", precioReferencia: 49 });
    const suscripcion = await pool.query(`SELECT id FROM suscripciones WHERE tenant_id = $1`, [
      tenantId,
    ]);
    const fallido = await pool.query(
      `INSERT INTO cobros (tenant_id, suscripcion_id, tipo, moneda, monto, estado, motivo_fallo)
       VALUES ($1, $2, 'suscripcion', 'PEN', 184.50, 'fallido', 'Fondos insuficientes')
       RETURNING id`,
      [tenantId, suscripcion.rows[0].id]
    );
    expect((await obtenerAlertas()).fallidas.some((a) => a.cobroId === fallido.rows[0].id)).toBe(
      true
    );

    // Ahora sí, con método de pago guardado: forzarCobroService lo cobra bien.
    await pool.query(
      `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
       VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
      [tenantId]
    );
    await request(app)
      .post(`/api/platform/tenants/${tenantId}/suscripcion/cobrar`)
      .set("Authorization", BEARER);

    expect((await obtenerAlertas()).fallidas.some((a) => a.cobroId === fallido.rows[0].id)).toBe(
      false
    );
  });

  it("401 sin credenciales", async () => {
    const res = await request(app).get("/api/platform/billing/alertas");
    expect(res.status).toBe(401);
  });
});
