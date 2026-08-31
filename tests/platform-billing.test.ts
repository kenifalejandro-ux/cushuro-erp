/** tests/platform-billing.test.ts
 *
 * Suscripciones/cobros (migración 0041_billing.sql). Cubre el servicio de
 * dominio completo vía las rutas -- alta (con/sin trial), cambio de plan
 * (sincronizado con tenants.plan_id, ver platformBilling.service.ts),
 * extender gracia, cancelar/reactivar, forzar cobro (StubPasarela) y que
 * cada mutación quede en platform_audit_log.
 *
 * precioReferencia se manda siempre a mano en vez de depender de
 * planes.precio_*_referencia: esas columnas quedan NULL hasta que alguien
 * las carga a propósito (ver el comentario de la migración), y tocarlas acá
 * mutaría una fila de `planes` compartida con el resto de la suite.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";
import { fijarPasarelaPagoParaTests, type PasarelaPago } from "../src/server/services/pasarelaPago";
import { fijarFetchBcrpParaTests } from "../src/server/services/platformTipoCambio.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

function altaBasica(over: Record<string, unknown> = {}) {
  return {
    plan: "mype",
    ciclo: "mensual",
    metodoFacturacion: "transferencia",
    precioReferencia: 49,
    ...over,
  };
}

afterEach(() => {
  fijarPasarelaPagoParaTests(null); // vuelve al default (Stub, sin CULQI_SECRET_KEY en tests)
  fijarFetchBcrpParaTests(null); // vuelve a fetch real
});

function fetchBcrpFalso(periods: Array<{ name: string; values: string[] }>) {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ periods });
    },
  });
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("alta de suscripción", () => {
  it("sin trial arranca 'activa' con el precio pasado a mano", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());

    expect(res.status).toBe(201);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(res.body.suscripcion.suscripcion.planCodigo).toBe("mype");
    expect(res.body.suscripcion.suscripcion.precioReferencia).toBe(49);
  });

  it("con trial arranca 'trialing' y fija trialTerminaEn", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 3 }));

    expect(res.body.suscripcion.suscripcion.estado).toBe("trialing");
    expect(res.body.suscripcion.suscripcion.trialTerminaEn).not.toBeNull();
  });

  it("sincroniza tenants.plan_id con el plan de la suscripción (nunca deben divergir)", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());

    const tenantFila = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenant.id]);
    const planFila = await pool.query(`SELECT id FROM planes WHERE codigo = 'mype'`);
    expect(tenantFila.rows[0].plan_id).toBe(planFila.rows[0].id);
  });

  it("404 si el tenant no existe", async () => {
    const res = await request(app)
      .post("/api/platform/tenants/00000000-0000-0000-0000-000000000000/suscripcion")
      .set("Authorization", BEARER)
      .send(altaBasica());
    expect(res.status).toBe(404);
  });

  it("409 si el tenant ya tiene una suscripción", async () => {
    const { tenant } = await nuevoTenant();
    const crear = () =>
      request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica());
    expect((await crear()).status).toBe(201);
    expect((await crear()).status).toBe(409);
  });

  it("401 sin credenciales", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .send(altaBasica());
    expect(res.status).toBe(401);
  });
});

describe("cambiar plan", () => {
  it("actualiza suscripciones.plan_id Y tenants.plan_id en la misma operación", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/suscripcion/plan`)
      .set("Authorization", BEARER)
      .send({ plan: "mediana", precioReferencia: 199, motivo: "el cliente creció" });

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.planCodigo).toBe("mediana");
    expect(res.body.suscripcion.suscripcion.precioReferencia).toBe(199);

    const tenantFila = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenant.id]);
    const planFila = await pool.query(`SELECT id FROM planes WHERE codigo = 'mediana'`);
    expect(tenantFila.rows[0].plan_id).toBe(planFila.rows[0].id);
  });

  it("queda auditado con antes/después", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await request(app)
      .put(`/api/platform/tenants/${tenant.id}/suscripcion/plan`)
      .set("Authorization", BEARER)
      .send({ plan: "mediana", precioReferencia: 199 });

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'billing.cambiar_plan' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].detalle.before.plan).toBe("mype");
    expect(auditoria.rows[0].detalle.after.plan).toBe("mediana");
  });
});

describe("extender gracia", () => {
  it("solo se puede desde en_gracia o suspendida", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/gracia`)
      .set("Authorization", BEARER)
      .send({ dias: 7 });
    expect(res.status).toBe(400); // todavía está 'activa'
  });

  it("desde suspendida vuelve a en_gracia y reactiva el acceso del tenant", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await pool.query(`UPDATE suscripciones SET estado = 'suspendida' WHERE tenant_id = $1`, [
      tenant.id,
    ]);
    await pool.query(`UPDATE tenants SET estado = 'suspended' WHERE id = $1`, [tenant.id]);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/gracia`)
      .set("Authorization", BEARER)
      .send({ dias: 5 });

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("en_gracia");
    expect(res.body.suscripcion.suscripcion.graciaTerminaEn).not.toBeNull();

    const tenantFila = await pool.query(`SELECT activo FROM tenants WHERE id = $1`, [tenant.id]);
    expect(tenantFila.rows[0].activo).toBe(true); // ver cambiarEstadoTenantService, nunca tenants.activo directo
  });
});

describe("cancelar y reactivar", () => {
  it("cancelar no toca tenants.estado (el admin lo decide aparte)", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cancelar`)
      .set("Authorization", BEARER)
      .send({ motivo: "cliente se dio de baja" });

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("cancelada");
    expect(res.body.suscripcion.suscripcion.canceladaEn).not.toBeNull();

    const tenantFila = await pool.query(`SELECT activo FROM tenants WHERE id = $1`, [tenant.id]);
    expect(tenantFila.rows[0].activo).toBe(true);
  });

  it("reactivar desde cancelada arma un período nuevo", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cancelar`)
      .set("Authorization", BEARER)
      .send({});

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/reactivar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(res.body.suscripcion.suscripcion.canceladaEn).toBeNull();
  });

  it("reactivar desde suspendida también reactiva el acceso del tenant", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await pool.query(`UPDATE suscripciones SET estado = 'suspendida' WHERE tenant_id = $1`, [
      tenant.id,
    ]);
    await pool.query(`UPDATE tenants SET estado = 'suspended' WHERE id = $1`, [tenant.id]);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/reactivar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    const tenantFila = await pool.query(`SELECT activo FROM tenants WHERE id = $1`, [tenant.id]);
    expect(tenantFila.rows[0].activo).toBe(true);
  });
});

describe("eliminar suscripción", () => {
  it("borra la fila pero conserva los cobros como registro huérfano (no cascada)", async () => {
    const { tenant } = await nuevoTenant();
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    const suscripcionId = alta.body.suscripcion.suscripcion.id;
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);

    const res = await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);

    const suscripcion = await pool.query(`SELECT id FROM suscripciones WHERE id = $1`, [
      suscripcionId,
    ]);
    expect(suscripcion.rows).toHaveLength(0);

    const cobro = await pool.query(`SELECT suscripcion_id FROM cobros WHERE tenant_id = $1`, [
      tenant.id,
    ]);
    expect(cobro.rows).toHaveLength(1); // el cobro sigue existiendo...
    expect(cobro.rows[0].suscripcion_id).toBeNull(); // ...pero huérfano, no se borró

    const leido = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);
    expect(leido.body.suscripcion.suscripcion).toBeNull(); // el tenant vuelve a "sin suscripción"
  });

  it("no toca tenants.plan_id (las cuotas quedan como decisión aparte)", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    const planAntes = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenant.id]);

    await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);

    const planDespues = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenant.id]);
    expect(planDespues.rows[0].plan_id).toBe(planAntes.rows[0].plan_id);
  });

  it("después de borrar, se puede dar de alta una suscripción nueva sin chocar con el 409", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ plan: "mediana" }));
    expect(res.status).toBe(201);
  });

  it("404 si el tenant no tiene suscripción", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(404);
  });

  it("queda auditado", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.eliminar_suscripcion' AND tenant_id = $1`,
      [tenant.id]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("cortesía comercial (trialMeses, no es trial de producto)", () => {
  it("acepta hasta 12 meses de exoneración negociada", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 12 }));

    expect(res.status).toBe(201);
    expect(res.body.suscripcion.suscripcion.estado).toBe("trialing");
  });

  it("rechaza más de 12 meses", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 13 }));
    expect(res.status).toBe(400);
  });
});

describe("forzar cobro", () => {
  it("por transferencia: registra el cobro exitoso y extiende el período (el admin es la fuente de verdad)", async () => {
    const { tenant } = await nuevoTenant();
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    const finAnterior = alta.body.suscripcion.suscripcion.periodoActualFin;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(res.body.suscripcion.suscripcion.periodoActualFin > finAnterior).toBe(true);
    expect(res.body.suscripcion.cobrosRecientes[0].estado).toBe("exitoso");
    expect(res.body.suscripcion.cobrosRecientes[0].moneda).toBe("USD");
  });

  it("por tarjeta sin método de pago guardado: 400", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" }));

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(400);
  });

  it("por tarjeta con método guardado: cobra en PEN vía la pasarela y avanza el período si es exitoso", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" }));
    await pool.query(
      `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
       VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
      [tenant.id]
    );

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(res.body.suscripcion.cobrosRecientes[0].estado).toBe("exitoso");
    expect(res.body.suscripcion.cobrosRecientes[0].moneda).toBe("PEN");
  });

  it("cobro fallido: no toca el estado de la suscripción, solo registra el intento", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" }));
    await pool.query(
      `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
       VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
      [tenant.id]
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

    const antes = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);
    const finAntes = antes.body.suscripcion.suscripcion.periodoActualFin;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa"); // sin cambios
    expect(res.body.suscripcion.suscripcion.periodoActualFin).toBe(finAntes); // sin avanzar
    expect(res.body.suscripcion.cobrosRecientes[0].estado).toBe("fallido");
    expect(res.body.suscripcion.cobrosRecientes[0].motivoFallo).toBe("Fondos insuficientes");
  });
});

describe("tipo de cambio: job automático desde el BCRP", () => {
  it("toma el último valor publicado (ignora 'n.d.' de días sin publicación) y lo audita como system", async () => {
    fijarFetchBcrpParaTests(
      fetchBcrpFalso([
        { name: "13.Ago.26", values: ["3.3648571"] },
        { name: "14.Ago.26", values: ["3.3645714"] },
        { name: "17.Ago.26", values: ["n.d."] }, // hoy, todavía no publicado
      ])
    );

    const res = await request(app)
      .post("/api/platform/billing/tipo-cambio/actualizar-desde-bcrp")
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.tipoCambio.valor).toBe(3.3646); // redondeado a 4 decimales (columna NUMERIC(10,4))

    const releido = await request(app)
      .get("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER);
    expect(releido.body.tipoCambio.valor).toBe(3.3646);

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'billing.actualizar_tipo_cambio' AND actor_type = 'system'
       ORDER BY creado_en DESC LIMIT 1`
    );
    expect(auditoria.rows[0].detalle.after).toBe(3.3646);

    // deja el TC global como estaba antes de este test
    await request(app)
      .put("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER)
      .send({ valor: releido.body.tipoCambio.valor });
  });

  it("502 si el BCRP no publicó nada en toda la ventana (no deja el TC global desactualizado en silencio)", async () => {
    fijarFetchBcrpParaTests(
      fetchBcrpFalso([
        { name: "16.Ago.26", values: ["n.d."] },
        { name: "17.Ago.26", values: ["n.d."] },
      ])
    );
    const res = await request(app)
      .post("/api/platform/billing/tipo-cambio/actualizar-desde-bcrp")
      .set("Authorization", BEARER);
    expect(res.status).toBe(502);
  });

  it("502 si el BCRP responde con error HTTP", async () => {
    fijarFetchBcrpParaTests(async () => ({
      ok: false,
      status: 503,
      async text() {
        return "";
      },
    }));
    const res = await request(app)
      .post("/api/platform/billing/tipo-cambio/actualizar-desde-bcrp")
      .set("Authorization", BEARER);
    expect(res.status).toBe(502);
  });

  it("tolera el aviso de PHP que el BCRP a veces pega después del JSON (visto en vivo 2026-08-17)", async () => {
    const anterior = (
      await request(app).get("/api/platform/billing/tipo-cambio").set("Authorization", BEARER)
    ).body.tipoCambio.valor;

    const jsonValido = JSON.stringify({
      periods: [{ name: "14.Ago.26", values: ["3.3645714"] }],
    });
    fijarFetchBcrpParaTests(async () => ({
      ok: true,
      status: 200,
      async text() {
        return `${jsonValido}<br />\n<font size='1'><table class='xdebug-error'>...</table></font>`;
      },
    }));

    const res = await request(app)
      .post("/api/platform/billing/tipo-cambio/actualizar-desde-bcrp")
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.tipoCambio.valor).toBe(3.3646);

    // deja el TC global como estaba antes de este test
    await request(app)
      .put("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER)
      .send({ valor: anterior });
  });
});

describe("tipo de cambio USD -> PEN (migración 0053)", () => {
  it("GET expone el valor global vigente", async () => {
    const res = await request(app)
      .get("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.tipoCambio.valor).toBeGreaterThan(0);
  });

  it("PUT actualiza el valor global (append-only) y lo audita", async () => {
    const anterior = (
      await request(app).get("/api/platform/billing/tipo-cambio").set("Authorization", BEARER)
    ).body.tipoCambio.valor;

    const res = await request(app)
      .put("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER)
      .send({ valor: 3.91 });
    expect(res.status).toBe(200);
    expect(res.body.tipoCambio.valor).toBe(3.91);

    const releido = await request(app)
      .get("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER);
    expect(releido.body.tipoCambio.valor).toBe(3.91);

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'billing.actualizar_tipo_cambio' ORDER BY creado_en DESC LIMIT 1`
    );
    expect(auditoria.rows[0].detalle.before).toBe(anterior);
    expect(auditoria.rows[0].detalle.after).toBe(3.91);

    // deja el valor global como estaba -- es un dato compartido por toda la
    // suite (y por el panel local de Kenif), no algo scoped a este test.
    await request(app)
      .put("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER)
      .send({ valor: anterior });
  });

  it("401 sin credenciales", async () => {
    const res = await request(app).put("/api/platform/billing/tipo-cambio").send({ valor: 4 });
    expect(res.status).toBe(401);
  });

  describe("override por suscripción (excepción puntual, no la norma)", () => {
    it("solo se puede fijar cuando metodoFacturacion es 'tarjeta'", async () => {
      const { tenant } = await nuevoTenant();
      await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "transferencia" }));

      const res = await request(app)
        .put(`/api/platform/tenants/${tenant.id}/suscripcion/tipo-cambio`)
        .set("Authorization", BEARER)
        .send({ valor: 3.6 });
      expect(res.status).toBe(400);
    });

    it("se puede fijar y luego quitar (valor: null) en una suscripción con tarjeta", async () => {
      const { tenant } = await nuevoTenant();
      await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "tarjeta" }));

      const fijar = await request(app)
        .put(`/api/platform/tenants/${tenant.id}/suscripcion/tipo-cambio`)
        .set("Authorization", BEARER)
        .send({ valor: 3.6 });
      expect(fijar.status).toBe(200);
      expect(fijar.body.suscripcion.suscripcion.tipoCambioOverride).toBe(3.6);

      const quitar = await request(app)
        .put(`/api/platform/tenants/${tenant.id}/suscripcion/tipo-cambio`)
        .set("Authorization", BEARER)
        .send({ valor: null });
      expect(quitar.status).toBe(200);
      expect(quitar.body.suscripcion.suscripcion.tipoCambioOverride).toBeNull();
    });

    it("queda auditado con antes/después", async () => {
      const { tenant } = await nuevoTenant();
      await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "tarjeta" }));
      await request(app)
        .put(`/api/platform/tenants/${tenant.id}/suscripcion/tipo-cambio`)
        .set("Authorization", BEARER)
        .send({ valor: 3.6 });

      const auditoria = await pool.query(
        `SELECT detalle FROM platform_audit_log
         WHERE accion = 'billing.actualizar_tipo_cambio_override' AND tenant_id = $1
         ORDER BY creado_en DESC LIMIT 1`,
        [tenant.id]
      );
      expect(auditoria.rows).toHaveLength(1);
      expect(auditoria.rows[0].detalle.before).toBeNull();
      expect(auditoria.rows[0].detalle.after).toBe(3.6);
    });
  });

  describe("en la alta de suscripción", () => {
    it("400 si se manda tipoCambioOverride sin metodoFacturacion 'tarjeta'", async () => {
      const { tenant } = await nuevoTenant();
      const res = await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "transferencia", tipoCambioOverride: 3.6 }));
      expect(res.status).toBe(400);
    });

    it("se persiste cuando metodoFacturacion es 'tarjeta'", async () => {
      const { tenant } = await nuevoTenant();
      const res = await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "tarjeta", tipoCambioOverride: 3.6 }));
      expect(res.status).toBe(201);
      expect(res.body.suscripcion.suscripcion.tipoCambioOverride).toBe(3.6);
    });
  });

  describe("resolución de tasa al forzar cobro", () => {
    it("sin override: usa el tipo de cambio global vigente", async () => {
      const { tenant } = await nuevoTenant();
      const global = (
        await request(app).get("/api/platform/billing/tipo-cambio").set("Authorization", BEARER)
      ).body.tipoCambio.valor;

      await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "tarjeta" }));
      await pool.query(
        `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
         VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
        [tenant.id]
      );

      const res = await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
        .set("Authorization", BEARER);
      expect(res.status).toBe(200);

      const cobro = await pool.query(
        `SELECT tipo_cambio_aplicado AS "tipoCambioAplicado", monto FROM cobros
         WHERE tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
        [tenant.id]
      );
      expect(Number(cobro.rows[0].tipoCambioAplicado)).toBe(global);
      expect(Number(cobro.rows[0].monto)).toBe(
        Math.round(altaBasica().precioReferencia * global * 100) / 100
      );
    });

    it("con override: usa la tasa propia del cliente, no la global", async () => {
      const { tenant } = await nuevoTenant();
      await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
        .set("Authorization", BEARER)
        .send(altaBasica({ metodoFacturacion: "tarjeta", tipoCambioOverride: 3.6 }));
      await pool.query(
        `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
         VALUES ($1, 'stub', 'tok_test', 'visa', '4242', true)`,
        [tenant.id]
      );

      const res = await request(app)
        .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
        .set("Authorization", BEARER);
      expect(res.status).toBe(200);

      const cobro = await pool.query(
        `SELECT tipo_cambio_aplicado AS "tipoCambioAplicado", monto FROM cobros
         WHERE tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
        [tenant.id]
      );
      expect(Number(cobro.rows[0].tipoCambioAplicado)).toBe(3.6);
      expect(Number(cobro.rows[0].monto)).toBe(
        Math.round(altaBasica().precioReferencia * 3.6 * 100) / 100
      );
    });
  });
});

describe("lectura", () => {
  it("suscripcion null cuando el tenant no tiene suscripción todavía (el objeto en sí siempre existe)", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion).toBeNull();
    expect(res.body.suscripcion.cobrosRecientes).toEqual([]);
  });
});

describe("cobro de implementación", () => {
  it("se puede registrar ANTES de que exista una suscripción", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 10000, moneda: "USD", descripcion: "Implementación ERP" });

    expect(res.status).toBe(201);
    expect(res.body.suscripcion.suscripcion).toBeNull(); // sigue sin suscripción
    expect(res.body.suscripcion.cobrosRecientes).toHaveLength(1);
    expect(res.body.suscripcion.cobrosRecientes[0].tipo).toBe("implementacion");
    expect(res.body.suscripcion.cobrosRecientes[0].monto).toBe(10000);
    expect(res.body.suscripcion.cobrosRecientes[0].estado).toBe("exitoso");
  });

  it("se linkea a la suscripción si ya existe", async () => {
    const { tenant } = await nuevoTenant();
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    const suscripcionId = alta.body.suscripcion.suscripcion.id;

    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 5000, moneda: "USD" });

    const cobro = await pool.query(
      `SELECT suscripcion_id FROM cobros WHERE tenant_id = $1 AND tipo = 'implementacion'`,
      [tenant.id]
    );
    expect(cobro.rows[0].suscripcion_id).toBe(suscripcionId);
  });

  it("queda auditado", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 10000, moneda: "USD" });

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.registrar_cobro_implementacion' AND tenant_id = $1`,
      [tenant.id]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("401 sin credenciales", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .send({ monto: 10000, moneda: "USD" });
    expect(res.status).toBe(401);
  });

  it("adelanto/saldo: se puede registrar una cuota como pendiente y cerrarla después", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", descripcion: "Adelanto", estado: "exitoso" });
    const saldo = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", descripcion: "Saldo", estado: "pendiente" });

    const cobroSaldoId = saldo.body.suscripcion.cobrosRecientes.find(
      (c: any) => c.descripcion === "Saldo"
    ).id;
    expect(
      saldo.body.suscripcion.cobrosRecientes.find((c: any) => c.descripcion === "Saldo").estado
    ).toBe("pendiente");

    const marcado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroSaldoId}/marcar-pagado`)
      .set("Authorization", BEARER);
    expect(marcado.status).toBe(200);
    const saldoActualizado = marcado.body.suscripcion.cobrosRecientes.find(
      (c: any) => c.id === cobroSaldoId
    );
    expect(saldoActualizado.estado).toBe("exitoso");
  });

  it("400 al marcar como pagado un cobro que no está pendiente", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 1000, moneda: "USD" }); // exitoso por default
    const cobroId = res.body.suscripcion.cobrosRecientes[0].id;

    const marcado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/marcar-pagado`)
      .set("Authorization", BEARER);
    expect(marcado.status).toBe(400);
  });

  it("404 si el cobro no pertenece a ese tenant", async () => {
    const { tenant: tenantA } = await nuevoTenant();
    const { tenant: tenantB } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenantA.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 1000, moneda: "USD", estado: "pendiente" });
    const cobroId = res.body.suscripcion.cobrosRecientes[0].id;

    const marcado = await request(app)
      .post(`/api/platform/tenants/${tenantB.id}/cobros/${cobroId}/marcar-pagado`)
      .set("Authorization", BEARER);
    expect(marcado.status).toBe(404);
  });

  it("fecha personalizada: se persiste tal cual, no 'hoy'", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", fecha: "2026-08-08" });

    expect(res.status).toBe(201);
    expect(res.body.suscripcion.cobrosRecientes[0].fechaPago.slice(0, 10)).toBe("2026-08-08");
  });

  it("sin fecha: usa hoy por default", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD" });

    const hoy = new Date().toISOString().slice(0, 10);
    expect(res.body.suscripcion.cobrosRecientes[0].fechaPago.slice(0, 10)).toBe(hoy);
  });

  it("estado 'pendiente' con fecha: 400 -- el pago todavía no pasó, no hay fecha que poner", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", estado: "pendiente", fecha: "2026-08-08" });
    expect(res.status).toBe(400);
  });

  it("estado 'pendiente' (sin fecha): fechaPago queda null hasta que se registre el pago", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", estado: "pendiente" });

    expect(res.status).toBe(201);
    expect(res.body.suscripcion.cobrosRecientes[0].fechaPago).toBeNull();
  });

  it("registrar pago con fecha propia: fechaPago pasa a esa fecha, no a hoy", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 400, fecha: "2026-09-01" });

    expect(res.status).toBe(200);
    const cobro = res.body.suscripcion.cobrosRecientes[0];
    expect(cobro.estado).toBe("exitoso");
    expect(cobro.fechaPago.slice(0, 10)).toBe("2026-09-01");
  });

  it("editar fecha de un cobro que sigue 'pendiente': 400 -- no hay fecha de pago que corregir todavía", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ fecha: "2026-08-08" });
    expect(res.status).toBe(400);
  });

  it("PEN sin tipoCambioAplicado: 400 (no hay pasarela que lo calcule sola acá)", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 1350, moneda: "PEN" });
    expect(res.status).toBe(400);
  });

  it("USD con tipoCambioAplicado: 400 (no hay conversión de por medio)", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", tipoCambioAplicado: 3.38 });
    expect(res.status).toBe(400);
  });

  it("PEN con tipoCambioAplicado: se persiste el pactado, no el TC global de hoy", async () => {
    const { tenant } = await nuevoTenant();
    // Cambia el TC global a un valor bien distinto del pactado, para
    // confirmar que el cobro no lo usa.
    await request(app)
      .put("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER)
      .send({ valor: 9.99 });

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 1352, moneda: "PEN", fecha: "2026-08-08", tipoCambioAplicado: 3.38 });

    expect(res.status).toBe(201);
    const cobro = res.body.suscripcion.cobrosRecientes[0];
    expect(cobro.tipoCambioAplicado).toBe(3.38);
    expect(cobro.fechaPago.slice(0, 10)).toBe("2026-08-08");

    // deja el TC global como estaba
    await request(app)
      .put("/api/platform/billing/tipo-cambio")
      .set("Authorization", BEARER)
      .send({ valor: 3.75 });
  });

  it("fecha y TC editables incluso después de 'exitoso', sin tocar el monto", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 1350, moneda: "PEN", tipoCambioAplicado: 3.75 }); // exitoso por default
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ fecha: "2026-08-08", tipoCambioAplicado: 3.38 });

    expect(res.status).toBe(200);
    const cobro = res.body.suscripcion.cobrosRecientes[0];
    expect(cobro.fechaPago.slice(0, 10)).toBe("2026-08-08");
    expect(cobro.tipoCambioAplicado).toBe(3.38);
    expect(cobro.monto).toBe(1350); // sin cambios -- solo se corrigió metadata
    expect(cobro.estado).toBe("exitoso");
  });
});

describe("iniciar cortesía", () => {
  it("recalcula periodo_actual_inicio/trial_termina_en desde hoy", async () => {
    const { tenant } = await nuevoTenant();
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 6 }));
    const trialTerminaEnAntes = alta.body.suscripcion.suscripcion.trialTerminaEn;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-cortesia`)
      .set("Authorization", BEARER)
      .send({ trialMeses: 6 });

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("trialing");
    // Se recalcula desde "ahora" (segundos/milisegundos después del alta),
    // así que la fecha nueva tiene que ser >= la anterior, no exactamente
    // igual -- son dos now() distintos separados por el tiempo del test.
    expect(res.body.suscripcion.suscripcion.trialTerminaEn >= trialTerminaEnAntes).toBe(true);
  });

  it("400 si el estado no es trialing", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica()); // sin trialMeses -> arranca 'activa'

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-cortesia`)
      .set("Authorization", BEARER)
      .send({ trialMeses: 6 });
    expect(res.status).toBe(400);
  });

  it("queda auditado", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 3 }));
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-cortesia`)
      .set("Authorization", BEARER)
      .send({ trialMeses: 3 });

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.iniciar_cortesia' AND tenant_id = $1`,
      [tenant.id]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("iniciar facturación (el paso que le faltaba a iniciar-cortesia)", () => {
  it("desde trialing: resetea el período desde hoy y pasa a 'activa'", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 6 }));

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-facturacion`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(res.body.suscripcion.suscripcion.trialTerminaEn).toBeNull();
    const finNuevo = new Date(res.body.suscripcion.suscripcion.periodoActualFin);
    const enUnMes = new Date();
    enUnMes.setMonth(enUnMes.getMonth() + 1);
    // Margen de DOS días, no de uno: Postgres y JavaScript no resuelven
    // igual "un mes después" cuando el día de origen no existe en el mes
    // destino. El 31 de agosto, `now() + interval '1 month'` da 30 de
    // septiembre (Postgres clampea al último día del mes) mientras que
    // `setMonth(+1)` de JS rueda a 1 de octubre -- exactamente un día de
    // diferencia, que con un margen de "menos de un día" hacía fallar este
    // test por los milisegundos de latencia del request.
    //
    // Pasaba solo los días 31 de un mes seguido por uno de 30 (y a fin de
    // enero), o sea un puñado de días al año: se encontró corriendo la
    // suite un 31 de agosto. Lo que este test verifica no es la precisión
    // del redondeo sino que la fecha se haya RESETEADO -- que no sea la de
    // la cortesía, años en el futuro -- y para eso dos días sobran.
    expect(Math.abs(finNuevo.getTime() - enUnMes.getTime())).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("desde activa: también resetea (corrige una fecha mal anclada)", async () => {
    const { tenant } = await nuevoTenant();
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    const finAntes = alta.body.suscripcion.suscripcion.periodoActualFin;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-facturacion`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.suscripcion.estado).toBe("activa");
    expect(res.body.suscripcion.suscripcion.periodoActualFin >= finAntes).toBe(true);
  });

  it("400 desde cancelada/suspendida/en_gracia", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cancelar`)
      .set("Authorization", BEARER)
      .send({});

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-facturacion`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(400);
  });

  it("queda auditado con el estado y período anteriores", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ trialMeses: 6 }));
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/iniciar-facturacion`)
      .set("Authorization", BEARER);

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'billing.iniciar_facturacion' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].detalle.estadoAnterior).toBe("trialing");
    expect(auditoria.rows[0].detalle.periodoActualFinAnterior).toBeTruthy();
  });

  it("401 sin credenciales", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app).post(
      `/api/platform/tenants/${tenant.id}/suscripcion/iniciar-facturacion`
    );
    expect(res.status).toBe(401);
  });
});

describe("editar cobro", () => {
  it("descripción editable siempre, incluso en un cobro 'exitoso'", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", descripcion: "Adelanto" }); // exitoso por default
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ descripcion: "Adelanto implementación (corregido)" });

    expect(res.status).toBe(200);
    const cobro = res.body.suscripcion.cobrosRecientes.find((c: any) => c.id === cobroId);
    expect(cobro.descripcion).toBe("Adelanto implementación (corregido)");
    expect(cobro.monto).toBe(400); // sin cambios
  });

  it("monto/moneda editables mientras el cobro sigue 'pendiente'", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ monto: 450, moneda: "PEN", tipoCambioAplicado: 3.75 });

    expect(res.status).toBe(200);
    const cobro = res.body.suscripcion.cobrosRecientes.find((c: any) => c.id === cobroId);
    expect(cobro.monto).toBe(450);
    expect(cobro.moneda).toBe("PEN");
  });

  it("400 al intentar cambiar monto/moneda de un cobro 'exitoso'", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD" }); // exitoso por default
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ monto: 999 });
    expect(res.status).toBe(400);

    const cobro = await pool.query(`SELECT monto FROM cobros WHERE id = $1`, [cobroId]);
    expect(Number(cobro.rows[0].monto)).toBe(400); // no se tocó
  });

  it("404 si el cobro no pertenece a ese tenant", async () => {
    const { tenant: tenantA } = await nuevoTenant();
    const { tenant: tenantB } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenantA.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .put(`/api/platform/tenants/${tenantB.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ descripcion: "intento cruzado" });
    expect(res.status).toBe(404);
  });

  it("queda auditado con antes/después", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", descripcion: "Adelanto", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    await request(app)
      .put(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER)
      .send({ monto: 450, descripcion: "Adelanto ajustado" });

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log WHERE accion = 'billing.editar_cobro' AND tenant_id = $1`,
      [tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].detalle.before.monto).toBe(400);
    expect(auditoria.rows[0].detalle.after.monto).toBe(450);
  });
});

describe("eliminar cobro", () => {
  it("borra un cobro de implementación por completo", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD", descripcion: "Ejemplo de prueba" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.suscripcion.cobrosRecientes).toHaveLength(0);

    const fila = await pool.query(`SELECT id FROM cobros WHERE id = $1`, [cobroId]);
    expect(fila.rows).toHaveLength(0);
  });

  it("404 al intentar borrar un cobro tipo 'suscripcion' (solo implementación es borrable)", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica());
    const cobro = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);
    const cobroId = cobro.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(404);

    const fila = await pool.query(`SELECT id FROM cobros WHERE id = $1`, [cobroId]);
    expect(fila.rows).toHaveLength(1); // sigue existiendo, no se borró
  });

  it("404 si el cobro no pertenece a ese tenant", async () => {
    const { tenant: tenantA } = await nuevoTenant();
    const { tenant: tenantB } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenantA.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .delete(`/api/platform/tenants/${tenantB.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(404);
  });

  it("queda auditado", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    await request(app)
      .delete(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`)
      .set("Authorization", BEARER);

    const auditoria = await pool.query(
      `SELECT id FROM platform_audit_log WHERE accion = 'billing.eliminar_cobro' AND tenant_id = $1`,
      [tenant.id]
    );
    expect(auditoria.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("401 sin credenciales", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 400, moneda: "USD" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app).delete(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}`);
    expect(res.status).toBe(401);
  });
});

describe("registrar pago (parcial o total) sobre un cobro pendiente", () => {
  it("pago parcial: baja el saldo y el cobro sigue 'pendiente'", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD", descripcion: "Implementación", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 500 });

    expect(res.status).toBe(200);
    const cobro = res.body.suscripcion.cobrosRecientes[0];
    expect(cobro.estado).toBe("pendiente");
    expect(cobro.montoPagado).toBe(500);
  });

  it("el segundo pago por el saldo restante lo cierra en 'exitoso'", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 500 });
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 300 });

    expect(res.status).toBe(200);
    const cobro = res.body.suscripcion.cobrosRecientes[0];
    expect(cobro.estado).toBe("exitoso");
    expect(cobro.montoPagado).toBe(800);
  });

  it("400 si el pago supera el saldo pendiente", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 900 });
    expect(res.status).toBe(400);
  });

  it("400 si el cobro ya está 'exitoso' (no se puede volver a pagar)", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD" }); // estado ausente = 'exitoso'
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 100 });
    expect(res.status).toBe(400);
  });

  it("queda auditado con saldoAntes/saldoDespues", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .set("Authorization", BEARER)
      .send({ montoPagado: 500 });

    const auditoria = await pool.query(
      `SELECT detalle FROM platform_audit_log
       WHERE accion = 'billing.registrar_pago_cobro' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].detalle.montoPagado).toBe(500);
    expect(auditoria.rows[0].detalle.saldoAntes).toBe(800);
    expect(auditoria.rows[0].detalle.saldoDespues).toBe(300);
  });

  it("401 sin credenciales", async () => {
    const { tenant } = await nuevoTenant();
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros-implementacion`)
      .set("Authorization", BEARER)
      .send({ monto: 800, moneda: "USD", estado: "pendiente" });
    const cobroId = creado.body.suscripcion.cobrosRecientes[0].id;

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/cobros/${cobroId}/pago`)
      .send({ montoPagado: 500 });
    expect(res.status).toBe(401);
  });
});

describe("método de pago de prueba", () => {
  it("con la Stub activa: NO se muestra en metodoPago (es testing interno, no un registro real) pero sí habilita el cobro por tarjeta", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" }));

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/metodo-pago-prueba`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(201);
    // No aparece en el campo de lectura -- una tarjeta de prueba no debe
    // verse en el panel como si el tenant la hubiera registrado de verdad.
    expect(res.body.suscripcion.metodoPago).toBeNull();

    // Pero sigue funcionando por dentro: forzarCobroService consulta
    // metodos_pago directo, no pasa por el campo metodoPago de lectura.
    const cobro = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/cobrar`)
      .set("Authorization", BEARER);
    expect(cobro.status).toBe(200);
    expect(cobro.body.suscripcion.cobrosRecientes[0].estado).toBe("exitoso");
  });

  it("400 cuando la pasarela activa no es la Stub", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" })); // aísla la variable bajo prueba: solo la pasarela

    const pasarelaNoStub: PasarelaPago = {
      nombre: "culqi",
      async crearCargo() {
        return { idPasarela: "x", estado: "exitoso" };
      },
      verificarWebhook() {
        return null;
      },
    };
    fijarPasarelaPagoParaTests(pasarelaNoStub);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/metodo-pago-prueba`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(400);
  });

  it("400 si la suscripción factura por transferencia (no tiene sentido agregarle tarjeta)", async () => {
    const { tenant } = await nuevoTenant();
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "transferencia" }));

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/metodo-pago-prueba`)
      .set("Authorization", BEARER);
    expect(res.status).toBe(400);
  });
});

describe("método de pago: solo se expone si metodoFacturacion es 'tarjeta'", () => {
  it("con transferencia, GET nunca devuelve metodoPago aunque exista una tarjeta guardada de antes", async () => {
    const { tenant } = await nuevoTenant();
    // Se da de alta con tarjeta primero para poder sembrar una tarjeta de
    // prueba de verdad (crearMetodoPagoPruebaService lo exige) -- después
    // se cambia a transferencia sin borrar esa fila de metodos_pago, que es
    // exactamente el escenario real que reportó el bug (una tarjeta vieja
    // de una prueba anterior, con metodoFacturacion ya cambiado).
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" }));
    await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion/metodo-pago-prueba`)
      .set("Authorization", BEARER);

    // Fuerza el cambio a transferencia directo en DB -- no hay endpoint
    // para cambiar metodoFacturacion sin recrear la suscripción, así que
    // esto reproduce el estado real reportado sin pasar por una ruta que
    // no existe.
    await pool.query(
      `UPDATE suscripciones SET metodo_facturacion = 'transferencia' WHERE tenant_id = $1`,
      [tenant.id]
    );

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);

    expect(res.body.suscripcion.suscripcion.metodoFacturacion).toBe("transferencia");
    expect(res.body.suscripcion.metodoPago).toBeNull();

    // La fila sigue en la base (no se borra nada), simplemente no se expone.
    const filaMetodo = await pool.query(
      `SELECT id FROM metodos_pago WHERE tenant_id = $1 AND es_default = true`,
      [tenant.id]
    );
    expect(filaMetodo.rows).toHaveLength(1);
  });

  it("con tarjeta REAL (pasarela != 'stub'), GET sí devuelve el metodoPago -- no hay endpoint todavía para registrar una de verdad (checkout real fuera de alcance), así que se siembra directo en DB para probar el caso positivo", async () => {
    const { tenant } = await nuevoTenant();
    const alta = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER)
      .send(altaBasica({ metodoFacturacion: "tarjeta" }));
    const tenantId = alta.body.suscripcion.suscripcion.tenantId;

    await pool.query(
      `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, es_default)
       VALUES ($1, 'culqi', 'tok_real_test', 'mastercard', '1234', true)`,
      [tenantId]
    );

    const res = await request(app)
      .get(`/api/platform/tenants/${tenant.id}/suscripcion`)
      .set("Authorization", BEARER);

    expect(res.body.suscripcion.metodoPago).not.toBeNull();
    expect(res.body.suscripcion.metodoPago.ultimos4).toBe("1234");
  });
});

describe("pasarela activa", () => {
  it("expone qué pasarela está activa para que la UI decida qué mostrar", async () => {
    const res = await request(app)
      .get("/api/platform/billing/pasarela")
      .set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(["stub", "culqi"]).toContain(res.body.nombre);
  });
});
