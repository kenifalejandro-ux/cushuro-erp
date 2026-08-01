/** tests/helpers.ts
 *
 * Contra Postgres real (mismo .env local que usa `npm run dev`) — mockear
 * pool.query no probaría nada sobre RLS, que es justo lo que estos tests
 * necesitan verificar de verdad.
 */
import request from "supertest";
import { createApp } from "../src/server/app";
import { pool } from "../src/server/config/database";
import { env } from "../src/server/config/env";

export const app = createApp();

export function idUnico(prefijo: string) {
  return `${prefijo}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** Saca el valor crudo de una cookie de un array de headers Set-Cookie —
 *  para simular en un test que alguien reusa un refresh token viejo desde
 *  otro cliente, sin depender de la jar interna de supertest. */
export function extraerCookie(setCookieHeader: string | string[] | undefined, nombre: string): string | undefined {
  if (!setCookieHeader) return undefined;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const match = header.match(new RegExp(`^${nombre}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

export interface TenantDePrueba {
  tenant: { id: string; nombre: string; slug: string };
  usuario: { id: string; tenantId: string; email: string };
}

export async function crearTenantDePrueba(adminPassword = "ClaveDePrueba123"): Promise<TenantDePrueba> {
  const slug = idUnico("test-tenant");
  const res = await request(app)
    .post("/api/platform/tenants")
    .set("Authorization", `Bearer ${env.platformAdminToken}`)
    .send({
      tenantNombre: `Tenant de prueba ${slug}`,
      tenantSlug: slug,
      adminNombre: "Admin de prueba",
      adminEmail: `${slug}@test.local`,
      adminPassword,
    });

  if (res.status !== 201) {
    throw new Error(`No se pudo crear tenant de prueba: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return res.body;
}

/** Borra todo lo creado por un tenant de prueba. Usa set_config igual que
 *  withTenant() de la app — nunca toca FORCE ROW LEVEL SECURITY, así los
 *  tests pueden correr en paralelo sin bajar la guardia de RLS para nadie. */
export async function borrarTenantDePrueba(tenantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("DELETE FROM repuestos WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM documentos WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM combustible WHERE tenant_id = $1", [tenantId]);
    // Orden importa: checklists/ipercs referencian equipos y
    // checklist_plantillas (sin CASCADE), así que van primero. Sus tablas
    // de items sí tienen ON DELETE CASCADE, se limpian solas.
    await client.query("DELETE FROM checklists WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM checklist_plantillas WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM ipercs WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM iperc_lineas_base WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM equipos WHERE tenant_id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // usuarios/tenants no tienen RLS (ver plan de RLS: usuarios queda fuera
  // hasta rediseñar el login), se borran directo.
  await pool.query(
    "DELETE FROM refresh_tokens WHERE usuario_id IN (SELECT id FROM usuarios WHERE tenant_id = $1)",
    [tenantId]
  );
  await pool.query("DELETE FROM usuarios WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}
