import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, extraerCookie } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";

describe("auth", () => {
  let tenantId: string;
  let tenantSlug: string;
  let email: string;
  const password = "ClaveDePrueba123";

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    email = creado.usuario.email;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("login con credenciales correctas devuelve 200 y cookies de sesión", async () => {
    const res = await request(app).post("/api/auth/login").send({ tenantSlug, email, password });
    expect(res.status).toBe(200);
    expect(res.body.usuario.email).toBe(email);
    expect(extraerCookie(res.headers["set-cookie"], "erp_token")).toBeDefined();
    expect(extraerCookie(res.headers["set-cookie"], "erp_token_refresh")).toBeDefined();
  });

  it("login con password incorrecto falla con 401 y mensaje genérico", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug, email, password: "incorrecta123" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Credenciales inválidas");
  });

  it("login con email inexistente falla con el MISMO mensaje genérico (anti-enumeración)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug, email: "no-existe@test.local", password });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Credenciales inválidas");
  });

  it("un usuario desactivado no puede loguear", async () => {
    // usuarios tiene RLS: hasta un UPDATE de test necesita pasar por
    // withTenant() con el tenantId correcto seteado en la transacción.
    await withTenant(tenantId, (client) =>
      client.query("UPDATE usuarios SET activo = false WHERE tenant_id = $1 AND email = $2", [
        tenantId,
        email,
      ])
    );
    try {
      const res = await request(app).post("/api/auth/login").send({ tenantSlug, email, password });
      expect(res.status).toBe(401);
    } finally {
      await withTenant(tenantId, (client) =>
        client.query("UPDATE usuarios SET activo = true WHERE tenant_id = $1 AND email = $2", [
          tenantId,
          email,
        ])
      );
    }
  });

  it("logout revoca la sesión: el mismo cookie ya no sirve para requests autenticados", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ tenantSlug, email, password });
    expect(login.status).toBe(200);

    const meAntes = await agent.get("/api/auth/me");
    expect(meAntes.status).toBe(200);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(200);

    const meDespues = await agent.get("/api/auth/me");
    expect(meDespues.status).toBe(401);
  });

  it("reusar un refresh token ya rotado tumba toda la sesión (detección de robo)", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ tenantSlug, email, password });
    const refreshViejo = extraerCookie(login.headers["set-cookie"], "erp_token_refresh");
    expect(refreshViejo).toBeDefined();

    // Uso normal: el agent ya trae el cookie, /refresh rota a uno nuevo.
    const refrescoOk = await agent.post("/api/auth/refresh");
    expect(refrescoOk.status).toBe(200);

    // Alguien más presenta el refresh token viejo (ya invalidado por la rotación de arriba).
    const reuso = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `erp_token_refresh=${refreshViejo}`);
    expect(reuso.status).toBe(401);

    // El token nuevo, válido hasta hace un instante, también debe estar muerto:
    // el reuso disparó la revocación de TODA la sesión, no solo del token viejo.
    const refrescoTrasReuso = await agent.post("/api/auth/refresh");
    expect(refrescoTrasReuso.status).toBe(401);
  });
});
