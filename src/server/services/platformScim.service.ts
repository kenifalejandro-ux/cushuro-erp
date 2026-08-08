/** src/server/services/platformScim.service.ts
 *
 * Configuración de SCIM por tenant: un token de bearer separado del login
 * (nunca sirve para autenticarse como un usuario, solo para que el IdP del
 * tenant llame a /scim/v2/* y mantenga sincronizada su nómina de usuarios
 * con MinCore). Mismo criterio de almacenamiento que refresh_tokens/
 * reset_tokens: se guarda solo el hash (sha256) — el valor en texto plano
 * existe una sola vez, en el momento de generarlo o rotarlo, y no vuelve a
 * ser recuperable después (si se pierde, hay que rotar de nuevo).
 */
import { randomBytes, createHash } from "crypto";
import { pool } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";

function hashToken(tokenPlano: string): string {
  return createHash("sha256").update(tokenPlano).digest("hex");
}

export interface ConfigScim {
  configurado: boolean;
  activo: boolean;
  creadoEn: string | null;
  rotadoEn: string | null;
}

export async function obtenerConfigScimService(tenantId: string): Promise<ConfigScim> {
  const result = await pool.query(
    `SELECT activo, creado_en AS "creadoEn", rotado_en AS "rotadoEn" FROM tenant_scim_config WHERE tenant_id = $1`,
    [tenantId]
  );
  const fila = result.rows[0];
  if (!fila) return { configurado: false, activo: false, creadoEn: null, rotadoEn: null };
  return { configurado: true, ...fila };
}

/** Genera (o rota, si ya existía) el token SCIM del tenant — devuelve el
 *  valor en texto plano UNA SOLA VEZ; el caller (la ruta) es responsable
 *  de mostrárselo al admin ahí mismo y no volver a guardarlo en ningún
 *  lado del backend. */
export async function generarTokenScimService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<string> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) throw new AppError(404, "Tenant no encontrado");

  const yaExistia = await pool.query(`SELECT 1 FROM tenant_scim_config WHERE tenant_id = $1`, [
    tenantId,
  ]);
  const tokenPlano = randomBytes(32).toString("base64url");

  await pool.query(
    `INSERT INTO tenant_scim_config (tenant_id, token_hash, activo, rotado_en)
     VALUES ($1, $2, true, ${yaExistia.rows.length > 0 ? "now()" : "NULL"})
     ON CONFLICT (tenant_id) DO UPDATE SET token_hash = $2, activo = true, rotado_en = now()`,
    [tenantId, hashToken(tokenPlano)]
  );

  await registrarAuditoria({
    accion: yaExistia.rows.length > 0 ? "rotar_token_scim" : "crear_token_scim",
    tenantId,
    contexto,
  });

  return tokenPlano;
}

export async function revocarTokenScimService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<void> {
  const result = await pool.query(
    `UPDATE tenant_scim_config SET activo = false WHERE tenant_id = $1`,
    [tenantId]
  );
  if (result.rowCount === 0) throw new AppError(404, "Este tenant no tiene SCIM configurado");

  await registrarAuditoria({ accion: "revocar_token_scim", tenantId, contexto });
}

/** Único punto de entrada para resolver una request SCIM entrante a un
 *  tenant — no hay Host/subdominio de por medio (quien llama es el IdP
 *  del tenant, no un browser), así que el bearer token ES la única forma
 *  de saber de qué tenant se trata. */
export async function resolverTenantPorTokenScimService(
  tokenPlano: string
): Promise<string | null> {
  const result = await pool.query(
    `SELECT tenant_id AS "tenantId" FROM tenant_scim_config WHERE token_hash = $1 AND activo = true`,
    [hashToken(tokenPlano)]
  );
  return result.rows[0]?.tenantId ?? null;
}
