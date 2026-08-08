import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { env } from "../src/server/config/env";
import { invalidateCachedTokenVersion } from "../src/server/shared/utils/token-version-cache";
import { closeDatabase } from "../src/server/config/database";

function cambiarEstadoTenant(tenantId: string, activo: boolean) {
  return request(app)
    .patch(`/api/platform/tenants/${tenantId}/estado`)
    .set("Authorization", `Bearer ${env.platformAdminToken}`)
    .send({ activo });
}

describe("tenant desactivado pierde acceso de verdad", () => {
  let tenantId: string;

  afterAll(async () => {
    if (tenantId) await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("desactivar el tenant bloquea logins nuevos y corta las sesiones ya abiertas", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;

    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    expect(login.status).toBe(200);

    const meAntes = await agent.get("/api/auth/me");
    expect(meAntes.status).toBe(200);

    const desactivar = await cambiarEstadoTenant(tenantId, false);
    expect(desactivar.status).toBe(200);
    expect(desactivar.body.tenant.id).toBe(tenantId);

    // Simula que venció el cache de 60s de token_version (ver
    // token-version-cache.ts) sin esperar de verdad — fuerza que
    // authMiddleware vuelva a consultar la BD, donde ahora encuentra el
    // tenant desactivado.
    await invalidateCachedTokenVersion(creado.usuario.id);

    const meDespues = await agent.get("/api/auth/me");
    expect(meDespues.status).toBe(401);

    const loginTrasDesactivar = await request(app)
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
    expect(loginTrasDesactivar.status).toBe(401);

    // Reactivar para dejar todo limpio antes de que afterAll borre el tenant.
    const reactivar = await cambiarEstadoTenant(tenantId, true);
    expect(reactivar.status).toBe(200);
  });
});
