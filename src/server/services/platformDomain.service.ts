/** src/server/services/platformDomain.service.ts
 *
 * Verificación de propiedad de dominio personalizado por tenant
 * (migrations/0020_tenant_dominio_verificacion.sql) — antes, un dominio
 * asignado desde el panel de plataforma se usaba directo para resolver
 * login (ver resolveTenantSubdomain.ts) sin ninguna prueba de que quien
 * lo configuró controlara ese dominio de verdad.
 *
 * Flujo: asignarDominioTenantService dejа el dominio en
 * 'pendiente_verificacion' con un token propio, nunca lo activa directo.
 * verificarDominioService consulta DNS de verdad (TXT record en
 * `_mincore-verification.<dominio>`) y recién ahí, si coincide, pasa a
 * 'activo' — el único estado desde el que resolveTenantSubdomain.ts
 * resuelve un login por dominio propio.
 */
import { randomBytes } from "crypto";
import { resolveTxt } from "dns/promises";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";

export type EstadoDominio = "pendiente_verificacion" | "activo" | "fallido" | "desactivado";

export interface DominioTenant {
  dominioPersonalizado: string | null;
  dominioEstado: EstadoDominio;
  /** Nombre del registro TXT que el cliente tiene que crear — null si no
   *  hay ningún dominio pendiente de verificar. */
  dominioRegistroEsperado: string | null;
  /** Valor exacto que ese TXT record tiene que tener. */
  dominioValorEsperado: string | null;
  dominioVerificadoEn: string | null;
  dominioVerificacionIntentos: number;
  dominioUltimoIntentoEn: string | null;
}

// Subdominio dedicado (no la raíz) a propósito: la raíz de un dominio real
// suele tener ya otros TXT records (SPF, DKIM, verificaciones de otros
// proveedores) — pedirle al cliente que agregue el suyo acá evita pisar
// ninguno de esos.
const PREFIJO_REGISTRO = "_mincore-verification";

function registroDe(dominio: string): string {
  return `${PREFIJO_REGISTRO}.${dominio}`;
}

function valorEsperadoDe(token: string): string {
  return `mincore-verify=${token}`;
}

function generarToken(): string {
  return randomBytes(16).toString("hex");
}

const SELECT_DOMINIO = `
  dominio_personalizado AS "dominioPersonalizado",
  dominio_estado AS "dominioEstado",
  dominio_token_verificacion AS "dominioTokenVerificacion",
  dominio_verificado_en AS "dominioVerificadoEn",
  dominio_verificacion_intentos AS "dominioVerificacionIntentos",
  dominio_ultimo_intento_en AS "dominioUltimoIntentoEn"
`;

interface FilaDominio {
  dominioPersonalizado: string | null;
  dominioEstado: EstadoDominio;
  dominioTokenVerificacion: string | null;
  dominioVerificadoEn: string | null;
  dominioVerificacionIntentos: number;
  dominioUltimoIntentoEn: string | null;
}

function filaADominio(fila: FilaDominio): DominioTenant {
  const pendiente = !!fila.dominioPersonalizado && !!fila.dominioTokenVerificacion;
  return {
    dominioPersonalizado: fila.dominioPersonalizado,
    dominioEstado: fila.dominioEstado,
    dominioRegistroEsperado: pendiente ? registroDe(fila.dominioPersonalizado!) : null,
    dominioValorEsperado: pendiente ? valorEsperadoDe(fila.dominioTokenVerificacion!) : null,
    dominioVerificadoEn: fila.dominioVerificadoEn,
    dominioVerificacionIntentos: fila.dominioVerificacionIntentos,
    dominioUltimoIntentoEn: fila.dominioUltimoIntentoEn,
  };
}

/** Asigna (o quita, con null) el dominio propio de un tenant. Un dominio
 *  nuevo SIEMPRE entra en 'pendiente_verificacion' con un token fresco —
 *  nunca se activa directo, ni siquiera si el tenant ya tenía otro
 *  dominio verificado antes (cambiar de dominio exige verificar el nuevo
 *  de nuevo, es un dominio distinto). */
