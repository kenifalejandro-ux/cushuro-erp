/** tests/platform-audit-retention.test.ts
 *
 * Retención opcional de platform_audit_log (migrations/0019_platform_audit_log_retencion.sql).
 * `limpiarAuditoriaVieja()` acepta un `retentionDays` explícito para poder
 * probarla sin depender de PLATFORM_AUDIT_RETENTION_DAYS (que en el resto
 * de la suite queda deshabilitado a propósito — nada de estos tests debe
 * andar borrando filas de auditoría que otros archivos de test todavía
 * están usando).
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, closeDatabase } from "../src/server/config/database";
import { idUnico } from "./helpers";
import { limpiarAuditoriaVieja } from "../src/server/services/platformAuditRetention.worker";

afterAll(async () => {
  await closeDatabase();
});

async function insertarConFecha(accion: string, diasAtras: number): Promise<string> {
  const result = await pool.query(
    `INSERT INTO platform_audit_log (accion, creado_en) VALUES ($1, now() - make_interval(days => $2)) RETURNING id`,
    [accion, diasAtras]
  );
  return result.rows[0].id;
}

describe("limpiarAuditoriaVieja", () => {
  it("con retentionDays configurado, borra lo más viejo que eso y deja lo reciente", async () => {
    const vieja = await insertarConFecha(idUnico("retencion-vieja"), 400);
    const nueva = await insertarConFecha(idUnico("retencion-nueva"), 0);

    const { filasBorradas } = await limpiarAuditoriaVieja({ retentionDays: 365 });
    expect(filasBorradas).toBeGreaterThanOrEqual(1);

    expect(
      (await pool.query(`SELECT id FROM platform_audit_log WHERE id = $1`, [vieja])).rows
    ).toHaveLength(0);
    expect(
      (await pool.query(`SELECT id FROM platform_audit_log WHERE id = $1`, [nueva])).rows
    ).toHaveLength(1);

    await pool.query(`DELETE FROM platform_audit_log WHERE id = $1`, [nueva]);
  });

  it("sin retentionDays (deshabilitado, el default) no borra nada, ni algo de miles de días", async () => {
    const vieja = await insertarConFecha(idUnico("retencion-deshabilitada"), 3000);

    const { filasBorradas } = await limpiarAuditoriaVieja({ retentionDays: 0 });
    expect(filasBorradas).toBe(0);

    expect(
      (await pool.query(`SELECT id FROM platform_audit_log WHERE id = $1`, [vieja])).rows
    ).toHaveLength(1);

    await pool.query(`DELETE FROM platform_audit_log WHERE id = $1`, [vieja]);
  });

  it("el default real de la app (sin pasar nada) también respeta el opt-in — no borra sin configurar PLATFORM_AUDIT_RETENTION_DAYS", async () => {
    const vieja = await insertarConFecha(idUnico("retencion-sin-opciones"), 5000);

    const { filasBorradas } = await limpiarAuditoriaVieja();
    expect(filasBorradas).toBe(0);

    expect(
      (await pool.query(`SELECT id FROM platform_audit_log WHERE id = $1`, [vieja])).rows
    ).toHaveLength(1);

    await pool.query(`DELETE FROM platform_audit_log WHERE id = $1`, [vieja]);
  });
});
