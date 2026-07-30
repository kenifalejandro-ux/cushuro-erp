/** src/server/shared/core/base.repository.ts
 *
 * Convención multi-tenant para repositorios (no es una clase base activa a
 * propósito): toda función que consulte una tabla de negocio recibe
 * `tenantId` como argumento explícito y lo incluye en el WHERE del SQL.
 *
 *   async findAll(tenantId: string) {
 *     const result = await pool.query(
 *       `SELECT * FROM repuestos WHERE tenant_id = $1 ORDER BY id DESC`,
 *       [tenantId]
 *     );
 *     return result.rows;
 *   }
 *
 * No hay inyección automática de tenant_id a propósito: así el SQL de cada
 * query queda explícito y una revisión de código detecta a simple vista un
 * SELECT/UPDATE/DELETE que se olvidó de filtrar por tenant — el error más
 * caro posible en un SaaS multi-cliente (datos de un cliente visibles a
 * otro) queda visible en el diff, no escondido en una capa de magia.
 *
 * El controller obtiene tenantId con `getTenantId(req)`
 * (src/server/shared/utils/request.ts), que lo lee de `req.tenantId` —
 * adjuntado por `tenantMiddleware` a partir del usuario ya verificado por
 * el JWT. Nunca leer tenantId del body/query del request.
 */

export {};
