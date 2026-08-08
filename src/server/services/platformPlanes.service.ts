/** src/server/services/platformPlanes.service.ts
 *
 * Planes: segmentación de clientes por tamaño (MYPE, Pequeña, Mediana,
 * Corporativo). Un plan es un conjunto con nombre de límites por recurso —
 * el escalón intermedio entre el override puntual de un tenant y el default
 * global del registry. Ver migración 0034 y
 * docs/architecture/cuotas-por-tenant.md.
 *
 * Este archivo administra los planes y su asignación; quién resuelve el
 * límite efectivo (y aplica los tres niveles) sigue siendo
 * platformCuotas.service.ts. La separación importa: el enforcement no
 * necesita saber que existen los planes, solo pedir "cuál es el límite de
 * este tenant para este recurso".
 */
import { pool } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";

export interface Plan {
  id: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  activo: boolean;
  /** Menor a mayor por tamaño de empresa. Existe porque ni el nombre
   *  (alfabético) ni los límites (Corporativo los tiene en NULL) dan el
   *  orden correcto en un selector — ver migración 0035. */
  orden: number;
  /** recurso → límite. `null` = ilimitado en este plan. Un recurso ausente
   *  significa que el plan no opina y se cae al default del registry. */
  limites: Record<string, number | null>;
  creadoEn: string;
  actualizadoEn: string;
}

/** BIGINT vuelve como string desde node-pg — mismo caso que tamano_bytes en
 *  platformBackup.service.ts. Sin este Number() los límites serían strings y
 *  cualquier comparación numérica del enforcement fallaría en silencio. */
function aLimite(valor: string | null): number | null {
  return valor === null ? null : Number(valor);
}

async function limitesDePlanes(
  planIds: string[]
): Promise<Map<string, Record<string, number | null>>> {
  const porPlan = new Map<string, Record<string, number | null>>();
  if (planIds.length === 0) return porPlan;

  const filas = await pool.query<{ plan_id: string; recurso: string; limite: string | null }>(
    `SELECT plan_id, recurso, limite FROM plan_limites WHERE plan_id = ANY($1::uuid[])`,
    [planIds]
  );

  for (const fila of filas.rows) {
    if (!porPlan.has(fila.plan_id)) porPlan.set(fila.plan_id, {});
    porPlan.get(fila.plan_id)![fila.recurso] = aLimite(fila.limite);
  }
  return porPlan;
}

/** `soloActivos` para el selector del panel: un plan dado de baja no debe
 *  ofrecerse para asignar, pero sí seguir siendo visible en el listado
 *  completo (los tenants que ya lo tienen lo conservan — ver la migración). */
export async function listarPlanesService(soloActivos = false): Promise<Plan[]> {
  const filas = await pool.query(
    `SELECT id, codigo, nombre, descripcion, activo, orden,
            creado_en AS "creadoEn", actualizado_en AS "actualizadoEn"
     FROM planes ${soloActivos ? "WHERE activo = true" : ""}
     ORDER BY orden, nombre`
  );

  const limites = await limitesDePlanes(filas.rows.map((p) => p.id));
  return filas.rows.map((plan) => ({ ...plan, limites: limites.get(plan.id) ?? {} }));
}

/** Acepta el UUID o el `codigo` — el código es lo estable y legible para
 *  scripts y para el panel; el UUID, lo que viaja en tenants.plan_id. */
export async function obtenerPlanService(idOCodigo: string): Promise<Plan> {
  const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOCodigo);
  const filas = await pool.query(
    `SELECT id, codigo, nombre, descripcion, activo, orden,
            creado_en AS "creadoEn", actualizado_en AS "actualizadoEn"
     FROM planes WHERE ${esUuid ? "id = $1" : "codigo = $1"}`,
    [idOCodigo]
  );

  if (filas.rows.length === 0) throw new AppError(404, "Plan no encontrado");

  const limites = await limitesDePlanes([filas.rows[0].id]);
  return { ...filas.rows[0], limites: limites.get(filas.rows[0].id) ?? {} };
}

export interface PlanDeTenant {
  planId: string | null;
  codigo: string | null;
  nombre: string | null;
}

export async function obtenerPlanDeTenantService(tenantId: string): Promise<PlanDeTenant> {
  const filas = await pool.query(
    `SELECT t.plan_id AS "planId", p.codigo, p.nombre
     FROM tenants t LEFT JOIN planes p ON p.id = t.plan_id
     WHERE t.id = $1`,
    [tenantId]
  );
  if (filas.rows.length === 0) throw new AppError(404, "Tenant no encontrado");
  return filas.rows[0];
}

/** Asigna (o quita, con `null`) el plan de un tenant.
 *
 *  Nunca toca datos del cliente: subir de plan solo levanta topes, y bajar
 *  de plan puede dejarlo EXCEDIDO — en cuyo caso no se borra nada, solo se
 *  bloquea la creación de recursos nuevos hasta que baje volumen o vuelva a
 *  subir. Es la misma regla que ya rige las cuotas (ver
 *  platformCuotas.service.ts), y la que hace que cambiar de plan sea una
 *  operación segura y reversible.
 *
 *  Devuelve qué recursos quedan excedidos con el plan nuevo, para que el
 *  panel pueda advertirlo EN EL MOMENTO en vez de que aparezca después como
 *  creaciones rechazadas sin explicación. */
export async function asignarPlanATenantService(
  tenantId: string,
  codigoOId: string | null,
  contexto: ContextoAuditoria,
  motivo?: string
): Promise<{ plan: PlanDeTenant; recursosExcedidos: string[] }> {
  const anterior = await obtenerPlanDeTenantService(tenantId);

  let planId: string | null = null;
  if (codigoOId !== null) {
    const plan = await obtenerPlanService(codigoOId);
    if (!plan.activo) {
      // Un plan dado de baja no se puede asignar a nadie nuevo, pero los
      // tenants que ya lo tienen lo conservan (ver la migración 0034).
      throw new AppError(400, `El plan "${plan.codigo}" está desactivado y no puede asignarse`);
    }
    planId = plan.id;
  }

  await pool.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [planId, tenantId]);

  // Import diferido: platformCuotas importa este módulo para resolver el
  // nivel 2, así que un import estático de vuelta cerraría el ciclo.
  const { resumenCuotasTenant, invalidarCacheLimitesTenant } =
    await import("./platformCuotas.service");

  // Sin esto, resolverLimite() seguiría devolviendo el límite del plan
  // VIEJO hasta que venza el TTL del caché (ver platformCuotas.service.ts)
  // — el resumen de abajo mostraría los límites nuevos, pero el próximo
  // POST del tenant todavía chocaría contra los viejos.
  await invalidarCacheLimitesTenant(tenantId);

  // Se calcula DESPUÉS de invalidar, para que refleje los límites nuevos.
  const recursosExcedidos = (await resumenCuotasTenant(tenantId))
    .filter((c) => c.excedido)
    .map((c) => c.recurso);

  const nuevo = await obtenerPlanDeTenantService(tenantId);

  await registrarAuditoria({
    accion: "asignar_plan_tenant",
    tenantId,
    detalle: {
      before: { planId: anterior.planId, codigo: anterior.codigo },
      after: { planId: nuevo.planId, codigo: nuevo.codigo },
      motivo: motivo ?? null,
      // Queda registrado si el cambio dejó al cliente excedido: es
      // justamente lo que alguien va a querer reconstruir después si el
      // cliente reclama que "dejó de poder cargar cosas".
      recursosExcedidos,
    },
    contexto,
  });

  return { plan: nuevo, recursosExcedidos };
}