export async function asignarDominioTenantService(
  tenantId: string,
  dominioPersonalizado: string | null,
  contexto: ContextoAuditoria
): Promise<DominioTenant> {
  let result;
  try {
    if (dominioPersonalizado === null) {
      result = await pool.query(
        `UPDATE tenants SET
           dominio_personalizado = NULL,
           dominio_estado = 'desactivado',
           dominio_token_verificacion = NULL,
           dominio_verificado_en = NULL,
           dominio_verificacion_intentos = 0,
           dominio_ultimo_intento_en = NULL
         WHERE id = $1 RETURNING ${SELECT_DOMINIO}`,
        [tenantId]
      );
    } else {
      result = await pool.query(
        `UPDATE tenants SET
           dominio_personalizado = $1,
           dominio_estado = 'pendiente_verificacion',
           dominio_token_verificacion = $2,
           dominio_verificado_en = NULL,
           dominio_verificacion_intentos = 0,
           dominio_ultimo_intento_en = NULL
         WHERE id = $3 RETURNING ${SELECT_DOMINIO}`,
        [dominioPersonalizado, generarToken(), tenantId]
      );
    }
  } catch (err: any) {
    if (err.code === "23505") {
      throw new AppError(409, "Ese dominio ya está asignado a otro tenant");
    }
    throw err;
  }

  if (result.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const dominio = filaADominio(result.rows[0]);

  await registrarAuditoria({
    accion: "actualizar_dominio_tenant",
    tenantId,
    detalle: { dominioPersonalizado, dominioEstado: dominio.dominioEstado },
    contexto,
  });

  return dominio;
}

/** true si el TXT record `_mincore-verification.<dominio>` existe y
 *  coincide — ENOTFOUND/ENODATA (el caso normal mientras el cliente
 *  todavía no propagó su DNS) no se trata como error del sistema. */
async function existeRegistroTxt(dominio: string, valorEsperado: string): Promise<boolean> {
  try {
    const registros = await resolveTxt(registroDe(dominio));
    // Cada TXT record puede venir partido en varios strings — se unen
    // antes de comparar (dns.resolveTxt de Node ya los separa así).
    return registros.some((partes) => partes.join("").trim() === valorEsperado);
  } catch (err: any) {
    if (err?.code !== "ENOTFOUND" && err?.code !== "ENODATA") {
      logger.warn({ err, dominio }, "Error inesperado resolviendo el TXT de verificación de dominio");
    }
    return false;
  }
}

/** Consulta DNS de verdad y actualiza el estado según el resultado — se
 *  puede llamar tantas veces como haga falta (ej. "Verificar ahora" en la
 *  UI mientras el cliente todavía está propagando su DNS), sin perder el
 *  token entre intentos. */
export async function verificarDominioService(tenantId: string, contexto: ContextoAuditoria): Promise<DominioTenant> {
  const actual = await pool.query<FilaDominio>(`SELECT ${SELECT_DOMINIO} FROM tenants WHERE id = $1`, [tenantId]);
  if (actual.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }

  const fila = actual.rows[0];
  if (!fila.dominioPersonalizado || !fila.dominioTokenVerificacion) {
    throw new AppError(400, "Este tenant no tiene un dominio pendiente de verificación");
  }

  const valorEsperado = valorEsperadoDe(fila.dominioTokenVerificacion);
  const verificado = await existeRegistroTxt(fila.dominioPersonalizado, valorEsperado);
  const nuevoEstado: EstadoDominio = verificado ? "activo" : "fallido";

  const result = await pool.query<FilaDominio>(
    `UPDATE tenants SET
       dominio_estado = $1,
       dominio_verificado_en = CASE WHEN $1 = 'activo' THEN now() ELSE dominio_verificado_en END,
       dominio_verificacion_intentos = dominio_verificacion_intentos + 1,
       dominio_ultimo_intento_en = now()
     WHERE id = $2 RETURNING ${SELECT_DOMINIO}`,
    [nuevoEstado, tenantId]
  );

  await registrarAuditoria({
    accion: "verificar_dominio_tenant",
    tenantId,
    detalle: {
      dominio: fila.dominioPersonalizado,
      registroEsperado: registroDe(fila.dominioPersonalizado),
      valorEsperado,
    },
    contexto,
    resultado: verificado ? "success" : "failure",
  });

  return filaADominio(result.rows[0]);
}

/** Para la UI: al reabrir un tenant, poder volver a mostrar el TXT
 *  record pendiente sin disparar una consulta DNS real (eso solo lo hace
 *  verificarDominioService, a pedido explícito de "Verificar ahora"). */
export async function obtenerDominioTenantService(tenantId: string): Promise<DominioTenant> {
  const result = await pool.query<FilaDominio>(`SELECT ${SELECT_DOMINIO} FROM tenants WHERE id = $1`, [tenantId]);
  if (result.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }
  return filaADominio(result.rows[0]);
}
