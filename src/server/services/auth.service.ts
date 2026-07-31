/** src/server/services/auth.service.ts */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "../config/database";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import type { LoginInput } from "../schemas/auth.schema";
import { requerirJwtSecret } from "../shared/utils/jwt-secret";
import { setCachedTokenVersion, invalidateCachedTokenVersion } from "../shared/utils/token-version-cache";

const JWT_SECRET = requerirJwtSecret();

// Hash "señuelo" precalculado (de una contraseña arbitraria) para que, cuando
// el email no exista, igual se ejecute un bcrypt.compare y el tiempo de
// respuesta no delate si el correo está o no registrado.
const HASH_SEÑUELO = "$2b$12$CwTycUXWue0Thq9StjUM0uJ8n3g7dCXi/GjQzEr8h5oT5w9Kj0R3W";

export interface UsuarioPayload {
  id: string;
  tenantId: string;
  nombre: string;
  email: string;
  rol: "admin" | "operador" | "lectura";
  /** Comparado contra usuarios.token_version en cada request (ver
   *  authMiddleware): incrementar esa columna revoca todos los JWT emitidos
   *  antes del incremento, sin depender de que Redis esté disponible. */
  tokenVersion: number;
}

/** Solo para exponer al cliente: nunca se envía tokenVersion en las
 *  respuestas HTTP (login, /me) — es un detalle interno de revocación. */
export function aPublico(usuario: UsuarioPayload) {
  const { tokenVersion, ...publico } = usuario;
  return publico;
}

function firmarAccessToken(usuario: UsuarioPayload): string {
  return jwt.sign(usuario, JWT_SECRET, {
    expiresIn: env.jwtExpires as jwt.SignOptions["expiresIn"],
  });
}

function hashRefreshToken(tokenPlano: string): string {
  return createHash("sha256").update(tokenPlano).digest("hex");
}

/** Genera un refresh token opaco (no JWT), guarda solo su hash en BD y
 *  devuelve el valor en texto plano para mandarlo como cookie — es la
 *  única vez que existe en texto plano fuera del cliente. */
