/** tests/platform-domain.test.ts
 *
 * Verificación de propiedad de dominio personalizado
 * (migrations/0020_tenant_dominio_verificacion.sql). El caso "resuelve
 * login por dominio recién verificado" ya está cubierto de punta a punta
 * en tests/tenant-resolution.test.ts — acá se prueban los estados y las
 * ramas de error que ese archivo no toca.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import request from "supertest";

vi.mock("dns/promises", () => ({
  resolveTxt: vi.fn().mockRejectedValue(Object.assign(new Error("no encontrado"), { code: "ENOTFOUND" })),
}));

const { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } = await import("./helpers");
const { env } = await import("../src/server/config/env");
const { pool, closeDatabase } = await import("../src/server/config/database");

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("asignarDominioTenantService / PATCH .../dominio", () => {
  it("un dominio nuevo entra en pendiente_verificacion con token y registro TXT armado", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("nuevo")}.test.local`;

    const res = await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    expect(res.status).toBe(200);
    expect(res.body.dominio.dominioEstado).toBe("pendiente_verificacion");
    expect(res.body.dominio.dominioRegistroEsperado).toBe(`_mincore-verification.${dominio}`);
    expect(res.body.dominio.dominioValorEsperado).toMatch(/^mincore-verify=[a-f0-9]{32}$/);
    expect(res.body.dominio.dominioVerificadoEn).toBeNull();
  });

  it("rechaza con 409 un dominio que ya está asignado a otro tenant", async () => {
    const { tenant: tenantA } = await nuevoTenant();
    const { tenant: tenantB } = await nuevoTenant();
    const dominio = `${idUnico("duplicado")}.test.local`;

    const primero = await request(app)
      .patch(`/api/platform/tenants/${tenantA.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });
    expect(primero.status).toBe(200);

    const segundo = await request(app)
      .patch(`/api/platform/tenants/${tenantB.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });
    expect(segundo.status).toBe(409);
  });

  it("asignar null limpia el dominio y lo deja en desactivado", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("aquitar")}.test.local`;

    await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    const res = await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: null });

    expect(res.status).toBe(200);
    expect(res.body.dominio.dominioPersonalizado).toBeNull();
    expect(res.body.dominio.dominioEstado).toBe("desactivado");
  });
});

describe("verificarDominioService / POST .../dominio/verificar", () => {
  it("si el TXT record no existe (o no coincide), pasa a 'fallido' y queda auditado como failure", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("fallido")}.test.local`;

    await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    // El mock de dns/promises rechaza con ENOTFOUND por default — no hace
    // falta configurar nada más para simular "todavía no propagó".
    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/dominio/verificar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.dominio.dominioEstado).toBe("fallido");
    expect(res.body.dominio.dominioVerificacionIntentos).toBe(1);

    const auditoria = await pool.query(
      `SELECT resultado FROM platform_audit_log
       WHERE accion = 'verificar_dominio_tenant' AND tenant_id = $1
       ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].resultado).toBe("failure");
  });

  it("si el TXT record coincide, pasa a 'activo' y queda auditado como success", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("exitoso")}.test.local`;

    const asignar = await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    const { resolveTxt } = await import("dns/promises");
    vi.mocked(resolveTxt).mockResolvedValueOnce([[asignar.body.dominio.dominioValorEsperado]]);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/dominio/verificar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.dominio.dominioEstado).toBe("activo");
    expect(res.body.dominio.dominioVerificadoEn).not.toBeNull();

    const auditoria = await pool.query(
      `SELECT resultado FROM platform_audit_log
       WHERE accion = 'verificar_dominio_tenant' AND tenant_id = $1
       ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].resultado).toBe("success");
  });

  it("un TXT record con el prefijo correcto pero el valor equivocado sigue fallando (no basta con que exista el registro)", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("valorincorrecto")}.test.local`;

    await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    const { resolveTxt } = await import("dns/promises");
    vi.mocked(resolveTxt).mockResolvedValueOnce([["mincore-verify=un-token-que-no-es-el-nuestro"]]);

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/dominio/verificar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.dominio.dominioEstado).toBe("fallido");
  });

  it("reintentar después de un fallo puede pasar a activo sin perder el token (no hace falta reasignar el dominio)", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("reintento")}.test.local`;

    const asignar = await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    const primerIntento = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/dominio/verificar`)
      .set("Authorization", BEARER);
    expect(primerIntento.body.dominio.dominioEstado).toBe("fallido");

    const { resolveTxt } = await import("dns/promises");
    vi.mocked(resolveTxt).mockResolvedValueOnce([[asignar.body.dominio.dominioValorEsperado]]);

    const segundoIntento = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/dominio/verificar`)
      .set("Authorization", BEARER);
    expect(segundoIntento.status).toBe(200);
    expect(segundoIntento.body.dominio.dominioEstado).toBe("activo");
    expect(segundoIntento.body.dominio.dominioVerificacionIntentos).toBe(2);
  });

  it("da 400 si el tenant no tiene ningún dominio pendiente de verificar", async () => {
    const { tenant } = await nuevoTenant();

    const res = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/dominio/verificar`)
      .set("Authorization", BEARER);

    expect(res.status).toBe(400);
  });
});

describe("GET .../dominio", () => {
  it("devuelve el estado actual sin disparar ninguna consulta DNS", async () => {
    const { tenant } = await nuevoTenant();
    const dominio = `${idUnico("lectura")}.test.local`;

    await request(app)
      .patch(`/api/platform/tenants/${tenant.id}/dominio`)
      .set("Authorization", BEARER)
      .send({ dominioPersonalizado: dominio });

    const { resolveTxt } = await import("dns/promises");
    vi.mocked(resolveTxt).mockClear();

    const res = await request(app).get(`/api/platform/tenants/${tenant.id}/dominio`).set("Authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body.dominio.dominioEstado).toBe("pendiente_verificacion");
    expect(resolveTxt).not.toHaveBeenCalled();
  });
});
