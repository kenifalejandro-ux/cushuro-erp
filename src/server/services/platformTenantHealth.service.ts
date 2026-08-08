/** src/server/services/platformTenantHealth.service.ts
 *
 * Observabilidad básica por tenant (migrations/0022_tenant_metricas_horarias.sql).
 * No es un sistema de métricas completo — es lo mínimo para que el panel
 * de plataforma pueda responder "¿este tenant está bien?" sin salir a un
 * Grafana/Prometheus que todavía no existe: usuarios activos, último
 * acceso, requests/errores/creación de recursos de las últimas 24h, y un
 * par de alertas mínimas por umbral fijo.
 *
 * registrarMetricaRequest() nunca lanza ni bloquea la respuesta real — se
 * llama desde tenantMetrics.middleware.ts después de que la respuesta ya
 * salió (`res.on("finish")`), puramente informativo.
 */
import { pool, withTenant } from "../config/database";
import { resumenCuotasTenant, type EstadoCuota } from "./platformCuotas.service";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";

export async function registrarMetricaRequest(params: {
  tenantId: string;
  statusCode: number;
  esCreacion: boolean;
  latenciaMs: number;
}): Promise<void> {
  try {
    const es5xx = params.statusCode >= 500 ? 1 : 0;
    const es4xx = params.statusCode >= 400 && params.statusCode < 500 ? 1 : 0;
    await pool.query(
      `INSERT INTO tenant_metricas_horarias
         (tenant_id, hora, requests_total, requests_error_5xx, requests_error_4xx, recursos_creados, latencia_total_ms)
       VALUES ($1, date_trunc('hour', now()), 1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, hora) DO UPDATE SET
         requests_total = tenant_metricas_horarias.requests_total + 1,
         requests_error_5xx = tenant_metricas_horarias.requests_error_5xx + $2,
         requests_error_4xx = tenant_metricas_horarias.requests_error_4xx + $3,
         recursos_creados = tenant_metricas_horarias.recursos_creados + $4,
         latencia_total_ms = tenant_metricas_horarias.latencia_total_ms + $5`,
      [params.tenantId, es5xx, es4xx, params.esCreacion ? 1 : 0, Math.round(params.latenciaMs)]
    );
  } catch (err) {
    logger.warn({ err }, "No se pudo registrar la métrica de request del tenant");
  }
}

export interface SaludTenant {
  tenantId: string;
  usuariosActivos: number;
  usuariosTotal: number;
  ultimoAcceso: string | null;
  requestsUltimas24h: number;
  errores5xxUltimas24h: number;
  errores4xxUltimas24h: number;
  tasaError: number;
  /** null si no hubo tráfico en las últimas 24h — evita disfrazar "sin
   *  datos" como "0ms de latencia", que se leería como una señal de que el
   *  tenant está sano. */
  latenciaPromedioMsUltimas24h: number | null;
  recursosCreadosUltimas24h: number;
  /** Uso vs. límite de cada recurso con cuota — ver
   *  docs/architecture/cuotas-por-tenant.md. Va en la salud y no en un
   *  endpoint aparte porque "¿este tenant está bien?" incluye "¿está por
   *  chocar contra un límite?": enterarse cuando ya se bloqueó es tarde. */
  cuotas: EstadoCuota[];
  alertas: string[];
}

// Umbrales fijos a propósito — "alertas mínimas", no un motor de reglas
// configurable. Si en algún momento hace falta ajustarlos por tenant, es
// una extensión de este mismo archivo, no un rediseño.
const UMBRAL_TASA_ERROR = 0.05; // 5%
const VOLUMEN_MINIMO_PARA_ALERTAR = 20; // no alertar con tráfico casi nulo (1 error de 2 requests = 50%, ruido)
const UMBRAL_RECURSOS_CREADOS_24H = 500;
// A partir de qué % de una cuota se avisa. 80% da margen para reaccionar
// (ampliar el límite, hablar con el cliente) antes de que empiece a
// rebotarle la creación de registros.
const UMBRAL_CUOTA_CERCA = 80;

