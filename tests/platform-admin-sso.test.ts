/** tests/platform-admin-sso.test.ts
 *
 * SSO de Platform Admin — un solo proveedor OIDC global (config en env,
 * ver PLATFORM_SSO_* / platformAdminSso.service.ts), a diferencia del SSO
 * por tenant (tests/tenant-sso.test.ts) que se configura por empresa. Sin
 * esas tres env vars seteadas, el endpoint responde 503 — se mockean acá
 * para probar el flujo real sin depender de un IdP de verdad.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import request from "supertest";

vi.mock("../src/server/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      platformSsoIssuerUrl: "https://idp-admin.test.local",
      platformSsoClientId: "admin-client-de-prueba",
      platformSsoClientSecret: "admin-secreto-de-prueba",
    },
  };
});

vi.mock("openid-client", () => ({
  discovery: vi.fn().mockResolvedValue({ __mock: "configuracion-oidc-admin" }),
  buildAuthorizationUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    const url = new URL("https://idp-admin.test.local/authorize");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url;
  }),
  authorizationCodeGrant: vi.fn(),
  randomPKCECodeVerifier: vi.fn().mockReturnValue("mock-code-verifier"),
  calculatePKCECodeChallenge: vi.fn().mockResolvedValue("mock-code-challenge"),
  randomNonce: vi.fn().mockReturnValue("mock-nonce"),
}));

const { app, idUnico, redisDisponible, extraerCookie } = await import("./helpers");
const { env } = await import("../src/server/config/env");
const { pool, closeDatabase } = await import("../src/server/config/database");
const { authorizationCodeGrant } = await import("openid-client");

const BEARER = `Bearer ${env.platformAdminToken}`;
const conRedis = await redisDisponible();
const adminIdsCreados: string[] = [];

afterAll(async () => {
  if (adminIdsCreados.length > 0) {
    await pool.query(`DELETE FROM platform_admins WHERE id = ANY($1)`, [adminIdsCreados]);
  }
  await closeDatabase();
});

function claims(sub: string, email: string, emailVerificado = true) {
  return { claims: () => ({ sub, email, email_verified: emailVerificado }) };
}

function extraerState(redirectUrl: string): string {
  return new URL(redirectUrl).searchParams.get("state")!;
}

async function crearAdminDePrueba() {
  const email = `${idUnico("admin-sso")}@test.local`;
  const res = await request(app).post("/api/platform/admins").set("Authorization", BEARER).send({
    email,
    password: "ClaveDePrueba123",
    nombre: "Admin SSO de prueba",
    rol: "admin",
  });
  expect(res.status).toBe(201);
  adminIdsCreados.push(res.body.admin.id);
  return res.body.admin as { id: string; email: string };
}

describe("SSO de Platform Admin (proveedor único global)", () => {
  it("GET /sso/disponible es true una vez configurado por env", async () => {
    const res = await request(app).get("/api/platform/sso/disponible");
    expect(res.body.disponible).toBe(true);
  });

  it.skipIf(!conRedis)("resuelve a un admin YA EXISTENTE, linkea por email, y crea una sesión real", async () => {
    const admin = await crearAdminDePrueba();

    const iniciar = await request(app).get("/api/platform/sso/iniciar");
    expect(iniciar.status).toBe(302);
    const state = extraerState(iniciar.headers.location);

    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce(claims("sub-admin-1", admin.email) as any);

    const callback = await request(app).get(`/api/platform/sso/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).not.toContain("ssoError");
    const cookieValor = extraerCookie(callback.headers["set-cookie"], "platform_session");
    expect(cookieValor).toBeDefined();

    // La sesión recién creada debe autenticar como ese admin.
    const whoami = await request(app).get("/api/platform/whoami").set("Cookie", `platform_session=${cookieValor}`);
    expect(whoami.body.actorType).toBe("platform_admin");
    expect(whoami.body.actorLabel).toBe(admin.email);

    const fila = await pool.query(`SELECT sso_subject, sso_provider FROM platform_admins WHERE id = $1`, [admin.id]);
    expect(fila.rows[0].sso_subject).toBe("sub-admin-1");
  });

  it.skipIf(!conRedis)("un email que no corresponde a ningún admin falla sin crear nada", async () => {
    const iniciar = await request(app).get("/api/platform/sso/iniciar");
    const state = extraerState(iniciar.headers.location);
    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce(claims("sub-fantasma", "nadie@fantasma.test") as any);

    const callback = await request(app).get(`/api/platform/sso/callback?code=abc&state=${state}`);
    expect(callback.headers.location).toContain("ssoError");

    const fila = await pool.query(`SELECT id FROM platform_admins WHERE email = $1`, ["nadie@fantasma.test"]);
    expect(fila.rows).toHaveLength(0);
  });
});
