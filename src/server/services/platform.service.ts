/** src/server/services/platform.service.ts
 *
 * Operaciones de plataforma: dar de alta un tenant nuevo. Separado de
 * auth.service.ts porque no es una operación de un usuario autenticado —
 * la protege platformAdmin.middleware.ts con un secreto aparte, no un JWT.
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import { crearUsuarioService, aPublico, type UsuarioPayload } from "./auth.service";
import type { CrearTenantInput } from "../schemas/platform.schema";

export interface TenantCreado {
  id: string;
  nombre: string;
  slug: string;
}

export async function crearTenantConAdminService(
  input: CrearTenantInput
): Promise<{ tenant: TenantCreado; usuario: Omit<UsuarioPayload, "tokenVersion"> }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let tenantResult;
    try {
      tenantResult = await client.query(
        `INSERT INTO tenants (nombre, slug) VALUES ($1, $2) RETURNING id, nombre, slug`,
        [input.tenantNombre, input.tenantSlug]
      );
    } catch (err: any) {
      if (err.code === "23505") {
        throw new AppError(409, "Ya existe un tenant con ese slug");
      }
      throw err;
    }

    const tenant: TenantCreado = tenantResult.rows[0];

    // Mismo client/transacción: si crear el admin falla, el tenant tampoco
    // queda creado — nunca un tenant huérfano sin nadie que pueda entrar.
    const usuario = await crearUsuarioService(
      {
        tenantId: tenant.id,
        nombre: input.adminNombre,
        email: input.adminEmail,
        password: input.adminPassword,
        rol: "admin",
      },
      client
    );

    await client.query("COMMIT");
    return { tenant, usuario: aPublico(usuario) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof AppError) throw err;
    logger.error({ err }, "Error al crear tenant con admin");
    throw new AppError(500, "No se pudo crear el tenant");
  } finally {
    client.release();
  }
}
