/** src/server/services/platformAdminAccount.service.ts
 *
 * Cuentas individuales de Platform Admin (migrations/0016_platform_admins.sql)
 * — reemplazan, para quien las use, el secreto compartido como forma de
 * identificarse ante el panel. PLATFORM_ADMIN_TOKEN sigue funcionando
 * exactamente igual que antes: queda como modo de emergencia, nunca se
 * retira (ver platformAdmin.middleware.ts).
 */
import bcrypt from "bcrypt";
import { pool } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { revocarSesionesDeAdmin } from "./platformSession.service";
import type { PlatformActor } from "../shared/utils/request";
import { esViolacionUnicidad } from "../shared/utils/pgError";

// Señuelo para que un login con email inexistente tarde lo mismo que uno
// que sí existe — mismo criterio que HASH_SEÑUELO en auth.service.ts
// (evita enumeración de admins por timing); valor propio porque son
// módulos independientes, no importa que sea un hash distinto.
const HASH_SEÑUELO = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8n3g7dCXi/GjQzEr8h5oT5w9Kj0R3W";

export type RolPlatformAdmin = "super_admin" | "admin";

export interface PlatformAdmin {
  id: string;
  email: string;
  nombre: string;
  rol: RolPlatformAdmin;
  activo: boolean;
  creadoEn: string;
}

/** null si el email no existe, está desactivado, o la contraseña no
 *  coincide — mismo mensaje genérico de error para los tres casos en el
 *  caller (ver POST /admin-sesion), para no filtrar cuál de las tres fue. */
export async function verificarCredencialesPlatformAdminService(
  email: string,
  password: string
): Promise<PlatformAdmin | null> {
  const result = await pool.query(
    `SELECT id, email, password_hash, nombre, rol, activo, creado_en AS "creadoEn"
     FROM platform_admins WHERE email = $1 AND activo = true`,
    [email.toLowerCase()]
  );
  const fila = result.rows[0];

  const passwordValido = await bcrypt.compare(password, fila?.password_hash ?? HASH_SEÑUELO);
  if (!fila || !passwordValido) return null;

  const { password_hash: _passwordHash, ...admin } = fila;
  return admin;
}

export async function listarPlatformAdminsService(): Promise<PlatformAdmin[]> {
  const result = await pool.query(
    `SELECT id, email, nombre, rol, activo, creado_en AS "creadoEn" FROM platform_admins ORDER BY creado_en`
  );
  return result.rows;
}

