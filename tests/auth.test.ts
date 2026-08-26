import { createHash } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, extraerCookie } from "./helpers";
import { closeDatabase, pool, withTenant } from "../src/server/config/database";
import { env } from "../src/server/config/env";

// Mismo algoritmo que hashRefreshToken en auth.service.ts (no exportada) --
// se replica acá solo para poder insertar un reset_tokens de prueba con un
// token en texto plano conocido, sin pasar por el flujo real de correo.
function hashTokenDePrueba(tokenPlano: string): string {
  return createHash("sha256").update(tokenPlano).digest("hex");
}

describe("auth", () => {
  let tenantId: string;
  let tenantSlug: string;
  let usuarioId: string;
  let email: string;
  const password = "ClaveDePrueba123";

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    usuarioId = creado.usuario.id;
    email = creado.usuario.email;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
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

  it("un usuario puede tener dos sesiones activas a la vez -- loguearse en una no cierra la otra", async () => {
    const agenteCelular = request.agent(app);
    const agentePc = request.agent(app);

    const loginCelular = await agenteCelular
      .post("/api/auth/login")
      .send({ tenantSlug, email, password });
    expect(loginCelular.status).toBe(200);
    expect((await agenteCelular.get("/api/auth/me")).status).toBe(200);

    // Segundo login del MISMO usuario, otro jar de cookies (otro
    // "dispositivo") -- antes de suavizar la sesión única, esto pisaba la
    // sesión del celular en Redis y la tumbaba.
    const loginPc = await agentePc.post("/api/auth/login").send({ tenantSlug, email, password });
    expect(loginPc.status).toBe(200);
    expect((await agentePc.get("/api/auth/me")).status).toBe(200);

    // La sesión del celular sigue viva después del login de la PC.
    expect((await agenteCelular.get("/api/auth/me")).status).toBe(200);
  });

  it("logout de una sesión no cierra las demás sesiones activas del mismo usuario", async () => {
    const agenteCelular = request.agent(app);
    const agentePc = request.agent(app);

    await agenteCelular.post("/api/auth/login").send({ tenantSlug, email, password });
    await agentePc.post("/api/auth/login").send({ tenantSlug, email, password });

    const logoutCelular = await agenteCelular.post("/api/auth/logout");
    expect(logoutCelular.status).toBe(200);

    expect((await agenteCelular.get("/api/auth/me")).status).toBe(401);
    // La PC nunca pidió logout -- su sesión sigue intacta.
    expect((await agentePc.get("/api/auth/me")).status).toBe(200);
  });

  it("desactivar el usuario desde plataforma sí cierra TODAS sus sesiones activas", async () => {
    const agenteCelular = request.agent(app);
    const agentePc = request.agent(app);

    await agenteCelular.post("/api/auth/login").send({ tenantSlug, email, password });
    await agentePc.post("/api/auth/login").send({ tenantSlug, email, password });

    try {
      const desactivar = await request(app)
        .patch(`/api/platform/tenants/${tenantId}/usuarios/${usuarioId}/estado`)
        .set("Authorization", `Bearer ${env.platformAdminToken}`)
        .send({ activo: false });
      expect(desactivar.status).toBe(200);

      // revocarSesionesService() -- a diferencia de logoutService() -- tumba
      // TODAS las sesiones del usuario, no solo una.
      expect((await agenteCelular.get("/api/auth/me")).status).toBe(401);
      expect((await agentePc.get("/api/auth/me")).status).toBe(401);
    } finally {
      await request(app)
        .patch(`/api/platform/tenants/${tenantId}/usuarios/${usuarioId}/estado`)
        .set("Authorization", `Bearer ${env.platformAdminToken}`)
        .send({ activo: true });
    }
  });
});

