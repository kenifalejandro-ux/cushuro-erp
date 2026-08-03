/** src/server/services/platformRateLimitCuota.ts
 *
 * Resuelve el techo de peticiones por minuto de un tenant, con caché.
 * Ver docs/architecture/cuotas-por-tenant.md.
 *
 * ── Dos capas, no tres ───────────────────────────────────────────────────
 *
 *   1. Override explícito en tenant_cuotas (recurso 'rate_limit_rpm').
 *   2. Fallback global: ERP_RATE_LIMIT_TENANT_DEFAULT.
 *
 * NO hay un nivel intermedio por plan ni una fórmula en vivo, y es una
 * decisión, no una omisión. Se evaluó `usuarios_activos * 100` y se
 * descartó por tres motivos concretos:
 *
 *   - Invertía los límites en tenants chicos: con 1 usuario activo daba 100
 *     req/min, POR DEBAJO del fusible personal de 120 — el techo de la
 *     empresa habría disparado antes que el de una sola persona, devolviendo
 *     además el mensaje equivocado.
 *   - Era un blanco móvil: el límite de un cliente cambiaba solo al activar
 *     o desactivar usuarios, sin que nadie tocara su configuración.
 *   - Metía un COUNT sobre `usuarios` (que tiene RLS, o sea conexión
 *     dedicada) justo en el camino que este caché existe para evitar.
 *
 * La fórmula sobrevive donde sí aporta: como SUGERENCIA en el panel (ver
 * sugerirRateLimitTenant), donde un humano decide con el tráfico real a la
 * vista y el número queda explícito, auditado y explicable.
 *
 * ── Por qué el caché va en Redis y no en memoria ─────────────────────────
 *
 * Con más de una instancia, un caché en memoria haría que cada una resuelva
 * su propio valor y que la invalidación NO se propague: cambiás el límite en
 * el panel y una instancia lo respeta y otra no. En Redis se resuelve solo, y
 * el costo marginal es casi nulo porque el rate limiter YA le pega a Redis
 * para el INCR del contador.
 *
 * Sin Redis se cae a un caché en memoria con TTL corto: peor (la
 * invalidación no cruza instancias y tarda hasta MEMORIA_TTL_MS), pero
 * evita pegarle a Postgres en cada request, que es lo inaceptable.
 */
import { pool, withTenant } from "../config/database";
import { env } from "../config/env";
import { getRedis } from "../config/redis";
import { logger } from "../config/logger";

export const RECURSO_RATE_LIMIT = "rate_limit_rpm";

const TTL_REDIS_SEGUNDOS = 300;
/** Mucho más corto que el de Redis a propósito: sin Redis la invalidación
 *  explícita no llega a las otras instancias, así que la única garantía de
 *  frescura es que el valor caduque pronto. */
const MEMORIA_TTL_MS = 30_000;

/** `null` = sin techo (el override guardó NULL, que en tenant_cuotas
 *  significa ilimitado). El fusible por usuario sigue aplicando igual. */
type LimiteRpm = number | null;

const memoria = new Map<string, { valor: LimiteRpm; expiraEn: number }>();

setInterval(() => {
  const ahora = Date.now();
  for (const [clave, entrada] of memoria) {
    if (ahora >= entrada.expiraEn) memoria.delete(clave);
  }
}, 60_000).unref();

function claveCache(tenantId: string): string {
  return `ratelimit-cuota:${tenantId}`;
}

/** Serialización explícita porque hay que poder distinguir tres cosas en
 *  Redis, que solo guarda strings: un número, "sin techo", y "no hay nada
 *  cacheado". Un `null` serializado como "" o "null" se confundiría con un
 *  miss. */
const SIN_TECHO = "ilimitado";

function serializar(valor: LimiteRpm): string {
  return valor === null ? SIN_TECHO : String(valor);
}

function deserializar(crudo: string): LimiteRpm {
  return crudo === SIN_TECHO ? null : Number(crudo);
}

/** Lee de la base, sin caché. La única fuente de verdad. */
async function resolverDesdeBase(tenantId: string): Promise<LimiteRpm> {
  const fila = await pool.query<{ limite: string | null }>(
    `SELECT limite FROM tenant_cuotas WHERE tenant_id = $1 AND recurso = $2`,
    [tenantId, RECURSO_RATE_LIMIT]
  );

  // Lo que decide es que EXISTA la fila, no que el valor sea distinto de
  // null: una fila con NULL significa "sin techo" a propósito, y tratarla
  // como ausencia la haría caer al fallback global — justo lo contrario de
  // lo que pidió quien la configuró.
  if (fila.rows.length === 0) return env.erpRateLimitTenantDefault;
  return fila.rows[0].limite === null ? null : Number(fila.rows[0].limite);
}

/** Techo de peticiones por minuto de este tenant. Pensada para el camino
 *  caliente: en el caso normal resuelve con un solo GET a Redis. */
