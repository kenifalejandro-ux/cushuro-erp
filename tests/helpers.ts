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
import { getRedis } from "../src/server/config/redis";

export const app = createApp();

export function idUnico(prefijo: string) {
  return `${prefijo}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/** ioredis usa lazyConnect — getRedis() puede devolver null todavía un
 *  instante después de que el proceso arrancó, aunque termine habiendo
 *  Redis, mientras la conexión inicial no terminó. Se espera un toque.
 *  Compartido entre archivos de test que necesitan saber si corren con
 *  Redis real (ver tests/global-setup.redis.ts) para activar/saltear
 *  bloques enteros de tests que lo requieren. */
export async function redisDisponible(): Promise<boolean> {
  if (!env.redisHost && !env.redisUrl) return false;
  for (let intento = 0; intento < 20; intento++) {
    if (getRedis()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Saca el valor crudo de una cookie de un array de headers Set-Cookie —
 *  para simular en un test que alguien reusa un refresh token viejo desde
 *  otro cliente, sin depender de la jar interna de supertest. */
export function extraerCookie(
  setCookieHeader: string | string[] | undefined,
  nombre: string
): string | undefined {
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

export async function crearTenantDePrueba(
  adminPassword = "ClaveDePrueba123"
): Promise<TenantDePrueba> {
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
 *  tests pueden correr en paralelo sin bajar la guardia de RLS para nadie.
 *  `usuarios` entra en esta misma transacción desde que tiene RLS (ver
 *  migrations/0010_usuarios_rls.sql) — antes se borraba aparte, sin
 *  necesitarlo.
 *
 *  ── El SELECT ... FOR UPDATE del principio ──────────────────────────────
 *
 *  tenant_modulos no tiene ON DELETE CASCADE desde tenants (a propósito:
 *  ver la migración 0008), así que hay que borrarlo ANTES que la fila
 *  padre. Sin el lock de acá, entre ese DELETE y el DELETE FROM tenants
 *  final queda una ventana donde otra transacción puede insertar un
 *  tenant_modulos nuevo para este mismo tenant — el caso real es un
 *  restore de plataforma reinsertando desde un backup viejo (ver
 *  platformBackupPlataforma.service.ts) — y el DELETE FROM tenants revienta
 *  con FK violation. Se encontró por un test intermitente en la suite
 *  completa, nunca aislado.
 *
 *  Tomar el lock FOR UPDATE sobre la fila de `tenants` como PRIMER paso
 *  cierra la ventana: cualquier INSERT concurrente que referencie este
 *  tenant necesita, para pasar su propio chequeo de FK, un lock FOR KEY
 *  SHARE sobre esa misma fila — que queda bloqueado hasta que esta
 *  transacción termine. Si de todos modos alcanza a colarse ANTES de que
 *  el lock se tome (o si gana la carrera y se ejecuta primero), el
 *  restore de plataforma ya lo tolera solo (ver el SAVEPOINT por fila en
 *  restaurarTablasPlataforma) — así que cualquiera de los dos órdenes
 *  termina en un estado consistente. */
export async function borrarTenantDePrueba(tenantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
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
    // refresh_tokens/usuario_modulos se borran solos (ON DELETE CASCADE
    // desde usuarios) — borrar usuarios alcanza.
    await client.query("DELETE FROM usuarios WHERE tenant_id = $1", [tenantId]);
    // tenants/tenant_modulos no tienen RLS, pero entran en esta misma
    // transacción igual: es lo que hace que el lock de arriba proteja
    // hasta el final, no solo hasta el COMMIT de un bloque separado.
    await client.query("DELETE FROM tenant_modulos WHERE tenant_id = $1", [tenantId]);
    // facturas/cobros (migración 0041) NO tienen ON DELETE CASCADE a
    // propósito -- son registro contable, no deben desaparecer solos si
    // alguna vez se borra un tenant real. En tests sí hay que limpiarlos a
    // mano, o el DELETE de tenants de abajo falla por FK. facturas antes
    // que cobros: factura.cobro_id referencia a cobros sin CASCADE tampoco.
    // suscripciones/metodos_pago sí tienen CASCADE, se limpian solas.
    await client.query("DELETE FROM facturas WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM cobros WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
