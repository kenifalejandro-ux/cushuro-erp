/** tests/tenant-onboarding.test.ts
 *
 * Onboarding automatizado (docs/architecture/onboarding-automatizado.md):
 * POST /api/platform/tenants/onboard + tenantOnboardingService.ts. Cubre
 * lo que agrega sobre el POST /tenants ya existente (que sigue probado en
 * platform-domain.test.ts / tenant-*.test.ts): asignación de plan en la
 * misma transacción, atomicidad si el plan no es válido, y el gate de
 * super-admin (más estricto que /tenants).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, idUnico, redisDisponible } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase } from "../src/server/config/database";
import { crearPlatformAdminService } from "../src/server/services/platformAdminAccount.service";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const conRedis = await redisDisponible();

const tenantsCreados: string[] = [];
const planesCreados: string[] = [];
const adminsCreados: string[] = [];

function inputOnboarding(overrides: Partial<Record<string, unknown>> = {}) {
  const slug = idUnico("onboard");
  return {
    tenantNombre: `Tenant onboarding ${slug}`,
    tenantSlug: slug,
    adminNombre: "Admin de prueba",
    adminEmail: `${slug}@test.local`,
    adminPassword: password,
    ...overrides,
  };
}

afterAll(async () => {
  for (const id of tenantsCreados) {
    await pool.query(`DELETE FROM tenant_modulos WHERE tenant_id = $1`, [id]);
    // usuarios tiene RLS — set_config directo alcanza para este cleanup
    // puntual (mismo patrón que borrarTenantDePrueba de helpers.ts).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await client.query(`DELETE FROM usuarios WHERE tenant_id = $1`, [id]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
    } finally {
      client.release();
    }
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  }
  for (const codigo of planesCreados) {
    await pool.query(`DELETE FROM planes WHERE codigo = $1`, [codigo]);
  }
  for (const email of adminsCreados) {
    await pool.query(`DELETE FROM platform_admins WHERE email = $1`, [email]);
  }
  await closeDatabase();
});

describe("POST /api/platform/tenants/onboard", () => {
  it("crea tenant + admin + módulos habilitados + plan, todo en un solo paso (201)", async () => {
    const res = await request(app)
      .post("/api/platform/tenants/onboard")
      .set("Authorization", BEARER)
      .send(inputOnboarding({ planCodigo: "mype" }));

    expect(res.status).toBe(201);
    expect(res.body.tenant.planCodigo).toBe("mype");
    expect(res.body.usuario.rol).toBe("admin");
    expect(res.body.usuario.modulosPermitidos.length).toBeGreaterThan(0);
    tenantsCreados.push(res.body.tenant.id);

    const fila = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [
      res.body.tenant.id,
    ]);
    expect(fila.rows[0].plan_id).not.toBeNull();
  });

  it("sin planCodigo, sigue funcionando igual que /tenants (plan_id queda NULL)", async () => {
    const res = await request(app)
      .post("/api/platform/tenants/onboard")
      .set("Authorization", BEARER)
      .send(inputOnboarding());

    expect(res.status).toBe(201);
    expect(res.body.tenant.planCodigo).toBeNull();
    tenantsCreados.push(res.body.tenant.id);

    const fila = await pool.query(`SELECT plan_id FROM tenants WHERE id = $1`, [
      res.body.tenant.id,
    ]);
    expect(fila.rows[0].plan_id).toBeNull();
  });

  it("planCodigo inexistente: 404, y el tenant NO queda creado (atomicidad real, no orquestación de dos pasos)", async () => {
    const input = inputOnboarding({ planCodigo: "plan-que-no-existe-123" });
    const res = await request(app)
      .post("/api/platform/tenants/onboard")
      .set("Authorization", BEARER)
      .send(input);

    expect(res.status).toBe(404);

    const fila = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [input.tenantSlug]);
    expect(fila.rows).toHaveLength(0);
  });

  it("plan desactivado: 400, y el tenant tampoco queda creado", async () => {
    const codigoPlan = idUnico("plan-inactivo");
    planesCreados.push(codigoPlan);
    await pool.query(
      `INSERT INTO planes (codigo, nombre, activo) VALUES ($1, 'Plan inactivo de prueba', false)`,
      [codigoPlan]
    );

    const input = inputOnboarding({ planCodigo: codigoPlan });
    const res = await request(app)
      .post("/api/platform/tenants/onboard")
      .set("Authorization", BEARER)
      .send(input);

    expect(res.status).toBe(400);

    const fila = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [input.tenantSlug]);
    expect(fila.rows).toHaveLength(0);
  });

  it("Idempotency-Key repetida devuelve la misma respuesta sin crear un segundo tenant", async () => {
    const input = inputOnboarding();
    const idempotencyKey = idUnico("idem-onboard");

    const primera = await request(app)
      .post("/api/platform/tenants/onboard")
      .set("Authorization", BEARER)
      .set("Idempotency-Key", idempotencyKey)
      .send(input);
    expect(primera.status).toBe(201);
    tenantsCreados.push(primera.body.tenant.id);

    const segunda = await request(app)
      .post("/api/platform/tenants/onboard")
      .set("Authorization", BEARER)
      .set("Idempotency-Key", idempotencyKey)
      .send(input);
    expect(segunda.status).toBe(201);
    expect(segunda.body.tenant.id).toBe(primera.body.tenant.id);

    const filas = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [input.tenantSlug]);
    expect(filas.rows).toHaveLength(1);
  });

  it("sin autenticación: 401 (mismo gate base que el resto de /api/platform)", async () => {
    const res = await request(app).post("/api/platform/tenants/onboard").send(inputOnboarding());
    expect(res.status).toBe(401);
  });

  describe.skipIf(!conRedis)(
    "gate de super-admin (necesita sesión individual, requiere Redis)",
    () => {
      it("un platform admin normal (no super_admin) recibe 403 en /onboard, pero SÍ puede seguir usando /tenants", async () => {
        const email = `${idUnico("admin-normal")}@platform-admin-test.local`.toLowerCase();
        adminsCreados.push(email);
        await crearPlatformAdminService({ email, password, nombre: "Admin normal", rol: "admin" });

        const agent = request.agent(app);
        const login = await agent.post("/api/platform/admin-sesion").send({ email, password });
        expect(login.status).toBe(200);

        const onboard = await agent.post("/api/platform/tenants/onboard").send(inputOnboarding());
        expect(onboard.status).toBe(403);

        const simple = await agent.post("/api/platform/tenants").send(inputOnboarding());
        expect(simple.status).toBe(201);
        tenantsCreados.push(simple.body.tenant.id);
      });
    }
  );
});
