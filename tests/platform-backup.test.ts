/** tests/platform-backup.test.ts
 *
 * Backup y restore por tenant (migrations/0023_tenant_backups.sql,
 * platformBackup.service.ts). El caso central: exportar un tenant con
 * datos reales en varias tablas (incluidas las "hijas" de detalle) y
 * restaurarlo — sobre el mismo tenant (rollback / "punto de
 * restauración") y sobre un tenant vacío distinto (clonado).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { env } from "../src/server/config/env";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";

const BEARER = `Bearer ${env.platformAdminToken}`;
const password = "ClaveDePrueba123";
const tenantsCreados: string[] = [];

async function nuevoTenant() {
  const creado = await crearTenantDePrueba(password);
  tenantsCreados.push(creado.tenant.id);
  return creado;
}

/** Carga un equipo + una plantilla + un checklist con un ítem — toca una
 *  tabla "padre" (checklists) y una "hija" de detalle (checklist_items),
 *  justo el caso que tests/helpers.ts no necesita cubrir pero un backup sí. */
async function cargarDatosDePrueba(tenantId: string, usuarioId: string) {
  return withTenant(tenantId, async (client) => {
    const equipo = await client.query(
      `INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Camioneta') RETURNING id`,
      [tenantId, idUnico("EQ")]
    );
    const plantilla = await client.query(
      `INSERT INTO checklist_plantillas (tenant_id, nombre) VALUES ($1, 'Plantilla de prueba') RETURNING id`,
      [tenantId]
    );
    const checklist = await client.query(
      `INSERT INTO checklists (tenant_id, equipo_id, plantilla_id, usuario_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, equipo.rows[0].id, plantilla.rows[0].id, usuarioId]
    );
    await client.query(
      `INSERT INTO checklist_items (tenant_id, checklist_id, descripcion, estado) VALUES ($1, $2, 'Frenos', 'bien')`,
      [tenantId, checklist.rows[0].id]
    );
    return { equipoId: equipo.rows[0].id, checklistId: checklist.rows[0].id };
  });
}

afterAll(async () => {
  for (const id of tenantsCreados) await borrarTenantDePrueba(id);
  await closeDatabase();
});

describe("exportarTenantService / POST .../backups", () => {
  it("crea un backup con el resumen correcto de filas por tabla", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(tenant.id, usuario.id);

    const res = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);

    expect(res.status).toBe(201);
    expect(res.body.backup.tablas.usuarios).toBe(1);
    expect(res.body.backup.tablas.equipos).toBe(1);
    expect(res.body.backup.tablas.checklists).toBe(1);
    expect(res.body.backup.tablas.checklist_items).toBe(1);
    expect(res.body.backup.estado).toBe("completo");

    const auditoria = await pool.query(
      `SELECT resultado FROM platform_audit_log WHERE accion = 'crear_backup_tenant' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows[0].resultado).toBe("success");
  });

  it("GET .../backups lista los backups del tenant, más nuevo primero", async () => {
    const { tenant } = await nuevoTenant();
    const primero = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);
    const segundo = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);

    const res = await request(app).get(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);
    expect(res.status).toBe(200);
    expect(res.body.backups.length).toBeGreaterThanOrEqual(2);
    expect(res.body.backups[0].id).toBe(segundo.body.backup.id);
    expect(res.body.backups.some((b: any) => b.id === primero.body.backup.id)).toBe(true);
  });
});