export async function resolverRateLimitTenant(tenantId: string): Promise<LimiteRpm> {
  const clave = claveCache(tenantId);
  const redis = getRedis();

  if (redis) {
    try {
      const cacheado = await redis.get(clave);
      if (cacheado !== null) return deserializar(cacheado);

      const valor = await resolverDesdeBase(tenantId);
      await redis.set(clave, serializar(valor), "EX", TTL_REDIS_SEGUNDOS);
      return valor;
    } catch (err) {
      // Un fallo de Redis no puede tumbar el ERP: se sigue por memoria.
      logger.warn({ err, tenantId }, "Redis falló al resolver el rate limit del tenant, se usa caché en memoria");
    }
  }

  const enMemoria = memoria.get(clave);
  if (enMemoria && Date.now() < enMemoria.expiraEn) return enMemoria.valor;

  const valor = await resolverDesdeBase(tenantId);
  memoria.set(clave, { valor, expiraEn: Date.now() + MEMORIA_TTL_MS });
  return valor;
}

/** Se llama al guardar cuotas desde el panel. Sin esto, cambiar el límite no
 *  tendría efecto hasta que venciera el TTL — el admin lo cambiaría, no
 *  pasaría nada por 5 minutos, y volvería a cambiarlo pensando que falló.
 *
 *  El TTL igual se mantiene como red de seguridad: si esta invalidación se
 *  pierde (Redis caído justo en ese momento, o el valor cacheado en la
 *  memoria de OTRA instancia), el valor viejo caduca solo. */
export async function invalidarCacheRateLimit(tenantId: string): Promise<void> {
  memoria.delete(claveCache(tenantId));

  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(claveCache(tenantId));
  } catch (err) {
    logger.warn({ err, tenantId }, "No se pudo invalidar el caché del rate limit; caducará por TTL");
  }
}

export interface SugerenciaRateLimit {
  limiteSugeridoRpm: number;
  usuariosActivos: number;
  /** Pico de requests/minuto estimado a partir de las métricas horarias.
   *  `null` si el tenant todavía no tiene tráfico registrado. */
  picoRpmEstimado: number | null;
  motivo: string;
}

/** Cuántas veces por encima del promedio horario puede estar el minuto pico.
 *
 *  tenant_metricas_horarias agrega POR HORA, así que dividir por 60 da un
 *  promedio, no un pico: una ráfaga de cambio de turno (todos los operarios
 *  entrando a las 7:00) queda diluida entre los otros 59 minutos y se
 *  vuelve invisible. Este factor la vuelve a sacar a flote. Es una
 *  estimación, no una medición — por eso esto es una SUGERENCIA que un
 *  humano revisa, no un número que el sistema se aplique solo. */
const FACTOR_RAFAGA = 4;

/** Número sugerido para el panel, con los datos que lo justifican. No se
 *  aplica solo: alguien lo mira, lo ajusta si hace falta, y lo guarda. Así
 *  el límite queda explícito y explicable ("te pusimos 5.000 porque tu pico
 *  medido fue 3.240"), en vez de ser el resultado de una fórmula que cambia
 *  sola. */
export async function sugerirRateLimitTenant(tenantId: string): Promise<SugerenciaRateLimit> {
  const [usuarios, metricas] = await Promise.all([
    // usuarios tiene RLS (migración 0010): SIN app.tenant_id seteado la
    // policy evalúa ''::uuid y la query falla con "invalid input syntax for
    // type uuid". No alcanza con filtrar por tenant_id en el WHERE — hay que
    // abrir la transacción con withTenant(). Es el mismo tropiezo que
    // documenta el ADR-0001 y que ya se cometió antes en este código; el
    // costo de la conexión extra no importa acá porque esto corre desde el
    // panel, fuera del camino caliente.
    withTenant(tenantId, (client) =>
      client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM usuarios WHERE tenant_id = $1 AND activo = true`,
        [tenantId]
      )
    ),
    pool.query<{ pico: string | null }>(
      `SELECT max(requests_total)::text AS pico FROM tenant_metricas_horarias
       WHERE tenant_id = $1 AND hora >= now() - interval '30 days'`,
      [tenantId]
    ),
  ]);

  const usuariosActivos = Number(usuarios.rows[0].total);
  const picoHorario = metricas.rows[0].pico === null ? null : Number(metricas.rows[0].pico);
  const picoRpmEstimado = picoHorario === null ? null : Math.ceil((picoHorario / 60) * FACTOR_RAFAGA);

  // Tres candidatos; gana el mayor. Nunca por debajo del default global,
  // para no "sugerir" un recorte a un cliente que hoy anda bien.
  const porUsuarios = usuariosActivos * 100;
  const candidatos = [porUsuarios, picoRpmEstimado ?? 0, env.erpRateLimitTenantDefault];
  const limiteSugeridoRpm = Math.max(...candidatos);

  let motivo: string;
  if (limiteSugeridoRpm === env.erpRateLimitTenantDefault) {
    motivo = "El default global alcanza para el tamaño y el tráfico actual de este cliente.";
  } else if (picoRpmEstimado !== null && limiteSugeridoRpm === picoRpmEstimado) {
    motivo = `Basado en el tráfico real medido: pico de ${picoHorario} req/hora en los últimos 30 días, con margen para ráfagas (cambio de turno).`;
  } else {
    motivo = `Basado en ${usuariosActivos} usuarios activos (100 req/min por usuario).`;
  }

  return { limiteSugeridoRpm, usuariosActivos, picoRpmEstimado, motivo };
}
