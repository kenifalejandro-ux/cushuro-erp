/** tests/platform-billing-webhook.test.ts
 *
 * Webhook de pasarela (POST /api/webhooks/culqi, ver
 * routes/webhooksPasarela.ts). Lo que hay que blindar de verdad es la
 * idempotencia: el INSERT ... ON CONFLICT DO NOTHING sobre
 * webhooks_pasarela es lo único que garantiza que un mismo evento_id
 * reintentado por la pasarela no aplique el efecto dos veces (ej. extender
 * el período de cobro por duplicado).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];
const FIRMA_VALIDA = "stub-no-es-secreto-real";

async function nuevoTenantConSuscripcionYCobroPendiente() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  const tenantId = creado.tenant.id;

  const alta = await request(app)
    .post(`/api/platform/tenants/${tenantId}/suscripcion`)
    .set("Authorization", BEARER)
    .send({
      plan: "mype",
      ciclo: "mensual",
      metodoFacturacion: "transferencia",
      precioReferencia: 49,
    });
  const suscripcionId = alta.body.suscripcion.suscripcion.id;
  const periodoAntes = alta.body.suscripcion.suscripcion.periodoActualFin;

  const idPasarela = `cargo_test_${tenantId}`;
  await pool.query(
    `INSERT INTO cobros (tenant_id, suscripcion_id, tipo, moneda, monto, estado, id_pasarela)
     VALUES ($1, $2, 'suscripcion', 'USD', 49, 'pendiente', $3)`,
    [tenantId, suscripcionId, idPasarela]
  );

  return { tenantId, suscripcionId, idPasarela, periodoAntes };
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("firma", () => {
  it("400 sin la firma esperada, y no persiste nada", async () => {
    const res = await request(app)
      .post("/api/webhooks/culqi")
      .send({ eventoId: "ev_sin_firma", tipo: "cargo.exitoso", payload: { id: "x" } });

    expect(res.status).toBe(400);
    const fila = await pool.query(
      `SELECT id FROM webhooks_pasarela WHERE evento_id = 'ev_sin_firma'`
    );
    expect(fila.rows).toHaveLength(0);
  });
});

describe("efecto e idempotencia", () => {
  it("evento nuevo aplica el efecto y queda procesado", async () => {
    const { tenantId, idPasarela, periodoAntes } = await nuevoTenantConSuscripcionYCobroPendiente();
    const eventoId = `ev_${idPasarela}`;

    const res = await request(app)
      .post("/api/webhooks/culqi")
      .set("X-Stub-Signature", FIRMA_VALIDA)
      .send({ eventoId, tipo: "cargo.exitoso", payload: { id: idPasarela } });

    expect(res.status).toBe(200);
    expect(res.body.duplicado).toBeFalsy();

    const webhook = await pool.query(
      `SELECT procesado_en FROM webhooks_pasarela WHERE pasarela = 'stub' AND evento_id = $1`,
      [eventoId]
    );
    expect(webhook.rows).toHaveLength(1);
    expect(webhook.rows[0].procesado_en).not.toBeNull();

    const cobro = await pool.query(`SELECT estado FROM cobros WHERE id_pasarela = $1`, [
      idPasarela,
    ]);
    expect(cobro.rows[0].estado).toBe("exitoso");

    const suscripcion = await request(app)
      .get(`/api/platform/tenants/${tenantId}/suscripcion`)
      .set("Authorization", BEARER);
    expect(suscripcion.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(suscripcion.body.suscripcion.suscripcion.periodoActualFin > periodoAntes).toBe(true);
  });

  it("el mismo evento_id repetido no vuelve a aplicar el efecto", async () => {
    const { tenantId, idPasarela } = await nuevoTenantConSuscripcionYCobroPendiente();
    const eventoId = `ev_${idPasarela}`;
    const body = { eventoId, tipo: "cargo.exitoso", payload: { id: idPasarela } };

    await request(app).post("/api/webhooks/culqi").set("X-Stub-Signature", FIRMA_VALIDA).send(body);
    const periodoTrasPrimero = (
      await request(app)
        .get(`/api/platform/tenants/${tenantId}/suscripcion`)
        .set("Authorization", BEARER)
    ).body.suscripcion.suscripcion.periodoActualFin;

    const segundo = await request(app)
      .post("/api/webhooks/culqi")
      .set("X-Stub-Signature", FIRMA_VALIDA)
      .send(body);
    expect(segundo.status).toBe(200);
    expect(segundo.body.duplicado).toBe(true);

    const periodoTrasSegundo = (
      await request(app)
        .get(`/api/platform/tenants/${tenantId}/suscripcion`)
        .set("Authorization", BEARER)
    ).body.suscripcion.suscripcion.periodoActualFin;
    expect(periodoTrasSegundo).toBe(periodoTrasPrimero); // no se extendió una segunda vez

    const registros = await pool.query(
      `SELECT count(*)::int AS n FROM webhooks_pasarela WHERE evento_id = $1`,
      [eventoId]
    );
    expect(registros.rows[0].n).toBe(1);
  });
});