describe("clave temporal + cambio obligatorio en el primer login (usuarios de tenant)", () => {
  let tenantId: string;
  let tenantSlug: string;
  let email: string;
  const passwordTemporal = "ClaveTemporal123";

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(passwordTemporal);
    tenantId = creado.tenant.id;
    tenantSlug = creado.tenant.slug;
    email = creado.usuario.email;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("un usuario recién creado trae debeCambiarPassword=true al loguearse", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug, email, password: passwordTemporal });
    expect(res.status).toBe(200);
    expect(res.body.usuario.debeCambiarPassword).toBe(true);
  });

  it("POST /mi-password con la clave actual correcta la cambia y apaga el flag", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ tenantSlug, email, password: passwordTemporal });

    const cambiar = await agent
      .post("/api/auth/mi-password")
      .send({ passwordActual: passwordTemporal, passwordNueva: "ClaveDefinitiva456" });
    expect(cambiar.status).toBe(200);

    // El access token vigente es de ANTES del cambio -- debeCambiarPassword
    // se arma en cada login/refresh desde una lectura fresca de la base, no
    // vive recalculado en el JWT ya firmado. Por eso /me todavía dice
    // `true`: es el mismo comportamiento ya aceptado para rol/
    // modulosPermitidos, y por lo que el frontend actualiza el usuario en
    // memoria en vez de volver a pedir /me (ver App.tsx).
    const meConTokenViejo = await agent.get("/api/auth/me");
    expect(meConTokenViejo.body.usuario.debeCambiarPassword).toBe(true);

    // Pero SÍ se refleja en el próximo refresh, que re-lee la base.
    const refresh = await agent.post("/api/auth/refresh");
    expect(refresh.status).toBe(200);
    expect(refresh.body.usuario.debeCambiarPassword).toBe(false);

    // La clave vieja ya no sirve; la nueva sí.
    const loginConVieja = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug, email, password: passwordTemporal });
    expect(loginConVieja.status).toBe(401);

    const loginConNueva = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug, email, password: "ClaveDefinitiva456" });
    expect(loginConNueva.status).toBe(200);
    expect(loginConNueva.body.usuario.debeCambiarPassword).toBe(false);
  });

  it("POST /mi-password con la clave actual incorrecta da 401 y no cambia nada", async () => {
    const otro = await crearTenantDePrueba(passwordTemporal);
    try {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({
        tenantSlug: otro.tenant.slug,
        email: otro.usuario.email,
        password: passwordTemporal,
      });

      const cambiar = await agent
        .post("/api/auth/mi-password")
        .send({ passwordActual: "otra-cosa", passwordNueva: "ClaveDefinitiva456" });
      expect(cambiar.status).toBe(401);

      // Nada cambió: la clave temporal original sigue sirviendo y el flag
      // sigue en true.
      const loginConTemporal = await request(app).post("/api/auth/login").send({
        tenantSlug: otro.tenant.slug,
        email: otro.usuario.email,
        password: passwordTemporal,
      });
      expect(loginConTemporal.status).toBe(200);
      expect(loginConTemporal.body.usuario.debeCambiarPassword).toBe(true);
    } finally {
      await borrarTenantDePrueba(otro.tenant.id);
    }
  });

  it("sin sesión, POST /mi-password rechaza con 401", async () => {
    const res = await request(app)
      .post("/api/auth/mi-password")
      .send({ passwordActual: "x", passwordNueva: "ClaveDefinitiva456" });
    expect(res.status).toBe(401);
  });
});

describe("restablecer contraseña vía link de recuperación (POST /reset-password)", () => {
  async function crearTokenDePrueba(
    usuarioId: string,
    tenantId: string,
    vencidoOUsado?: "vencido" | "usado"
  ) {
    const tokenPlano = `token-de-prueba-${Date.now()}-${Math.random()}`;
    const expiraEn =
      vencidoOUsado === "vencido" ? new Date(Date.now() - 1000) : new Date(Date.now() + 3600_000);
    const usadoEn = vencidoOUsado === "usado" ? new Date() : null;
    await pool.query(
      `INSERT INTO reset_tokens (usuario_id, tenant_id, token_hash, expira_en, usado_en)
       VALUES ($1, $2, $3, $4, $5)`,
      [usuarioId, tenantId, hashTokenDePrueba(tokenPlano), expiraEn, usadoEn]
    );
    return tokenPlano;
  }

  it("con un token válido cambia la contraseña, marca el token usado y revoca las sesiones", async () => {
    const passwordOriginal = "ClaveOriginal123";
    const creado = await crearTenantDePrueba(passwordOriginal);
    try {
      const { tenant, usuario } = creado;

      const sesionPrevia = request.agent(app);
      const loginPrevio = await sesionPrevia
        .post("/api/auth/login")
        .send({ tenantSlug: tenant.slug, email: usuario.email, password: passwordOriginal });
      expect(loginPrevio.status).toBe(200);

      const token = await crearTokenDePrueba(usuario.id, tenant.id);
      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token, newPassword: "ClaveNueva456" });
      expect(res.status).toBe(200);

      // La sesión de antes del reset ya no sirve.
      expect((await sesionPrevia.get("/api/auth/me")).status).toBe(401);

      // La clave vieja ya no entra; la nueva sí.
      const loginConVieja = await request(app)
        .post("/api/auth/login")
        .send({ tenantSlug: tenant.slug, email: usuario.email, password: passwordOriginal });
      expect(loginConVieja.status).toBe(401);

      const loginConNueva = await request(app)
        .post("/api/auth/login")
        .send({ tenantSlug: tenant.slug, email: usuario.email, password: "ClaveNueva456" });
      expect(loginConNueva.status).toBe(200);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("un token ya usado, uno vencido, y uno inexistente se rechazan todos con 400", async () => {
    const creado = await crearTenantDePrueba("ClaveDePrueba123");
    try {
      const { tenant, usuario } = creado;

      const tokenUsado = await crearTokenDePrueba(usuario.id, tenant.id, "usado");
      const resUsado = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: tokenUsado, newPassword: "OtraClave789" });
      expect(resUsado.status).toBe(400);

      const tokenVencido = await crearTokenDePrueba(usuario.id, tenant.id, "vencido");
      const resVencido = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: tokenVencido, newPassword: "OtraClave789" });
      expect(resVencido.status).toBe(400);

      const resInexistente = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "token-que-nunca-existio", newPassword: "OtraClave789" });
      expect(resInexistente.status).toBe(400);

      // Ninguno de los tres cambió nada: la clave original sigue sirviendo.
      const loginOriginal = await request(app)
        .post("/api/auth/login")
        .send({ tenantSlug: tenant.slug, email: usuario.email, password: "ClaveDePrueba123" });
      expect(loginOriginal.status).toBe(200);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });
});

// Cierra el pool una sola vez, después de los describe de arriba -- antes
// vivía en el afterAll de "auth" porque era el único describe del archivo;
// con más de uno, cerrarlo ahí tumbaba el pool antes de que corriera el
// resto.
afterAll(async () => {
  await closeDatabase();
});