describe("restaurarBackupService / POST /backups/:id/restaurar", () => {
  it("restaura sobre el MISMO tenant (punto de restauración): borra lo agregado después del backup", async () => {
    const { tenant, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(tenant.id, usuario.id);

    const backup = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);
    expect(backup.status).toBe(201);

    // Datos agregados DESPUÉS del backup — el restore tiene que borrarlos.
    await withTenant(tenant.id, (client) =>
      client.query(`INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Otro')`, [
        tenant.id,
        idUnico("EQ-POST-BACKUP"),
      ])
    );
    const antesDeRestaurar = await withTenant(tenant.id, (client) =>
      client.query(`SELECT count(*) AS total FROM equipos WHERE tenant_id = $1`, [tenant.id])
    );
    expect(Number(antesDeRestaurar.rows[0].total)).toBe(2);

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    expect(restaurar.status).toBe(200);
    expect(restaurar.body.tablasRestauradas.equipos).toBe(1);
    expect(restaurar.body.tablasRestauradas.checklists).toBe(1);
    expect(restaurar.body.tablasRestauradas.checklist_items).toBe(1);

    const despuesDeRestaurar = await withTenant(tenant.id, (client) =>
      client.query(`SELECT count(*) AS total FROM equipos WHERE tenant_id = $1`, [tenant.id])
    );
    expect(Number(despuesDeRestaurar.rows[0].total)).toBe(1); // el "post-backup" ya no está

    const itemsRestaurados = await withTenant(tenant.id, (client) =>
      client.query(`SELECT descripcion FROM checklist_items WHERE tenant_id = $1`, [tenant.id])
    );
    expect(itemsRestaurados.rows).toHaveLength(1);
    expect(itemsRestaurados.rows[0].descripcion).toBe("Frenos");
  });

  it("restaurar bumpea token_version de los usuarios restaurados (invalida sesiones viejas)", async () => {
    const { tenant, usuario } = await nuevoTenant();
    const antes = await withTenant(tenant.id, (client) =>
      client.query(`SELECT token_version FROM usuarios WHERE id = $1`, [usuario.id])
    );

    const backup = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);
    await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    const despues = await withTenant(tenant.id, (client) =>
      client.query(`SELECT token_version FROM usuarios WHERE id = $1`, [usuario.id])
    );
    expect(despues.rows[0].token_version).toBeGreaterThan(antes.rows[0].token_version);
  });

  it("restaura en un tenant DISTINTO (clonado), reescribiendo tenant_id", async () => {
    const { tenant: origen, usuario } = await nuevoTenant();
    await cargarDatosDePrueba(origen.id, usuario.id);
    const backup = await request(app).post(`/api/platform/tenants/${origen.id}/backups`).set("Authorization", BEARER);

    const { tenant: destino } = await nuevoTenant();

    const restaurar = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: destino.id, confirmar: true });

    expect(restaurar.status).toBe(200);
    expect(restaurar.body.tablasRestauradas.equipos).toBe(1);

    const equiposDestino = await withTenant(destino.id, (client) =>
      client.query(`SELECT tenant_id FROM equipos WHERE tenant_id = $1`, [destino.id])
    );
    expect(equiposDestino.rows).toHaveLength(1);
    expect(equiposDestino.rows[0].tenant_id).toBe(destino.id);

    // El origen no se tocó.
    const equiposOrigen = await withTenant(origen.id, (client) =>
      client.query(`SELECT count(*) AS total FROM equipos WHERE tenant_id = $1`, [origen.id])
    );
    expect(Number(equiposOrigen.rows[0].total)).toBe(1);
  });

  it("da 400 sin confirmar:true", async () => {
    const { tenant } = await nuevoTenant();
    const backup = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);

    const res = await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id });

    expect(res.status).toBe(400);
  });

  it("da 404 con un backupId que no existe", async () => {
    const { tenant } = await nuevoTenant();
    const res = await request(app)
      .post(`/api/platform/backups/00000000-0000-0000-0000-000000000000/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });
    expect(res.status).toBe(404);
  });

  it("queda auditado con antes/después de tablas restauradas", async () => {
    const { tenant } = await nuevoTenant();
    const backup = await request(app).post(`/api/platform/tenants/${tenant.id}/backups`).set("Authorization", BEARER);

    await request(app)
      .post(`/api/platform/backups/${backup.body.backup.id}/restaurar`)
      .set("Authorization", BEARER)
      .send({ targetTenantId: tenant.id, confirmar: true });

    const auditoria = await pool.query(
      `SELECT detalle, resultado FROM platform_audit_log WHERE accion = 'restaurar_backup_tenant' AND tenant_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [tenant.id]
    );
    expect(auditoria.rows).toHaveLength(1);
    expect(auditoria.rows[0].resultado).toBe("success");
    expect(auditoria.rows[0].detalle.backupId).toBe(backup.body.backup.id);
  });
});
