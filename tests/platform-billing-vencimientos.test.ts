/** tests/platform-billing-vencimientos.test.ts
 *
 * Job diario de vencimientos (platformBillingVencimientos.service.ts,
 * disparado por .github/workflows/scheduled-billing-vencimientos.yml).
 * Se llama al servicio directo (no por HTTP) para no depender del token
 * compartido -- la ruta POST /billing/procesar-vencimientos es un wrapper
 * fino, ver tests/platform-billing.test.ts para el resto de las rutas.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";
import { procesarVencimientosService } from "../src/server/services/platformBillingVencimientos.service";
import { fijarPasarelaPagoParaTests, type PasarelaPago } from "../src/server/services/pasarelaPago";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];
const PRECIO = 49;

async function nuevoTenantConSuscripcion(
  metodoFacturacion: "tarjeta" | "transferencia" = "transferencia"
) {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  const tenantId = creado.tenant.id;

  await request(app)
    .post(`/api/platform/tenants/${tenantId}/suscripcion`)
    .set("Authorization", BEARER)
    .send({
      plan: "mype",
      ciclo: "mensual",
      metodoFacturacion,
      precioReferencia: PRECIO,
    });

  return tenantId;
}

async function cobroDeSuscripcion(tenantId: string) {
  const fila = await pool.query(
    `SELECT id, estado, monto, moneda, monto_pagado AS "montoPagado", motivo_fallo AS "motivoFallo",
            fecha_vencimiento AS "fechaVencimiento", tipo_cambio_aplicado AS "tipoCambioAplicado"
     FROM cobros WHERE tenant_id = $1 AND tipo = 'suscripcion' ORDER BY creado_en DESC LIMIT 1`,
    [tenantId]
  );
  return fila.rows[0] ?? null;
}

afterEach(() => {
  fijarPasarelaPagoParaTests(null); // vuelve al default (Stub)
});

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("activa/trialing vencida", () => {
  it("pasa a en_gracia con 7 días de plazo, sin tocar el acceso del tenant todavía", async () => {
    const tenantId = await nuevoTenantConSuscripcion();
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() - interval '1 day' WHERE tenant_id = $1`,
      [tenantId]
    );

    const resultado = await procesarVencimientosService();
    expect(resultado.entraronEnGracia).toBeGreaterThanOrEqual(1);

    const fila = await pool.query(
      `SELECT estado, gracia_termina_en FROM suscripciones WHERE tenant_id = $1`,
      [tenantId]
    );
    expect(fila.rows[0].estado).toBe("en_gracia");
    expect(fila.rows[0].gracia_termina_en).not.toBeNull();

    const tenantFila = await pool.query(`SELECT activo FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenantFila.rows[0].activo).toBe(true); // todavía no se suspende, recién entra en gracia

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.entra_en_gracia' AND tenant_id = $1`,
      [tenantId]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);

    const outbox = await pool.query(
      `SELECT payload FROM platform_outbox WHERE tipo = 'notificacion_billing'
       AND payload->>'tenantId' = $1 AND payload->>'tipo' = 'entra_en_gracia'`,
      [tenantId]
    );
    expect(outbox.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("no toca una suscripción activa que todavía no venció", async () => {
    const tenantId = await nuevoTenantConSuscripcion();
    await procesarVencimientosService();

    const fila = await pool.query(`SELECT estado FROM suscripciones WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(fila.rows[0].estado).toBe("activa");
  });
});

describe("gracia vencida", () => {
  it("suspende la suscripción Y corta el acceso vía tenants.estado (nunca tenants.activo directo)", async () => {
    const tenantId = await nuevoTenantConSuscripcion();
    await pool.query(
      `UPDATE suscripciones
       SET estado = 'en_gracia', gracia_termina_en = now() - interval '1 day'
       WHERE tenant_id = $1`,
      [tenantId]
    );

    const resultado = await procesarVencimientosService();
    expect(resultado.suspendidas).toBeGreaterThanOrEqual(1);

    const fila = await pool.query(`SELECT estado FROM suscripciones WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(fila.rows[0].estado).toBe("suspendida");

    const tenantFila = await pool.query(`SELECT estado, activo FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    expect(tenantFila.rows[0].estado).toBe("suspended");
    expect(tenantFila.rows[0].activo).toBe(false);

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.suspendida_por_vencimiento' AND tenant_id = $1`,
      [tenantId]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("la ruta del job (usada por el workflow diario) delega en el mismo servicio", async () => {
    const tenantId = await nuevoTenantConSuscripcion();
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() - interval '1 day' WHERE tenant_id = $1`,
      [tenantId]
    );

    const res = await request(app)
      .post("/api/platform/billing/procesar-vencimientos")
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.entraronEnGracia).toBeGreaterThanOrEqual(1);

    const fila = await pool.query(`SELECT estado FROM suscripciones WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(fila.rows[0].estado).toBe("en_gracia");
  });
});

describe("generar próximos cobros (ventana de 3 días)", () => {
  it("genera un cobro pendiente con fecha_vencimiento = periodo_actual_fin cuando vence dentro de la ventana", async () => {
    const tenantId = await nuevoTenantConSuscripcion("transferencia");
    const nuevoVencimiento = await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '2 days'
       WHERE tenant_id = $1 RETURNING periodo_actual_fin`,
      [tenantId]
    );

    const resultado = await procesarVencimientosService();
    expect(resultado.cobrosGenerados).toBeGreaterThanOrEqual(1);

    const cobro = await cobroDeSuscripcion(tenantId);
    expect(cobro.estado).toBe("pendiente");
    expect(Number(cobro.monto)).toBe(PRECIO);
    expect(cobro.moneda).toBe("USD");
    expect(new Date(cobro.fechaVencimiento).getTime()).toBe(
      new Date(nuevoVencimiento.rows[0].periodo_actual_fin).getTime()
    );
  });

  it("no genera nada si el vencimiento está más allá de la ventana", async () => {
    const tenantId = await nuevoTenantConSuscripcion("transferencia");
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '10 days' WHERE tenant_id = $1`,
      [tenantId]
    );

    await procesarVencimientosService();

    expect(await cobroDeSuscripcion(tenantId)).toBeNull();
  });

  it("no duplica si el job corre dos veces seguidas", async () => {
    const tenantId = await nuevoTenantConSuscripcion("transferencia");
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '2 days' WHERE tenant_id = $1`,
      [tenantId]
    );

    await procesarVencimientosService();
    await procesarVencimientosService();

    const cantidad = await pool.query(
      `SELECT count(*)::int AS n FROM cobros WHERE tenant_id = $1 AND tipo = 'suscripcion'`,
      [tenantId]
    );
    expect(cantidad.rows[0].n).toBe(1);
  });

  it("por tarjeta: el monto generado ya viene convertido con el TC vigente", async () => {
    const tenantId = await nuevoTenantConSuscripcion("tarjeta");
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '2 days' WHERE tenant_id = $1`,
      [tenantId]
    );

    await procesarVencimientosService();

    const cobro = await cobroDeSuscripcion(tenantId);
    expect(cobro.moneda).toBe("PEN");
    expect(cobro.tipoCambioAplicado).not.toBeNull();
    expect(Number(cobro.monto)).toBe(
      Math.round(PRECIO * Number(cobro.tipoCambioAplicado) * 100) / 100
    );
  });
});

describe("cobrar tarjeta vencida (motor automático)", () => {
  it("con método de pago guardado: cobra sola, avanza el período y queda auditado", async () => {
    const tenantId = await nuevoTenantConSuscripcion("tarjeta");
    await pool.query(
      `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
       VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
      [tenantId]
    );
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '1 hour' WHERE tenant_id = $1`,
      [tenantId]
    );
    await procesarVencimientosService(); // genera el cobro pendiente
    const finAntes = (
      await pool.query(`SELECT periodo_actual_fin FROM suscripciones WHERE tenant_id = $1`, [
        tenantId,
      ])
    ).rows[0].periodo_actual_fin;

    // Simula que llegó el día: la fecha de vencimiento ya pasó.
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() - interval '1 hour'
       WHERE tenant_id = $1 AND tipo = 'suscripcion'`,
      [tenantId]
    );

    const resultado = await procesarVencimientosService();
    expect(resultado.cobrosAutomaticosExitosos).toBeGreaterThanOrEqual(1);

    const cobro = await cobroDeSuscripcion(tenantId);
    expect(cobro.estado).toBe("exitoso");
    expect(Number(cobro.montoPagado)).toBe(Number(cobro.monto));

    const susFila = await pool.query(
      `SELECT estado, periodo_actual_fin FROM suscripciones WHERE tenant_id = $1`,
      [tenantId]
    );
    expect(susFila.rows[0].estado).toBe("activa");
    expect(new Date(susFila.rows[0].periodo_actual_fin).getTime()).toBeGreaterThan(
      new Date(finAntes).getTime()
    );

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.cobro_automatico_exitoso' AND tenant_id = $1`,
      [tenantId]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("tarjeta rechazada: queda fallido con motivo, no toca el estado de la suscripción", async () => {
    const tenantId = await nuevoTenantConSuscripcion("tarjeta");
    await pool.query(
      `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
       VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
      [tenantId]
    );
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '1 hour' WHERE tenant_id = $1`,
      [tenantId]
    );
    await procesarVencimientosService();
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() - interval '1 hour'
       WHERE tenant_id = $1 AND tipo = 'suscripcion'`,
      [tenantId]
    );

    const pasarelaFallo: PasarelaPago = {
      nombre: "stub",
      async crearCargo() {
        return {
          idPasarela: "stub_cargo_fallo",
          estado: "fallido",
          motivoFallo: "Fondos insuficientes",
        };
      },
      verificarWebhook() {
        return null;
      },
    };
    fijarPasarelaPagoParaTests(pasarelaFallo);

    const resultado = await procesarVencimientosService();
    expect(resultado.cobrosAutomaticosFallidos).toBeGreaterThanOrEqual(1);

    const cobro = await cobroDeSuscripcion(tenantId);
    expect(cobro.estado).toBe("fallido");

    const susFila = await pool.query(`SELECT estado FROM suscripciones WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(susFila.rows[0].estado).toBe("activa"); // sin cambios -- el paso de gracia decide después

    const auditoria = await pool.query(
      `SELECT resultado FROM platform_audit_log WHERE accion = 'billing.cobro_automatico_fallido' AND tenant_id = $1`,
      [tenantId]
    );
    expect(auditoria.rows[0].resultado).toBe("failure");
  });

  it("sin método de pago guardado: no rompe el job, marca el cobro fallido con el motivo", async () => {
    const tenantId = await nuevoTenantConSuscripcion("tarjeta");
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '1 hour' WHERE tenant_id = $1`,
      [tenantId]
    );
    await procesarVencimientosService();
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() - interval '1 hour'
       WHERE tenant_id = $1 AND tipo = 'suscripcion'`,
      [tenantId]
    );

    await expect(procesarVencimientosService()).resolves.toBeDefined();

    const cobro = await cobroDeSuscripcion(tenantId);
    expect(cobro.estado).toBe("fallido");
    expect(cobro.motivoFallo).toBeTruthy();
  });

  it("transferencia vencida: NO se toca -- sigue pendiente hasta que el admin confirme a mano", async () => {
    const tenantId = await nuevoTenantConSuscripcion("transferencia");
    await pool.query(
      `UPDATE suscripciones SET periodo_actual_fin = now() + interval '1 hour' WHERE tenant_id = $1`,
      [tenantId]
    );
    await procesarVencimientosService();
    await pool.query(
      `UPDATE cobros SET fecha_vencimiento = now() - interval '1 hour'
       WHERE tenant_id = $1 AND tipo = 'suscripcion'`,
      [tenantId]
    );

    await procesarVencimientosService();

    const cobro = await cobroDeSuscripcion(tenantId);
    expect(cobro.estado).toBe("pendiente");
  });
});