export async function obtenerPlatformAdminService(id: string): Promise<PlatformAdmin | null> {
  const result = await pool.query(
    `SELECT id, email, nombre, rol, activo, creado_en AS "creadoEn" FROM platform_admins WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function crearPlatformAdminService(input: {
  email: string;
  password: string;
  nombre: string;
  rol: RolPlatformAdmin;
}): Promise<PlatformAdmin> {
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    const result = await pool.query(
      `INSERT INTO platform_admins (email, password_hash, nombre, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, nombre, rol, activo, creado_en AS "creadoEn"`,
      [input.email.toLowerCase(), passwordHash, input.nombre, input.rol]
    );
    return result.rows[0];
  } catch (err) {
    if (esViolacionUnicidad(err)) {
      throw new AppError(409, "Ya existe un admin de plataforma con ese correo");
    }
    throw err;
  }
}

/** Nunca borra la fila (soft-delete, mismo criterio que tenants/usuarios) —
 *  desactivar corta el acceso de inmediato: revoca todas las sesiones
 *  activas del admin (ver revocarSesionesDeAdmin), no espera a que su
 *  cookie expire sola.
 *
 *  No permite dejar la plataforma sin ningún super_admin activo — sin
 *  esto, desactivar por error al único que queda deja la gestión de
 *  admins solo alcanzable con el secreto compartido (recuperable, pero
 *  una fricción evitable). El chequeo es actor-agnóstico a propósito
 *  (aplica también si lo pide el secreto compartido): no es un permiso,
 *  es una invariante de datos — evitar un "queda en cero" accidental, no
 *  restringir a quién ya tiene el poder de crear otro super_admin de
 *  todos modos.
 *
 *  pg_advisory_xact_lock serializa todos los intentos de desactivar un
 *  super_admin entre sí: sin el lock, dos desactivaciones concurrentes de
 *  los dos últimos super_admin activos podrían pasar la validación al
 *  mismo tiempo (cada transacción ve al otro todavía activo en su propio
 *  snapshot de MVCC) y dejar la plataforma en cero — un UPDATE con WHERE
 *  no alcanza para cerrar esa carrera porque las dos filas son distintas. */
export async function cambiarEstadoPlatformAdminService(
  id: string,
  activo: boolean
): Promise<{ admin: PlatformAdmin; before: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('platform_admins_super_admin_guard'))"
    );

    const anterior = await client.query(`SELECT activo, rol FROM platform_admins WHERE id = $1`, [
      id,
    ]);
    if (anterior.rows.length === 0) {
      throw new AppError(404, "Admin de plataforma no encontrado");
    }

    const eraSuperAdminActivo = anterior.rows[0].rol === "super_admin" && anterior.rows[0].activo;
    if (!activo && eraSuperAdminActivo) {
      const otros = await client.query(
        `SELECT count(*)::int AS total FROM platform_admins WHERE rol = 'super_admin' AND activo = true AND id != $1`,
        [id]
      );
      if (otros.rows[0].total === 0) {
        throw new AppError(400, "No podés desactivar al último super_admin activo");
      }
    }

    const result = await client.query(
      `UPDATE platform_admins SET activo = $1, actualizado_en = now() WHERE id = $2
       RETURNING id, email, nombre, rol, activo, creado_en AS "creadoEn"`,
      [activo, id]
    );

    await client.query("COMMIT");

    if (!activo) {
      await revocarSesionesDeAdmin(id);
    }

    return { admin: result.rows[0], before: anterior.rows[0].activo };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Cambio de contraseña self-service (el propio admin, no otro super_admin
 *  actuando sobre él — para eso no hay endpoint, mismo criterio que
 *  usuarios de tenant: nadie más puede fijarle la contraseña a otro).
 *  Exige la contraseña actual para evitar que una sesión robada (cookie
 *  filtrada, navegador compartido) alcance para tomar la cuenta entera.
 *  Revoca todas las sesiones del admin al terminar, la que hizo el cambio
 *  incluida — mismo motivo que forzar un logout tras cambiar contraseña en
 *  cualquier sistema: una sesión vieja no debería sobrevivir al secreto
 *  que la respalda. */
export async function cambiarPasswordPropioPlatformAdminService(
  id: string,
  passwordActual: string,
  passwordNueva: string
): Promise<void> {
  const result = await pool.query(
    `SELECT password_hash FROM platform_admins WHERE id = $1 AND activo = true`,
    [id]
  );
  const fila = result.rows[0];

  const passwordValido = await bcrypt.compare(passwordActual, fila?.password_hash ?? HASH_SEÑUELO);
  if (!fila || !passwordValido) {
    throw new AppError(401, "Contraseña actual incorrecta");
  }

  const passwordHash = await bcrypt.hash(passwordNueva, 12);
  await pool.query(
    `UPDATE platform_admins SET password_hash = $1, actualizado_en = now() WHERE id = $2`,
    [passwordHash, id]
  );

  await revocarSesionesDeAdmin(id);
}

/** true si el actor autenticado puede gestionar otras cuentas de Platform
 *  Admin: el secreto compartido siempre puede (es el fallback de
 *  emergencia, con más poder que cualquier cuenta individual — así se
 *  puede recuperar acceso si todos los super_admin quedan bloqueados); un
 *  admin individual solo si es super_admin Y sigue activo ahora mismo — se
 *  revalida contra la base en cada llamada, no se confía en lo que haya
 *  quedado cacheado en la sesión de Redis al momento del login, porque es
 *  un gate de privilegio, no una acción cualquiera. */
export async function esSuperAdminVigente(actor: PlatformActor | undefined): Promise<boolean> {
  if (!actor) return false;
  if (actor.actorType === "emergency_shared_secret") return true;

  const admin = await obtenerPlatformAdminService(actor.actorId);
  return !!admin && admin.activo && admin.rol === "super_admin";
}
