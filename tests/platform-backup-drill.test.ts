/** tests/platform-backup-drill.test.ts
 *
 * Restore drill básico (platformBackupDrill.worker.ts): valida que el
 * backup más reciente de cada tenant, y el más reciente de plataforma,
 * se puedan leer y que sus filas coincidan con el manifiesto guardado en
 * tenant_backups.tablas / platform_backups.tablas. Nunca restaura de
 * verdad — ver el comentario del archivo sobre por qué.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";
import { correrRestoreDrill } from "../src/server/services/platformBackupDrill.worker";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

async function cargarUnEquipo(tenantId: string) {
  await withTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Camioneta')`,
      [tenantId, idUnico("EQ")]
    )
  );
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("correrRestoreDrill", () => {
  it("un backup íntegro pasa la verificación sin discrepancias", async () => {
    const { tenant } = await nuevoTenant();
    await cargarUnEquipo(tenant.id);
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);
    expect(creado.status).toBe(201);

    const resumen = await correrRestoreDrill();
    const propio = resumen.tenants.find((r) => r.backupId === creado.body.backup.id);
    expect(propio).toMatchObject({ ok: true, discrepancias: [] });
  });

  it("detecta cuando el manifiesto no coincide con el contenido real del archivo", async () => {
    const { tenant } = await nuevoTenant();
    await cargarUnEquipo(tenant.id);
    const creado = await request(app)
      .post(`/api/platform/tenants/${tenant.id}/backups`)
      .set("Authorization", BEARER);

    // Desalinea el manifiesto a mano — es la señal exacta que este chequeo
    // existe para detectar (un backup que dice tener más o menos filas de
    // las que el archivo realmente tiene).
    await pool.query(
      `UPDATE tenant_backups SET tablas = jsonb_set(tablas, '{equipos}', '999') WHERE id = $1`,
      [creado.body.backup.id]
    );

    const resumen = await correrRestoreDrill();
    const propio = resumen.tenants.find((r) => r.backupId === creado.body.backup.id);
    expect(propio?.ok).toBe(false);
    expect(propio?.discrepancias).toContain("equipos");
  });

  it("un backup cuyo objeto ya no existe en storage se marca con error, sin tumbar el resto del drill", async () => {
    const { tenant: tenantFantasma } = await nuevoTenant();
    const { tenant: tenantSano } = await nuevoTenant();
    await cargarUnEquipo(tenantSano.id);

    const fantasma = await request(app)
      .post(`/api/platform/tenants/${tenantFantasma.id}/backups`)
      .set("Authorization", BEARER);
    const sano = await request(app)
      .post(`/api/platform/tenants/${tenantSano.id}/backups`)
      .set("Authorization", BEARER);

    await pool.query(`UPDATE tenant_backups SET storage_key = $2 WHERE id = $1`, [
      fantasma.body.backup.id,
      "backups/tenants/fantasma/no-existe.json",
    ]);

    const resumen = await correrRestoreDrill();

    const propioFantasma = resumen.tenants.find((r) => r.backupId === fantasma.body.backup.id);
    expect(propioFantasma?.ok).toBe(false);
    expect(propioFantasma?.error).toBeTruthy();

    // El del tenant sano se verifica igual — un backup roto no contamina
    // el chequeo de los demás.
    const propioSano = resumen.tenants.find((r) => r.backupId === sano.body.backup.id);
    expect(propioSano).toMatchObject({ ok: true, discrepancias: [] });
  });

  it("también verifica el backup de plataforma más reciente", async () => {
    const backup = await request(app)
      .post("/api/platform/backups/plataforma")
      .set("Authorization", BEARER);
    expect(backup.status).toBe(201);

    const resumen = await correrRestoreDrill();
    expect(resumen.plataforma).not.toBeNull();

    // platform_backups es un recurso GLOBAL, sin scoping por tenant: si
    // otro archivo de test (platform-backup.test.ts, platform-backup-s3.
    // test.ts) crea un backup de plataforma más nuevo justo después del
    // nuestro, el drill evalúa ESE — correrRestoreDrill() solo mira el más
    // reciente, por diseño. Mismo criterio que ya documenta
    // platform-backup.test.ts: no afirmar sobre estado global compartido
    // entre archivos que corren en paralelo, solo sobre lo propio.
    if (resumen.plataforma && resumen.plataforma.backupId === backup.body.backup.id) {
      expect(resumen.plataforma.ok).toBe(true);
    }
  });
});
