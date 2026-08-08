/** tests/scim.test.ts
 *
 * SCIM 2.0 mínimo (routes/scim.ts) — provisioning por tenant, autenticado
 * con un bearer token propio (nunca el JWT de un usuario ni el secreto de
 * plataforma). Verifica: auth por token (y su rotación/revocación), las
 * cuatro operaciones mínimas (crear/listar/desactivar/reactivar/borrar =
 * desactivar), y que cada una quede auditada con actor_type='scim'.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, withTenant, closeDatabase } from "../src/server/config/database";

const BEARER = `Bearer ${env.platformAdminToken}`;
const tenantIdsCreados: string[] = [];

afterAll(async () => {
  for (const id of tenantIdsCreados) await borrarTenantDePrueba(id).catch(() => {});
  await closeDatabase();
});

async function generarToken(tenantId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/platform/tenants/${tenantId}/scim/token`)
    .set("Authorization", BEARER);
  expect(res.status).toBe(200);
  return res.body.token;
}

describe("SCIM: autenticación por token de tenant", () => {
  it("sin bearer token: 401 en formato de error SCIM", async () => {
    const res = await request(app).get("/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(res.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
  });

  it("con un token inválido: 401", async () => {
    const res = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", "Bearer token-que-no-existe");
    expect(res.status).toBe(401);
  });

  it("el token vuelve en texto plano UNA sola vez — la fila en base solo tiene el hash", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);

    const token = await generarToken(creado.tenant.id);
    expect(token.length).toBeGreaterThan(20);

    const fila = await pool.query(
      `SELECT token_hash FROM tenant_scim_config WHERE tenant_id = $1`,
      [creado.tenant.id]
    );
    expect(fila.rows[0].token_hash).not.toBe(token);
  });

  it("revocar el token invalida requests futuras; rotar invalida el anterior", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    const token = await generarToken(creado.tenant.id);

    const antesDeRevocar = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`);
    expect(antesDeRevocar.status).toBe(200);

    await request(app)
      .delete(`/api/platform/tenants/${creado.tenant.id}/scim/token`)
      .set("Authorization", BEARER);

    const despuesDeRevocar = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`);
    expect(despuesDeRevocar.status).toBe(401);

    const tokenNuevo = await generarToken(creado.tenant.id);
    const conTokenViejo = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`);
    expect(conTokenViejo.status).toBe(401);
    const conTokenNuevo = await request(app)
      .get("/scim/v2/Users")
      .set("Authorization", `Bearer ${tokenNuevo}`);
    expect(conTokenNuevo.status).toBe(200);
  });
});

describe("SCIM: provisioning de usuarios", () => {
  it("crea un usuario, lo lista, lo filtra por userName y queda auditado como actor_type='scim'", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    const token = await generarToken(creado.tenant.id);
    const email = `${idUnico("scim-user")}@empresa-cliente.test`;

    const post = await request(app)
      .post("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`)
      .send({ userName: email, name: { givenName: "Nombre", familyName: "Apellido" } });
    expect(post.status).toBe(201);
    expect(post.body.userName).toBe(email);
    expect(post.body.active).toBe(true);
    const userId = post.body.id;

    const getPorId = await request(app)
      .get(`/scim/v2/Users/${userId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getPorId.status).toBe(200);
    expect(getPorId.body.name.formatted).toBe("Nombre Apellido");

    const filtro = `filter=${encodeURIComponent(`userName eq "${email}"`)}`;
    const getFiltrado = await request(app)
      .get(`/scim/v2/Users?${filtro}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getFiltrado.status).toBe(200);
    expect(getFiltrado.body.totalResults).toBe(1);
    expect(getFiltrado.body.Resources[0].id).toBe(userId);

    const auditoria = await pool.query(
      `SELECT actor_type FROM platform_audit_log WHERE tenant_id = $1 AND usuario_id = $2 AND accion = 'crear_usuario'`,
      [creado.tenant.id, userId]
    );
    expect(auditoria.rows[0].actor_type).toBe("scim");
  });

  it("PATCH con body plano {active:false} desactiva (soft-delete); active:true reactiva", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    const token = await generarToken(creado.tenant.id);

    const post = await request(app)
      .post("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`)
      .send({ userName: `${idUnico("scim-toggle")}@empresa-cliente.test` });
    const userId = post.body.id;

    const desactivar = await request(app)
      .patch(`/scim/v2/Users/${userId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ active: false });
    expect(desactivar.status).toBe(200);
    expect(desactivar.body.active).toBe(false);

    const reactivar = await request(app)
      .patch(`/scim/v2/Users/${userId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ active: true });
    expect(reactivar.status).toBe(200);
    expect(reactivar.body.active).toBe(true);
  });

  it("PATCH con el PatchOp estándar (Operations) también desactiva — lo que mandan Okta/Azure AD", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    const token = await generarToken(creado.tenant.id);

    const post = await request(app)
      .post("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`)
      .send({ userName: `${idUnico("scim-patchop")}@empresa-cliente.test` });
    const userId = post.body.id;

    const patch = await request(app)
      .patch(`/scim/v2/Users/${userId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });
    expect(patch.status).toBe(200);
    expect(patch.body.active).toBe(false);
  });

  it("DELETE desactiva (soft-delete) en vez de borrar la fila", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    const token = await generarToken(creado.tenant.id);

    const post = await request(app)
      .post("/scim/v2/Users")
      .set("Authorization", `Bearer ${token}`)
      .send({ userName: `${idUnico("scim-delete")}@empresa-cliente.test` });
    const userId = post.body.id;

    const del = await request(app)
      .delete(`/scim/v2/Users/${userId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const fila = await withTenant(creado.tenant.id, (client) =>
      client.query(`SELECT activo FROM usuarios WHERE id = $1`, [userId])
    );
    expect(fila.rows).toHaveLength(1); // sigue existiendo — nunca se borra
    expect(fila.rows[0].activo).toBe(false);
  });

  it("un token de un tenant no puede tocar usuarios de otro tenant", async () => {
    const tenantA = await crearTenantDePrueba();
    const tenantB = await crearTenantDePrueba();
    tenantIdsCreados.push(tenantA.tenant.id, tenantB.tenant.id);

    const tokenA = await generarToken(tenantA.tenant.id);

    const getUsuarioDeB = await request(app)
      .get(`/scim/v2/Users/${tenantB.usuario.id}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(getUsuarioDeB.status).toBe(404);
  });
});
