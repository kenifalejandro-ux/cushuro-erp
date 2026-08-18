/** src/server/services/platformTipoCambio.service.ts
 *
 * Tipo de cambio USD → PEN, global de plataforma (migración 0053). Sin
 * RLS (igual que tenants/planes/tenant_cuotas), y sin `withTenant()`: no
 * es un dato por tenant, es un dato de mercado compartido por todos.
 *
 * APPEND-ONLY: nunca se hace UPDATE sobre una fila -- "el TC actual" es
 * la fila con `creado_en` más reciente. Cambiarlo es insertar una fila
 * nueva, nunca pisar la vieja -- eso da el historial de cambios gratis y
 * mantiene coherente cobros.tipo_cambio_aplicado (que sí queda fijo por
 * cobro, ver forzarCobroService): el TC "actual" puede seguir moviéndose
 * después sin que eso reescriba lo que ya se cobró.
 *
 * El override por suscripción (suscripciones.tipo_cambio_override) vive
 * en platformBilling.service.ts, no acá -- es un dato de la suscripción,
 * no de la plataforma.
 *
 * Fuente automática: BCRP (Banco Central de Reserva del Perú), serie
 * PD04638PD = "TC Interbancario (S/ por US$) - Venta", API pública sin
 * autenticación. Se eligió venta (no compra) porque es la convención
 * habitual al convertir un precio en USD a lo que se le cobra en soles a
 * un cliente (protege el margen del vendedor). Nota: para comprobantes
 * SUNAT reales la norma toma el tipo de cambio venta de la SBS, no del
 * BCRP -- pero acá no se emite comprobante (eso sigue siendo manual, ver
 * facturacion.ts), solo se calcula cuánto cobrarle a la tarjeta, así que
 * el interbancario del BCRP es una fuente razonable y siempre queda el
 * PUT manual como corrección si hace falta.
 */
import { pool } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";

const BCRP_SERIE_TC_VENTA = "PD04638PD";
const BCRP_BASE_URL = "https://estadisticas.bcrp.gob.pe/estadisticas/series/api";
// Ventana amplia a propósito: fines de semana/feriados el BCRP no publica
// ("n.d."), y el día de hoy suele no estar disponible todavía a la hora
// en que corre el cron -- se toma el último valor real dentro de la
// ventana, no necesariamente el de hoy.
const BCRP_VENTANA_DIAS = 10;

const CONTEXTO_JOB_BCRP: ContextoAuditoria = {
  ip: "internal",
  actorType: "system",
  actorLabel: "job-tipo-cambio-bcrp",
};

interface RespuestaBcrp {
  periods: Array<{ name: string; values: string[] }>;
}

type FetchBcrp = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

let fetchBcrp: FetchBcrp = (url) => fetch(url);

/** Solo para tests: evita depender de la red real. */
export function fijarFetchBcrpParaTests(fn: FetchBcrp | null): void {
  fetchBcrp = fn ?? ((url) => fetch(url));
}

/** El BCRP a veces pega un aviso de PHP (notice/warning, con HTML y todo)
 *  después del JSON válido -- visto en vivo el 2026-08-17 con una ventana
 *  que incluye el día de hoy. Rompe un JSON.parse estricto aunque el JSON
 *  en sí esté bien formado. La basura HTML siempre arranca con '<', que
 *  no aparece en ningún campo real de esta serie (nombres/fechas/valores
 *  son todos numéricos o texto plano) -- se corta ahí antes de parsear. */
function parsearRespuestaBcrp(textoCrudo: string): RespuestaBcrp {
  const indiceHtml = textoCrudo.indexOf("<");
  const texto = indiceHtml === -1 ? textoCrudo : textoCrudo.slice(0, indiceHtml).trimEnd();
  try {
    return JSON.parse(texto) as RespuestaBcrp;
  } catch {
    throw new AppError(502, "BCRP devolvió una respuesta que no se pudo interpretar como JSON");
  }
}

async function consultarUltimoValorBcrp(): Promise<number> {
  const hasta = new Date();
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - BCRP_VENTANA_DIAS);
  const formatear = (d: Date) => d.toISOString().slice(0, 10);
  const url = `${BCRP_BASE_URL}/${BCRP_SERIE_TC_VENTA}/json/${formatear(desde)}/${formatear(hasta)}/esp`;

  const res = await fetchBcrp(url);
  if (!res.ok) {
    throw new AppError(502, `BCRP respondió ${res.status} al consultar el tipo de cambio`);
  }
  const cuerpo = parsearRespuestaBcrp(await res.text());
  const ultimoValido = [...cuerpo.periods].reverse().find((p) => p.values[0] !== "n.d.");
  if (!ultimoValido) {
    throw new AppError(
      502,
      `BCRP no publicó ningún tipo de cambio en los últimos ${BCRP_VENTANA_DIAS} días`
    );
  }
  const valor = Number(ultimoValido.values[0]);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new AppError(
      502,
      `BCRP devolvió un valor de tipo de cambio inválido: ${ultimoValido.values[0]}`
    );
  }
  return Math.round(valor * 10000) / 10000; // columna es NUMERIC(10,4)
}

export interface TipoCambio {
  id: string;
  valor: number;
  creadoEn: string;
  creadoPor: string;
}

function aNumero(valor: string): number {
  return Number(valor);
}

/** La migración 0053 siembra una fila inicial -- si esto lanza es porque
 *  alguien borró todas las filas a mano, no un caso normal a manejar. */
export async function obtenerTipoCambioActualService(): Promise<TipoCambio> {
  const fila = await pool.query(
    `SELECT id, valor, creado_en AS "creadoEn", creado_por AS "creadoPor"
     FROM platform_tipo_cambio_usd_pen ORDER BY creado_en DESC LIMIT 1`
  );
  if (fila.rows.length === 0) {
    throw new AppError(500, "No hay tipo de cambio configurado (tabla vacía, ver migración 0053)");
  }
  return { ...fila.rows[0], valor: aNumero(fila.rows[0].valor) };
}

export async function actualizarTipoCambioService(
  valor: number,
  contexto: ContextoAuditoria
): Promise<TipoCambio> {
  const anterior = await obtenerTipoCambioActualService();

  const fila = await pool.query(
    `INSERT INTO platform_tipo_cambio_usd_pen (valor, creado_por)
     VALUES ($1, $2)
     RETURNING id, valor, creado_en AS "creadoEn", creado_por AS "creadoPor"`,
    [valor, contexto.actorLabel]
  );

  await registrarAuditoria({
    accion: "billing.actualizar_tipo_cambio",
    detalle: { before: anterior.valor, after: valor },
    contexto,
  });

  return { ...fila.rows[0], valor: aNumero(fila.rows[0].valor) };
}

/** Job diario (.github/workflows/scheduled-billing-tc-bcrp.yml, mismo
 *  patrón que el de vencimientos): consulta el BCRP y, si trae un valor
 *  válido, lo inserta como una fila nueva más -- reusa
 *  actualizarTipoCambioService(), así que queda auditado igual que un
 *  cambio manual, solo que con actorType "system". */
export async function actualizarTipoCambioDesdeBcrpService(): Promise<TipoCambio> {
  const valor = await consultarUltimoValorBcrp();
  return actualizarTipoCambioService(valor, CONTEXTO_JOB_BCRP);
}
