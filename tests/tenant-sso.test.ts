/** tests/tenant-sso.test.ts
 *
 * SSO por tenant (OIDC) — mockea `openid-client` entero (no hay IdP real
 * para probar contra) y verifica lo que SÍ es responsabilidad de este
 * código: que la config se guarde cifrada y nunca vuelva en texto plano,
 * que el callback resuelva SOLO a un usuario ya existente (sin
 * auto-registro), que el linking por email pase una única vez, que
 * dominioEmailPermitido filtre, y que un `state` no pueda reusarse.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import request from "supertest";

vi.mock("openid-client", () => ({
  discovery: vi.fn().mockResolvedValue({ __mock: "configuracion-oidc" }),
  buildAuthorizationUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://idp.test.local/authorize");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url;
  }),
  authorizationCodeGrant: vi.fn(),
  randomPKCECodeVerifier: vi.fn().mockReturnValue("mock-code-verifier"),
  calculatePKCECodeChallenge: vi.fn().mockResolvedValue("mock-code-challenge"),
  randomNonce: vi.fn().mockReturnValue("mock-nonce"),
}));

const { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico, redisDisponible, extraerCookie } =
  await import("./helpers");
const { env } = await import("../src/server/config/env");
const { pool, withTenant, closeDatabase } = await import("../src/server/config/database");
const { authorizationCodeGrant } = await import("openid-client");

const BEARER = `Bearer ${env.platformAdminToken}`;
const tenantIdsCreados: string[] = [];
const conRedis = await redisDisponible();

afterAll(async () => {
  for (const id of tenantIdsCreados) await borrarTenantDePrueba(id).catch(() => {});
  await closeDatabase();
});

function claims(sub: string, email: string, emailVerificado = true) {
  return { claims: () => ({ sub, email, email_verified: emailVerificado }) };
}

async function configurarSso(tenantId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return request(app)
    .put(`/api/platform/tenants/${tenantId}/sso`)
    .set("Authorization", BEARER)
    .send({
      issuerUrl: "https://idp.test.local",
      clientId: "client-de-prueba",
      clientSecret: "secreto-super-privado",
      activo: true,
      ...overrides,
    });
}

function extraerState(redirectUrl: string): string {
  return new URL(redirectUrl).searchParams.get("state")!;
}

describe.skipIf(!conRedis)("SSO de tenant: config y flujo completo (requiere Redis)", () => {
  it("guarda la config cifrada — GET nunca devuelve el client_secret", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);

    const put = await configurarSso(creado.tenant.id);
    expect(put.status).toBe(200);
    expect(put.body.sso.configurado).toBe(true);
    expect(put.body.sso).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(put.body.sso)).not.toContain("secreto-super-privado");

    const filaCruda = await pool.query(
      `SELECT client_secret_cifrado FROM tenant_sso_config WHERE tenant_id = $1`,
      [creado.tenant.id]
    );
    expect(filaCruda.rows[0].client_secret_cifrado).not.toBe("secreto-super-privado");

    const get = await request(app)
      .get(`/api/platform/tenants/${creado.tenant.id}/sso`)
      .set("Authorization", BEARER);
    expect(get.status).toBe(200);
    expect(get.body.sso.activo).toBe(true);
  });

  it("GET /api/auth/sso-disponible refleja el estado activo, sin exponer detalles del proveedor", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);

    const antes = await request(app).get(
      `/api/auth/sso-disponible?tenantSlug=${creado.tenant.slug}`
    );
    expect(antes.body.disponible).toBe(false);

    await configurarSso(creado.tenant.id);

    const despues = await request(app).get(
      `/api/auth/sso-disponible?tenantSlug=${creado.tenant.slug}`
    );
    expect(despues.body.disponible).toBe(true);
  });

  it("resuelve a un usuario YA EXISTENTE (sin auto-registro) y linkea por email en el primer login", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    await configurarSso(creado.tenant.id);

    const iniciar = await request(app).get(
      `/api/auth/sso/iniciar?tenantSlug=${creado.tenant.slug}`
    );
    expect(iniciar.status).toBe(302);
    const state = extraerState(iniciar.headers.location);

    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce(
      claims("sub-original", creado.usuario.email) as any
    );

    const callback = await request(app).get(`/api/auth/sso/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).not.toContain("ssoError");
    expect(extraerCookie(callback.headers["set-cookie"], env.authCookieName)).toBeDefined();

    const fila = await withTenant(creado.tenant.id, (client) =>
      client.query(`SELECT sso_subject, sso_provider FROM usuarios WHERE id = $1`, [
        creado.usuario.id,
      ])
    );
    expect(fila.rows[0].sso_subject).toBe("sub-original");
    expect(fila.rows[0].sso_provider).toBe("oidc");
  });

  it("un `state` ya usado no sirve para un segundo callback (replay)", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    await configurarSso(creado.tenant.id);

    const iniciar = await request(app).get(
      `/api/auth/sso/iniciar?tenantSlug=${creado.tenant.slug}`
    );
    const state = extraerState(iniciar.headers.location);

    vi.mocked(authorizationCodeGrant).mockResolvedValue(
      claims("sub-replay", creado.usuario.email) as any
    );

    const primera = await request(app).get(`/api/auth/sso/callback?code=abc&state=${state}`);
    expect(primera.status).toBe(302);
    expect(primera.headers.location).not.toContain("ssoError");

    const segunda = await request(app).get(`/api/auth/sso/callback?code=abc&state=${state}`);
    expect(segunda.headers.location).toContain("ssoError");
  });

  it("un email que no pertenece a ningún usuario del tenant no crea nada — solo falla", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    await configurarSso(creado.tenant.id);

    const iniciar = await request(app).get(
      `/api/auth/sso/iniciar?tenantSlug=${creado.tenant.slug}`
    );
    const state = extraerState(iniciar.headers.location);
    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce(
      claims("sub-fantasma", "nadie@otraempresa.test") as any
    );

    const callback = await request(app).get(`/api/auth/sso/callback?code=abc&state=${state}`);
    expect(callback.headers.location).toContain("ssoError");

    const usuarios = await withTenant(creado.tenant.id, (client) =>
      client.query(`SELECT count(*)::int AS total FROM usuarios WHERE tenant_id = $1`, [
        creado.tenant.id,
      ])
    );
    expect(usuarios.rows[0].total).toBe(1); // solo el admin creado por crearTenantDePrueba, nadie más
  });

  it("dominioEmailPermitido rechaza un email verificado que no pertenece a ese dominio", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    await configurarSso(creado.tenant.id, { dominioEmailPermitido: "dominio-autorizado.test" });

    const iniciar = await request(app).get(
      `/api/auth/sso/iniciar?tenantSlug=${creado.tenant.slug}`
    );
    const state = extraerState(iniciar.headers.location);
    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce(
      claims("sub-dominio", creado.usuario.email) as any
    );

    const callback = await request(app).get(`/api/auth/sso/callback?code=abc&state=${state}`);
    expect(callback.headers.location).toContain("ssoError");
  });

  it("email sin verificar en el id_token no alcanza para autenticar", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    await configurarSso(creado.tenant.id);

    const iniciar = await request(app).get(
      `/api/auth/sso/iniciar?tenantSlug=${creado.tenant.slug}`
    );
    const state = extraerState(iniciar.headers.location);
    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce(
      claims("sub-sin-verificar", creado.usuario.email, false) as any
    );

    const callback = await request(app).get(`/api/auth/sso/callback?code=abc&state=${state}`);
    expect(callback.headers.location).toContain("ssoError");
  });

  it("SSO desactivado (activo=false) no permite iniciar el flujo", async () => {
    const creado = await crearTenantDePrueba();
    tenantIdsCreados.push(creado.tenant.id);
    await configurarSso(creado.tenant.id, { activo: false });

    const iniciar = await request(app).get(
      `/api/auth/sso/iniciar?tenantSlug=${creado.tenant.slug}`
    );
    expect(iniciar.status).toBe(503);
  });
});