async function calcularSalud(tenantId: string): Promise<SaludTenant> {
  // usuarios tiene RLS (migrations/0010_usuarios_rls.sql) — un pool.query()
  // directo, sin app.tenant_id seteado en esa conexión, choca contra la
  // política. withTenant() abre su propia conexión dedicada para esto,
  // convive bien dentro del mismo Promise.all que las otras dos queries
  // (que sí van por pool.query porque refresh_tokens/tenant_metricas_horarias
  // no tienen RLS).
  const [usuarios, ultimoAcceso, metricas, cuotas] = await Promise.all([
    withTenant(tenantId, (client) =>
      client.query(
        `SELECT count(*) FILTER (WHERE activo) AS activos, count(*) AS total FROM usuarios WHERE tenant_id = $1`,
        [tenantId]
      )
    ),
    pool.query(`SELECT max(creado_en) AS ultimo FROM refresh_tokens WHERE tenant_id = $1`, [
      tenantId,
    ]),
    pool.query(
      `SELECT COALESCE(sum(requests_total), 0) AS requests,
              COALESCE(sum(requests_error_5xx), 0) AS errores_5xx,
              COALESCE(sum(requests_error_4xx), 0) AS errores_4xx,
              COALESCE(sum(recursos_creados), 0) AS recursos,
              COALESCE(sum(latencia_total_ms), 0) AS latencia_total_ms
       FROM tenant_metricas_horarias
       WHERE tenant_id = $1 AND hora >= now() - interval '24 hours'`,
      [tenantId]
    ),
    resumenCuotasTenant(tenantId),
  ]);

  const requests = Number(metricas.rows[0].requests);
  const errores = Number(metricas.rows[0].errores_5xx);
  const errores4xx = Number(metricas.rows[0].errores_4xx);
  const recursos = Number(metricas.rows[0].recursos);
  const latenciaTotalMs = Number(metricas.rows[0].latencia_total_ms);
  const tasaError = requests > 0 ? errores / requests : 0;
  const latenciaPromedioMs = requests > 0 ? latenciaTotalMs / requests : null;

  const alertas: string[] = [];
  if (requests >= VOLUMEN_MINIMO_PARA_ALERTAR && tasaError > UMBRAL_TASA_ERROR) {
    alertas.push("alta_tasa_error_5xx");
  }
  if (recursos > UMBRAL_RECURSOS_CREADOS_24H) {
    alertas.push("creacion_anomala_de_recursos");
  }

  // Dos alertas distintas a propósito: "cerca" es una señal comercial (hay
  // que hablar con el cliente antes de que le moleste), "excedida" ya es
  // una operación bloqueada. Mezclarlas escondería la primera, que es
  // justamente la que se puede accionar a tiempo.
  if (cuotas.some((c) => c.excedido)) {
    alertas.push("cuota_excedida");
  } else if (cuotas.some((c) => c.porcentaje !== null && c.porcentaje >= UMBRAL_CUOTA_CERCA)) {
    alertas.push("cuota_cerca_del_limite");
  }

  return {
    tenantId,
    usuariosActivos: Number(usuarios.rows[0].activos),
    usuariosTotal: Number(usuarios.rows[0].total),
    ultimoAcceso: ultimoAcceso.rows[0].ultimo,
    requestsUltimas24h: requests,
    errores5xxUltimas24h: errores,
    errores4xxUltimas24h: errores4xx,
    tasaError,
    latenciaPromedioMsUltimas24h: latenciaPromedioMs,
    recursosCreadosUltimas24h: recursos,
    cuotas,
    alertas,
  };
}

export async function obtenerSaludTenantService(tenantId: string): Promise<SaludTenant> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) {
    throw new AppError(404, "Tenant no encontrado");
  }
  return calcularSalud(tenantId);
}

/** Resumen para el panel — uno por tenant. A este volumen (paneles de
 *  administración manejan decenas de tenants, no miles) un loop es más
 *  simple de leer que una query agregada gigante; si el número de tenants
 *  crece mucho, vale la pena revisar esto. */
export async function obtenerSaludTodosLosTenantsService(): Promise<SaludTenant[]> {
  const tenants = await pool.query(`SELECT id FROM tenants ORDER BY nombre`);
  return Promise.all(tenants.rows.map((t) => calcularSalud(t.id)));
}
