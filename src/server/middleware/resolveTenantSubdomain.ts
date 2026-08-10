/** src/server/middleware/resolveTenantSubdomain.ts
 *
 * Resuelve a qué tenant pertenece la petición según el `Host` con el que
 * llegó, e inyecta ese slug en req.body.tenantSlug antes de
 * validate(loginSchema) — así el cliente nunca ve ni envía un campo
 * "Empresa": el tenant lo determina la URL a la que entró, no un dato del
 * formulario. Dos formas, en este orden:
 *
 * 1. Dominio propio del cliente (ej. "cushuro.pe", guardado en
 *    tenants.dominio_personalizado) — cada empresa entra con SU dominio,
 *    no con uno de la plataforma. Solo resuelve si dominio_estado =
 *    'activo' (ver migrations/0020_tenant_dominio_verificacion.sql /
 *    platformDomain.service.ts) — un dominio 'pendiente_verificacion' o
 *    'fallido' significa que todavía no se confirmó que quien lo asignó
 *    controle ese dominio de verdad, así que no puede resolver logins.
 * 2. Subdominio de la plataforma (ej. "cushuro.<appApexDomain>") — respaldo
 *    para el cliente que todavía no tiene dominio propio.
 *
 * Se ejecuta ANTES de validate() a propósito: si resuelve alguno de los
 * dos, sobreescribe cualquier tenantSlug que el body ya traiga (nunca
 * confiar en lo que mande el cliente cuando la URL ya lo deja inequívoco).
 * Si no resuelve ninguno (dominio raíz de la plataforma, localhost, o un
 * host que no coincide con nada), no toca el body — el campo manual
 * "Empresa" sigue siendo la única fuente, que es como entra hoy el dueño
 * de la plataforma.
 */
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { asyncHandler } from "../shared/utils/asyncHandler";

const SUBDOMINIOS_RESERVADOS = new Set(["www", "app", "api", "admin", "sigma"]);

export const resolveTenantSubdomain = asyncHandler(async function resolveTenantSubdomain(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const host = (req.hostname || "").toLowerCase();

  // ── 1. Dominio propio del cliente ───────────────────────────────────
  // Se salta la consulta para los hosts obviamente "nuestros" (localhost,
  // el dominio raíz de la plataforma) — ningún tenant puede tener esos
  // valores en dominio_personalizado (columna UNIQUE, y no son dominios
  // reales de ningún cliente).
  if (host && host !== "localhost" && host !== "127.0.0.1" && host !== env.appApexDomain) {
    try {
      const resultado = await pool.query(
        `SELECT slug FROM tenants WHERE dominio_personalizado = $1 AND dominio_estado = 'activo' AND activo = true`,
        [host]
      );
      if (resultado.rows[0]) {
        req.body = { ...req.body, tenantSlug: resultado.rows[0].slug };
        return next();
      }
    } catch (err) {
      // No tumbar el login por esto — si falla, cae al resto de la lógica
      // (subdominio propio o campo manual) en vez de romper la petición.
      logger.warn({ err }, "No se pudo resolver tenant por dominio personalizado");
    }
  }

  // ── 2. Subdominio de la plataforma (respaldo) ───────────────────────
  if (!env.appApexDomain) return next();
  if (host === env.appApexDomain || !host.endsWith(`.${env.appApexDomain}`)) {
    return next();
  }

  const slug = host.slice(0, -(env.appApexDomain.length + 1));
  if (!slug || slug.includes(".") || SUBDOMINIOS_RESERVADOS.has(slug)) {
    return next();
  }

  req.body = { ...req.body, tenantSlug: slug };
  next();
});