async function emitirRefreshToken(usuarioId: string): Promise<string> {
  const tokenPlano = randomBytes(48).toString("hex");
  const expiraEn = new Date(Date.now() + env.sessionTtlSeconds * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (usuario_id, token_hash, expira_en) VALUES ($1, $2, $3)`,
    [usuarioId, hashRefreshToken(tokenPlano), expiraEn]
  );

  return tokenPlano;
}

export async function loginService(input: LoginInput): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  let result;
  try {
    result = await pool.query(
      `SELECT u.id, u.tenant_id, u.nombre, u.email, u.password_hash, u.rol, u.token_version
       FROM usuarios u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND u.activo = true AND t.activo = true`,
      [input.email.toLowerCase()]
    );
  } catch (err) {
    // Nunca reenviar al cliente el error crudo de la BD (puede filtrar
    // credenciales, nombres de tabla, etc.) — se loguea server-side y se
    // devuelve un mensaje genérico como cualquier otro fallo de login.
    logger.error({ err }, "Error de BD durante login");
    throw new AppError(401, "Credenciales inválidas");
  }

  const fila = result.rows[0];

  // Se compara siempre contra un hash (real o señuelo) para que el tiempo de
  // respuesta sea el mismo exista o no el correo — evita enumeración de
  // usuarios por timing.
  const passwordValido = await bcrypt.compare(input.password, fila?.password_hash ?? HASH_SEÑUELO);
  if (!fila || !passwordValido) {
    throw new AppError(401, "Credenciales inválidas");
  }

  const usuario: UsuarioPayload = {
    id: fila.id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    rol: fila.rol,
    tokenVersion: fila.token_version,
  };

  const token = firmarAccessToken(usuario);
  const refreshToken = await emitirRefreshToken(usuario.id);

  // Cachea la versión vigente para que el primer request autenticado tras
  // el login no tenga que ir a Postgres a buscarla (ver authMiddleware).
  await setCachedTokenVersion(usuario.id, usuario.tokenVersion);

  // Sesión en Redis: permite invalidar el token activamente en logout,
  // en vez de depender solo de que el JWT expire por su cuenta.
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`session:${usuario.id}`, token, "EX", env.sessionTtlSeconds);
    } catch (err) {
      logger.warn({ err }, "No se pudo guardar la sesión en Redis, continuando solo con JWT");
    }
  }

  return { token, usuario, refreshToken };
}

/** Cambia el access token (30 min) por uno nuevo usando el refresh token de
 *  vida larga (30 días), sin pedir credenciales otra vez. Rota el refresh
 *  token en cada uso: el anterior queda revocado y no puede reutilizarse.
 *
 *  Si el refresh token presentado YA estaba revocado (reuso de un token
 *  que ya se había cambiado por otro), se asume robo/replay y se revocan
 *  TODOS los refresh tokens y sesiones de ese usuario como contención. */
export async function refrescarTokenService(
  refreshTokenPlano: string
): Promise<{ token: string; usuario: UsuarioPayload; refreshToken: string }> {
  const hash = hashRefreshToken(refreshTokenPlano);

  const result = await pool.query(
    `SELECT rt.usuario_id, rt.expira_en, rt.revocado_en,
            u.tenant_id, u.nombre, u.email, u.rol, u.token_version, u.activo
     FROM refresh_tokens rt
     JOIN usuarios u ON u.id = rt.usuario_id
     WHERE rt.token_hash = $1`,
    [hash]
  );

  const fila = result.rows[0];
  if (!fila) {
    throw new AppError(401, "Sesión inválida, inicia sesión nuevamente");
  }

  if (fila.revocado_en) {
    logger.warn({ usuarioId: fila.usuario_id }, "Reuso de refresh token detectado, revocando todas las sesiones");
    await revocarSesionesService(fila.usuario_id);
    throw new AppError(401, "Sesión inválida, inicia sesión nuevamente");
  }

  // Revoca el token presentado (se use o no más abajo) antes de seguir,
  // para que dos requests concurrentes con el mismo refresh token no
  // puedan generar dos pares de tokens válidos a la vez.
  await pool.query(`UPDATE refresh_tokens SET revocado_en = now() WHERE token_hash = $1`, [hash]);

  if (!fila.activo || new Date(fila.expira_en).getTime() < Date.now()) {
    throw new AppError(401, "Sesión expirada, inicia sesión nuevamente");
  }

  const usuario: UsuarioPayload = {
    id: fila.usuario_id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    rol: fila.rol,
    tokenVersion: fila.token_version,
  };

  const token = firmarAccessToken(usuario);
  const nuevoRefreshToken = await emitirRefreshToken(usuario.id);
  await setCachedTokenVersion(usuario.id, usuario.tokenVersion);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`session:${usuario.id}`, token, "EX", env.sessionTtlSeconds);
    } catch (err) {
      logger.warn({ err }, "No se pudo actualizar la sesión en Redis durante refresh");
    }
  }

  return { token, usuario, refreshToken: nuevoRefreshToken };
}

/** Revoca de una sola vez TODOS los JWT ya emitidos para este usuario
 *  (incrementa token_version en BD) — funciona con o sin Redis. Pensado
 *  para reusarse desde logoutService y, a futuro, desde acciones de admin
 *  como desactivar un usuario o cambiarle el rol. */
export async function revocarSesionesService(usuarioId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE usuarios SET token_version = token_version + 1 WHERE id = $1`,
      [usuarioId]
    );
    await pool.query(
      `UPDATE refresh_tokens SET revocado_en = now() WHERE usuario_id = $1 AND revocado_en IS NULL`,
      [usuarioId]
    );
  } catch (err) {
    logger.error({ err }, "No se pudo incrementar token_version al revocar sesiones");
    throw new AppError(500, "No se pudo cerrar la sesión");
  }

  await invalidateCachedTokenVersion(usuarioId);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`session:${usuarioId}`);
    } catch (err) {
      logger.warn({ err }, "No se pudo limpiar la sesión en Redis durante logout");
    }
  }
}

export async function logoutService(usuarioId: string): Promise<void> {
  await revocarSesionesService(usuarioId);
}

export async function crearUsuarioService(
  input: {
    tenantId: string;
    nombre: string;
    email: string;
    password: string;
    rol?: UsuarioPayload["rol"];
  },
  // Permite que el caller pase un client dentro de su propia transacción
  // (ej. platform.service.ts crea tenant + admin de forma atómica). Por
  // default usa el pool normal, así que no cambia el comportamiento para
  // quien no lo necesita.
  db: Pool | PoolClient = pool
): Promise<UsuarioPayload> {
  const passwordHash = await bcrypt.hash(input.password, 12);

  let result;
  try {
    result = await db.query(
      `INSERT INTO usuarios (tenant_id, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, COALESCE($5::rol_usuario, 'operador'))
       RETURNING id, tenant_id, nombre, email, rol, token_version`,
      [input.tenantId, input.nombre, input.email.toLowerCase(), passwordHash, input.rol ?? null]
    );
  } catch (err: any) {
    // Mismo criterio que loginService: nunca reenviar el error crudo de la
    // BD al cliente (podría filtrar nombres de tabla/constraint).
    if (err.code === "23505") {
      throw new AppError(409, "Ya existe un usuario con ese correo en este tenant");
    }
    logger.error({ err }, "Error de BD al crear usuario");
    throw new AppError(500, "No se pudo crear el usuario");
  }

  const fila = result.rows[0];
  return {
    id: fila.id,
    tenantId: fila.tenant_id,
    nombre: fila.nombre,
    email: fila.email,
    rol: fila.rol,
    tokenVersion: fila.token_version,
  };
}
