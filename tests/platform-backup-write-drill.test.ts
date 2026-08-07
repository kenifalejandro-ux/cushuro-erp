/** tests/platform-backup-write-drill.test.ts
 *
 * Restore drill de escritura (platformBackupWriteDrill.worker.ts): a
 * diferencia del drill básico (platform-backup-drill.test.ts, solo
 * lectura), este SÍ inserta filas de verdad — sobre un tenant descartable,
 * dentro de una transacción que nunca comitea (siempreRollback en
 * runSiPrimero). `habilitado: true` explícito en cada llamada, igual que
 * platform-audit-retention.test.ts con `retentionDays`: no depender de
 * BACKUP_WRITE_DRILL_ENABLED (deshabilitado a propósito en el resto de la
 * suite).
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";
import { correrRestoreDrillEscritura } from "../src/server/services/platformBackupWriteDrill.worker";
import * as platformBackupService from "../src/server/services/platformBackup.service";

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
    client.query(`INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Camioneta')`, [
      tenantId,
      idUnico("EQ"),
    ])
  );
}

async function tenantExiste(tenantId: string): Promise<boolean> {
  const res = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  return res.rows.length > 0;
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("correrRestoreDrillEscritura", () => {
  it("deshabilitado (el default) no toca la base", async () => {
    const resultado = await correrRestoreDrillEscritura({ habilitado: false });
    expect(resultado).toBeNull();
  });

  it("con el backup más reciente completo, restaura sobre un tenant descartable, verifica, y no deja rastro", async () => {
    const { tenant } = await nuevoTenant();
    await cargarUnEquipo(tenant.id);
    const creado = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);
    expect(creado.status).toBe(201);

    const resultado = await correrRestoreDrillEscritura({ habilitado: true });

    expect(resultado).not.toBeNull();
    expect(resultado?.ok).toBe(true);
    expect(resultado?.discrepancias).toEqual([]);
    expect(resultado?.tenantDrillId).not.toBe(tenant.id);

    // La garantía central: pase lo que pase adentro, nada de lo que el
    // drill escribió sobrevive al ROLLBACK — ni el tenant descartable que
    // él mismo creó.
    expect(await tenantExiste(resultado!.tenantDrillId)).toBe(false);
  });

  it("un fallo a mitad del restore igual termina en rollback — no queda ningún rastro del tenant descartable", async () => {
    const { tenant } = await nuevoTenant();
    await cargarUnEquipo(tenant.id);
    const creado = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);
    expect(creado.status).toBe(201);

    const espia = vi
      .spyOn(platformBackupService, "restaurarTablas")
      .mockRejectedValueOnce(new Error("fallo forzado para el test"));

    const resultado = await correrRestoreDrillEscritura({ habilitado: true });

    espia.mockRestore();

    expect(resultado?.ok).toBe(false);
    expect(resultado?.error).toContain("fallo forzado");
    expect(await tenantExiste(resultado!.tenantDrillId)).toBe(false);
  });

  it("con al menos un backup completo en la base, siempre devuelve un resultado bien formado", async () => {
    // No forzamos "cero backups": esta suite corre en paralelo con otros
    // archivos que también crean backups de plataforma/tenant, así que no
    // hay forma de garantizar una base vacía sin pisar el trabajo de otro
    // archivo. Lo que sí podemos afirmar es que, habiendo al menos el
    // backup creado en el test anterior, la función nunca deja el tenant
    // descartable que ella misma crea.
    const resultado = await correrRestoreDrillEscritura({ habilitado: true });
    expect(resultado).not.toBeNull();
    if (resultado) {
      expect(await tenantExiste(resultado.tenantDrillId)).toBe(false);
    }
  });
});
