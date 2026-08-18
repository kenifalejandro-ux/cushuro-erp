/** src/server/services/platformBilling.service.ts
 *
 * Dominio de suscripciones/cobros (migración 0041_billing.sql). Mismo
 * estilo que platform.service.ts/platformPlanes.service.ts: `pool`
 * directo -- estas tablas NO tienen RLS (ver el comentario de la
 * migración), así que nada de withTenant() acá.
 *
 * `suscripciones.plan_id` (precio/billing) y `tenants.plan_id` (cuotas,
 * ver platformPlanes.service.ts) son columnas DISTINTAS que gobiernan
 * cosas distintas. Para que nunca diverjan (un tenant con cuotas de
 * Corporativo pagando MYPE, o viceversa), toda función de acá que cambie
 * el plan de la suscripción llama también a asignarPlanATenantService en
 * la misma operación -- son un solo concepto de negocio ("qué plan tiene
 * este cliente"), aunque vivan en dos filas.
 */
import { randomUUID } from "crypto";
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { AppError } from "../shared/middlewares/error.middleware";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import { obtenerPlanService, asignarPlanATenantService } from "./platformPlanes.service";
import { cambiarEstadoTenantService } from "./platform.service";
import { obtenerPasarelaPago, type EventoWebhookVerificado, type Moneda } from "./pasarelaPago";
import { obtenerTipoCambioActualService } from "./platformTipoCambio.service";

export type EstadoSuscripcion = "trialing" | "activa" | "en_gracia" | "suspendida" | "cancelada";
export type CicloSuscripcion = "mensual" | "anual";
export type MetodoFacturacion = "tarjeta" | "transferencia";

export interface Suscripcion {
  id: string;
  tenantId: string;
  planId: string;
  planCodigo: string;
  planNombre: string;
  estado: EstadoSuscripcion;
  ciclo: CicloSuscripcion;
  metodoFacturacion: MetodoFacturacion;
  precioReferencia: number;
  // Excepción puntual (cliente con tasa pactada fija) -- NULL = usa el TC
  // global de plataforma (ver platformTipoCambio.service.ts). Solo aplica
  // cuando metodoFacturacion es 'tarjeta' (transferencia siempre cobra en
  // USD, no hay conversión de por medio).
  tipoCambioOverride: number | null;
  trialTerminaEn: string | null;
  periodoActualInicio: string;
  periodoActualFin: string;
  graciaTerminaEn: string | null;
  canceladaEn: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

export interface MetodoPago {
  id: string;
  pasarela: string;
  marca: string | null;
  ultimos4: string | null;
  venceMes: number | null;
  venceAnio: number | null;
  esDefault: boolean;
}

export interface Cobro {
  id: string;
  tipo: "suscripcion" | "implementacion";
  descripcion: string | null;
  moneda: Moneda;
  monto: number;
  // Acumulado recibido hasta ahora -- 0 hasta el primer pago parcial.
  // `estado='exitoso'` siempre implica `montoPagado === monto` (lo hace
  // cumplir registrarPagoCobroService, no la columna). El saldo pendiente
  // es `monto - montoPagado`, calculado por quien lo consuma.
  montoPagado: number;
  estado: "pendiente" | "exitoso" | "fallido";
  motivoFallo: string | null;
  intentoNumero: number;
  // Cuándo corresponde este cobro -- NULL en cobros de implementación sin
  // fecha pactada y en filas viejas que ya estaban resueltas antes de que
  // existiera esta columna (migración 0054). "Vencido" se calcula, no se
  // guarda: estado='pendiente' && fechaVencimiento < ahora.
  fechaVencimiento: string | null;
  // Cuándo pasó el pago realmente -- distinto de `creadoEn` (cuándo se
  // cargó el registro). Solo se usa hoy para tipo='implementacion', ver
  // registrarCobroImplementacionService/editarCobroService. NULL en
  // cobros de suscripción (su creadoEn ya es preciso) y en filas viejas
  // de antes de la migración 0056.
  fechaPago: string | null;
  // Solo se completa en cobros de implementación en PEN (ver
  // registrarCobroImplementacionService) o en cobros de suscripción por
  // tarjeta (ver intentarCobroTarjeta) -- el TC efectivamente aplicado.
  tipoCambioAplicado: number | null;
  creadoEn: string;
}

export interface EstadoBilling {
  // `null` = el tenant todavía no tiene suscripción -- pero puede tener
  // igual cobros de implementación (ver registrarCobroImplementacionService),
  // que se cobran ANTES de que exista la suscripción (0041_billing.sql).
  // Por eso este objeto siempre existe si el tenant existe: "sin
  // suscripción" y "sin cobros" son cosas distintas.
  suscripcion: Suscripcion | null;
  metodoPago: MetodoPago | null;
  cobrosRecientes: Cobro[];
}

const LIMITE_COBROS_RECIENTES = 10;

// NUMERIC vuelve como string desde node-pg -- mismo caso que los límites de
// planes en platformPlanes.service.ts. Sin este Number() cualquier
// comparación/aritmética (ej. tipo de cambio) fallaría en silencio.
function aNumero(valor: string | null): number {
  return valor === null ? 0 : Number(valor);
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function tenantExiste(tenantId: string): Promise<void> {
  const tenant = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [tenantId]);
  if (tenant.rows.length === 0) throw new AppError(404, "Tenant no encontrado");
}

/** Precio de lista del plan para el ciclo pedido -- columnas agregadas a
 *  `planes` por 0041_billing.sql, no expuestas por platformPlanes.service.ts
 *  (ese Plan es sobre cuotas, no sobre precio). `ciclo` es un union type de
 *  dos valores fijos, así que elegir la columna con una expresión JS (no
 *  interpolando el nombre de columna en el SQL) es seguro. */
async function precioListaDelPlan(planId: string, ciclo: CicloSuscripcion): Promise<number> {
  const fila = await pool.query(
    `SELECT precio_mensual_referencia AS mensual, precio_anual_referencia AS anual
     FROM planes WHERE id = $1`,
    [planId]
  );
  const precio = ciclo === "mensual" ? fila.rows[0]?.mensual : fila.rows[0]?.anual;
  if (precio === null || precio === undefined) {
    throw new AppError(
      400,
      `El plan no tiene precio de lista (${ciclo}) cargado -- hay que fijar precioReferencia a mano`
    );
  }
  return aNumero(precio);
}

export async function obtenerSuscripcionTenantService(tenantId: string): Promise<EstadoBilling> {
  await tenantExiste(tenantId);

  const filaSuscripcion = await pool.query(
    `SELECT s.id, s.tenant_id AS "tenantId", s.plan_id AS "planId", p.codigo AS "planCodigo",
            p.nombre AS "planNombre", s.estado, s.ciclo, s.metodo_facturacion AS "metodoFacturacion",
            s.precio_referencia AS "precioReferencia", s.tipo_cambio_override AS "tipoCambioOverride",
            s.trial_termina_en AS "trialTerminaEn",
            s.periodo_actual_inicio AS "periodoActualInicio", s.periodo_actual_fin AS "periodoActualFin",
            s.gracia_termina_en AS "graciaTerminaEn", s.cancelada_en AS "canceladaEn",
            s.creado_en AS "creadoEn", s.actualizado_en AS "actualizadoEn"
     FROM suscripciones s JOIN planes p ON p.id = s.plan_id
     WHERE s.tenant_id = $1`,
    [tenantId]
  );
  const suscripcion: Suscripcion | null = filaSuscripcion.rows[0]
    ? {
        ...filaSuscripcion.rows[0],
        precioReferencia: aNumero(filaSuscripcion.rows[0].precioReferencia),
        tipoCambioOverride:
          filaSuscripcion.rows[0].tipoCambioOverride === null
            ? null
            : aNumero(filaSuscripcion.rows[0].tipoCambioOverride),
      }
    : null;

  // Solo tiene sentido mostrar la tarjeta guardada si la suscripción
  // factura por 'tarjeta' -- si es 'transferencia' (o no hay suscripción),
  // esa tarjeta no se usa para cobrar nada, aunque exista la fila (puede
  // quedar de una prueba vieja, o de un metodo_facturacion anterior).
  // Mostrarla igual sugiere falsamente "así se te va a cobrar".
  //
  // `pasarela != 'stub'` además: una tarjeta creada por
  // crearMetodoPagoPruebaService es una herramienta de testing interna
  // (para poder probar forzarCobroService sin checkout real todavía), no
  // algo que el tenant registró -- no debe aparecer acá como si fuera
  // real. Sigue funcionando por dentro para "Forzar cobro" (esa función
  // consulta metodos_pago directo, no pasa por este campo de lectura); lo
  // único que cambia es qué se le MUESTRA al admin en este panel.
  const metodoPago: MetodoPago | null =
    suscripcion?.metodoFacturacion === "tarjeta"
      ? ((
          await pool.query(
            `SELECT id, pasarela, marca, ultimos4, vence_mes AS "venceMes", vence_anio AS "venceAnio",
                    es_default AS "esDefault"
             FROM metodos_pago WHERE tenant_id = $1 AND es_default = true AND pasarela != 'stub' LIMIT 1`,
            [tenantId]
          )
        ).rows[0] ?? null)
      : null;

  // Sin filtrar por suscripcion_id a propósito: los cobros de implementación
  // (tipo='implementacion') pueden existir sin ninguna suscripción, y deben
  // seguir viéndose acá aunque `suscripcion` sea null.
  const filasCobros = await pool.query(
    `SELECT id, tipo, descripcion, moneda, monto, monto_pagado AS "montoPagado", estado,
            motivo_fallo AS "motivoFallo", intento_numero AS "intentoNumero",
            fecha_vencimiento AS "fechaVencimiento", fecha_pago AS "fechaPago",
            tipo_cambio_aplicado AS "tipoCambioAplicado", creado_en AS "creadoEn"
     FROM cobros WHERE tenant_id = $1 ORDER BY creado_en DESC LIMIT $2`,
    [tenantId, LIMITE_COBROS_RECIENTES]
  );
  const cobrosRecientes: Cobro[] = filasCobros.rows.map((c) => ({
    ...c,
    monto: aNumero(c.monto),
    montoPagado: aNumero(c.montoPagado),
    tipoCambioAplicado: c.tipoCambioAplicado === null ? null : aNumero(c.tipoCambioAplicado),
  }));

  return { suscripcion, metodoPago, cobrosRecientes };
}

async function requerirSuscripcion(
  tenantId: string
): Promise<EstadoBilling & { suscripcion: Suscripcion }> {
  const actual = await obtenerSuscripcionTenantService(tenantId);
  if (!actual.suscripcion) throw new AppError(404, "El tenant no tiene suscripción todavía");
  return actual as EstadoBilling & { suscripcion: Suscripcion };
}

export interface CrearSuscripcionInput {
  plan: string; // código o UUID, ver obtenerPlanService
  ciclo: CicloSuscripcion;
  metodoFacturacion: MetodoFacturacion;
  precioReferencia?: number;
  // Exoneración comercial negociada (no un trial de producto, ver el
  // schema) -- en MESES calendario, no días, para calzar con cómo se
  // negocia ("le exonero 6 meses") y evitar el redondeo de aproximar un
  // mes a 30 días.
  trialMeses?: number;
  // Tasa pactada fija para ESTE cliente -- excepción, no la norma. Ausente
  // = usa el TC global de plataforma en cada cobro (ver
  // platformTipoCambio.service.ts). Solo tiene sentido con
  // metodoFacturacion 'tarjeta' (transferencia no convierte moneda).
  tipoCambioOverride?: number;
}

export async function crearSuscripcionService(
  tenantId: string,
  input: CrearSuscripcionInput,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  await tenantExiste(tenantId);

  const existente = await pool.query(`SELECT id FROM suscripciones WHERE tenant_id = $1`, [
    tenantId,
  ]);
  if (existente.rows.length > 0) {
    throw new AppError(409, "El tenant ya tiene una suscripción -- usar cambiar plan / reactivar");
  }

  if (input.tipoCambioOverride !== undefined && input.metodoFacturacion !== "tarjeta") {
    throw new AppError(
      400,
      "El tipo de cambio solo aplica a suscripciones que facturan por tarjeta"
    );
  }

  const plan = await obtenerPlanService(input.plan);
  const precioReferencia =
    input.precioReferencia ?? (await precioListaDelPlan(plan.id, input.ciclo));
  const trialMeses = input.trialMeses ?? 0;
  const estadoInicial: EstadoSuscripcion = trialMeses > 0 ? "trialing" : "activa";
  const mesesPeriodo = input.ciclo === "mensual" ? 1 : 12;
  const tipoCambioOverride = input.tipoCambioOverride ?? null;

  await pool.query(
    `INSERT INTO suscripciones
       (tenant_id, plan_id, estado, ciclo, metodo_facturacion, precio_referencia,
        tipo_cambio_override, trial_termina_en, periodo_actual_inicio, periodo_actual_fin)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $8::int > 0 THEN now() + make_interval(months => $8::int) ELSE NULL END,
             now(),
             CASE WHEN $8::int > 0 THEN now() + make_interval(months => $8::int)
                  ELSE now() + make_interval(months => $9::int) END)`,
    [
      tenantId,
      plan.id,
      estadoInicial,
      input.ciclo,
      input.metodoFacturacion,
      precioReferencia,
      tipoCambioOverride,
      trialMeses,
      mesesPeriodo,
    ]
  );

  // Mismo plan para cuotas y billing -- ver el comentario del encabezado.
  await asignarPlanATenantService(tenantId, plan.codigo, contexto, "Alta de suscripción");

  await registrarAuditoria({
    accion: "billing.crear_suscripcion",
    tenantId,
    detalle: {
      plan: plan.codigo,
      ciclo: input.ciclo,
      metodoFacturacion: input.metodoFacturacion,
      precioReferencia,
      trialMeses,
      tipoCambioOverride,
    },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

/** Recalcula el arranque de la cortesía desde HOY -- para cuando la
 *  suscripción se da de alta antes de que el tenant esté operando de
 *  verdad (ej. mientras se negocia o se prepara la implementación) y el
 *  reloj de la exoneración no debe correr hasta el lanzamiento real a
 *  producción. `trialMeses` se vuelve a pasar acá (no se persiste la
 *  duración original, solo la fecha de fin resultante) -- lo normal es
 *  que sea el mismo valor negociado al dar de alta, pero nada impide
 *  ajustarlo si la negociación cambió mientras tanto. */
export async function iniciarCortesiaService(
  tenantId: string,
  trialMeses: number,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  if (actual.suscripcion.estado !== "trialing") {
    throw new AppError(
      400,
      `Solo se puede iniciar la cortesía desde el estado "trialing" (actual: "${actual.suscripcion.estado}")`
    );
  }

  await pool.query(
    `UPDATE suscripciones
     SET periodo_actual_inicio = now(),
         trial_termina_en = now() + make_interval(months => $1),
         periodo_actual_fin = now() + make_interval(months => $1),
         actualizado_en = now()
     WHERE tenant_id = $2`,
    [trialMeses, tenantId]
  );

  await registrarAuditoria({
    accion: "billing.iniciar_cortesia",
    tenantId,
    detalle: { trialMeses, trialTerminaEnAnterior: actual.suscripcion.trialTerminaEn },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

/** El paso que le faltaba a "Iniciar cortesía desde hoy": ese solo
 *  extiende la cortesía, nunca hay una acción que diga "esto ya arranca
 *  de verdad". Sin esto, el único ancla de `periodo_actual_inicio` era
 *  `crearSuscripcionService` (el momento del alta) -- si el alta se hizo
 *  antes de que el tenant esté realmente en producción (ej. probando el
 *  sistema, negociando términos), el "próximo cobro" mostraba una fecha
 *  sin sentido real. Esto resetea el período a partir de HOY, en el
 *  momento que el admin decide que corresponde -- desacoplado de cuándo
 *  se cargó el registro. Sirve tanto para salir de `trialing` (cortesía
 *  terminada, arranca la facturación real) como para corregir una
 *  suscripción que ya estaba `activa` pero con la fecha mal anclada. */
export async function iniciarFacturacionService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  if (!["trialing", "activa"].includes(actual.suscripcion.estado)) {
    throw new AppError(
      400,
      `Solo se puede iniciar la facturación desde "trialing" o "activa" (actual: "${actual.suscripcion.estado}")`
    );
  }

  const mesesPeriodo = actual.suscripcion.ciclo === "mensual" ? 1 : 12;

  await pool.query(
    `UPDATE suscripciones
     SET estado = 'activa',
         trial_termina_en = NULL,
         periodo_actual_inicio = now(),
         periodo_actual_fin = now() + make_interval(months => $1),
         gracia_termina_en = NULL,
         actualizado_en = now()
     WHERE tenant_id = $2`,
    [mesesPeriodo, tenantId]
  );

  await registrarAuditoria({
    accion: "billing.iniciar_facturacion",
    tenantId,
    detalle: {
      estadoAnterior: actual.suscripcion.estado,
      periodoActualFinAnterior: actual.suscripcion.periodoActualFin,
    },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

export async function cambiarPlanSuscripcionService(
  tenantId: string,
  planCodigoOId: string,
  precioReferencia: number | undefined,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  const plan = await obtenerPlanService(planCodigoOId);
  const nuevoPrecio =
    precioReferencia ?? (await precioListaDelPlan(plan.id, actual.suscripcion.ciclo));

  await pool.query(
    `UPDATE suscripciones SET plan_id = $1, precio_referencia = $2, actualizado_en = now() WHERE tenant_id = $3`,
    [plan.id, nuevoPrecio, tenantId]
  );

  await asignarPlanATenantService(tenantId, plan.codigo, contexto, motivo);

  await registrarAuditoria({
    accion: "billing.cambiar_plan",
    tenantId,
    detalle: {
      before: {
        plan: actual.suscripcion.planCodigo,
        precioReferencia: actual.suscripcion.precioReferencia,
      },
      after: { plan: plan.codigo, precioReferencia: nuevoPrecio },
      motivo: motivo ?? null,
    },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

/** Fija (o quita, con `null`) la tasa pactada fija de ESTA suscripción --
 *  excepción puntual, no la norma. `null` vuelve a usar el TC global de
 *  plataforma en el próximo cobro (ver platformTipoCambio.service.ts). No
 *  toca cobros pasados: cobros.tipo_cambio_aplicado ya quedó grabado con
 *  la tasa que se usó en su momento, esto solo cambia qué tasa se va a
 *  usar de acá para adelante. */
export async function actualizarTipoCambioOverrideSuscripcionService(
  tenantId: string,
  valor: number | null,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  if (actual.suscripcion.metodoFacturacion !== "tarjeta") {
    throw new AppError(
      400,
      "El tipo de cambio solo aplica a suscripciones que facturan por tarjeta"
    );
  }

  await pool.query(
    `UPDATE suscripciones SET tipo_cambio_override = $1, actualizado_en = now() WHERE tenant_id = $2`,
    [valor, tenantId]
  );

  await registrarAuditoria({
    accion: "billing.actualizar_tipo_cambio_override",
    tenantId,
    detalle: { before: actual.suscripcion.tipoCambioOverride, after: valor },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

export async function extenderGraciaService(
  tenantId: string,
  dias: number,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  if (actual.suscripcion.estado !== "en_gracia" && actual.suscripcion.estado !== "suspendida") {
    throw new AppError(
      400,
      `No se puede extender gracia desde el estado "${actual.suscripcion.estado}"`
    );
  }

  await pool.query(
    `UPDATE suscripciones
     SET estado = 'en_gracia',
         gracia_termina_en = GREATEST(COALESCE(gracia_termina_en, now()), now()) + make_interval(days => $1),
         actualizado_en = now()
     WHERE tenant_id = $2`,
    [dias, tenantId]
  );

  if (actual.suscripcion.estado === "suspendida") {
    await cambiarEstadoTenantService(
      tenantId,
      true,
      motivo ?? "Se extendió el período de gracia",
      contexto
    );
  }

  await registrarAuditoria({
    accion: "billing.extender_gracia",
    tenantId,
    detalle: { dias, before: actual.suscripcion.estado, motivo: motivo ?? null },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

export async function cancelarSuscripcionService(
  tenantId: string,
  motivo: string | undefined,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  if (actual.suscripcion.estado === "cancelada") {
    throw new AppError(400, "La suscripción ya está cancelada");
  }

  await pool.query(
    `UPDATE suscripciones SET estado = 'cancelada', cancelada_en = now(), actualizado_en = now() WHERE tenant_id = $1`,
    [tenantId]
  );

  await registrarAuditoria({
    accion: "billing.cancelar_suscripcion",
    tenantId,
    detalle: { before: actual.suscripcion.estado, motivo: motivo ?? null },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

/** Borra la suscripción por completo (a diferencia de cancelar, que solo
 *  cambia el estado) -- pensado para corregir una alta mal hecha (plan
 *  equivocado, precio de prueba) y volver al tenant al estado "todavía sin
 *  suscripción", no para el ciclo de vida normal de un cliente real (eso es
 *  cancelar/reactivar). Nunca borra `cobros`: son registro contable (ver
 *  0041_billing.sql) -- se les suelta la referencia (`suscripcion_id =
 *  NULL`) para poder borrar la fila de `suscripciones` sin violar la FK,
 *  y quedan huérfanos pero intactos. `metodos_pago` tampoco se toca: está
 *  atado al tenant, no a esta suscripción puntual, y sirve para la
 *  próxima alta. No toca `tenants.plan_id` -- las cuotas son una decisión
 *  operativa aparte, borrar la suscripción no debería devolverle de
 *  golpe los límites del registry a un tenant con datos reales cargados. */
export async function eliminarSuscripcionService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<void> {
  const actual = await requerirSuscripcion(tenantId);

  await pool.query(`UPDATE cobros SET suscripcion_id = NULL WHERE suscripcion_id = $1`, [
    actual.suscripcion.id,
  ]);
  await pool.query(`DELETE FROM suscripciones WHERE id = $1`, [actual.suscripcion.id]);

  await registrarAuditoria({
    accion: "billing.eliminar_suscripcion",
    tenantId,
    detalle: {
      suscripcionId: actual.suscripcion.id,
      estadoAlEliminar: actual.suscripcion.estado,
      planCodigo: actual.suscripcion.planCodigo,
    },
    contexto,
  });
}

export async function reactivarSuscripcionService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  const estadosReactivables: EstadoSuscripcion[] = ["cancelada", "suspendida", "en_gracia"];
  if (!estadosReactivables.includes(actual.suscripcion.estado)) {
    throw new AppError(400, `No se puede reactivar desde el estado "${actual.suscripcion.estado}"`);
  }

  const mesesPeriodo = actual.suscripcion.ciclo === "mensual" ? 1 : 12;
  await pool.query(
    `UPDATE suscripciones
     SET estado = 'activa',
         periodo_actual_inicio = now(),
         periodo_actual_fin = now() + make_interval(months => $1),
         gracia_termina_en = NULL,
         cancelada_en = NULL,
         actualizado_en = now()
     WHERE tenant_id = $2`,
    [mesesPeriodo, tenantId]
  );

  if (actual.suscripcion.estado === "suspendida") {
    await cambiarEstadoTenantService(tenantId, true, "Reactivación de suscripción", contexto);
  }

  await registrarAuditoria({
    accion: "billing.reactivar_suscripcion",
    tenantId,
    detalle: { before: actual.suscripcion.estado },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

export interface RegistrarCobroImplementacionInput {
  monto: number;
  moneda: Moneda;
  descripcion?: string;
  // 'exitoso' (default) = ya se cobró (transferencia/efectivo confirmado a
  // mano). 'pendiente' = cuota pactada pero todavía no cobrada (ej. saldo
  // que se paga cuando el tenant arranca en producción) -- se cierra
  // después con marcarCobroImplementacionPagadoService. Ver el comentario
  // de 0041_billing.sql: "puede partirse en varias filas (adelanto/saldo)".
  estado?: "pendiente" | "exitoso";
  // Cuándo pasó el pago (YYYY-MM-DD) -- default hoy si no se manda. Ver
  // el comentario de la migración 0056: `creado_en` es cuándo se CARGÓ el
  // registro, no cuándo pasó el pago (pueden ser días distintos).
  fecha?: string;
  // Requerido si moneda='PEN' (no hay pasarela que lo calcule sola acá,
  // a diferencia de un cobro de suscripción por tarjeta -- si no se sabe
  // el TC pactado en el momento, no se puede cargar en PEN todavía).
  // Rechazado si moneda='USD' (no hay conversión de por medio).
  tipoCambioAplicado?: number;
}

/** Cobro único de puesta en marcha (ej. USD 10,000 de implementación),
 *  independiente de la suscripción mensual/anual -- ver el comentario de
 *  0041_billing.sql: `cobros.suscripcion_id` es NULLABLE justamente porque
 *  esto puede cobrarse ANTES de que exista una suscripción (un cliente
 *  puede pagar la implementación y recién arrancar la suscripción -- o la
 *  cortesía negociada -- después). Si ya existe una suscripción se linkea
 *  como referencia, pero no es requisito.
 *
 *  Con estado 'exitoso' (default): igual que forzarCobroService con
 *  transferencia, se registra directo sin pasar por la pasarela -- el
 *  admin que lo carga ES la fuente de verdad de que la plata entró. Con
 *  'pendiente': registra la cuota pactada sin confirmar el cobro todavía
 *  (adelanto ya cobrado + saldo pendiente, por ejemplo). */
export async function registrarCobroImplementacionService(
  tenantId: string,
  input: RegistrarCobroImplementacionInput,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  await tenantExiste(tenantId);

  if (input.moneda === "PEN" && input.tipoCambioAplicado === undefined) {
    throw new AppError(
      400,
      "El tipo de cambio es obligatorio para cobros de implementación en PEN -- no hay pasarela que lo calcule sola, hay que cargar el que se pactó"
    );
  }
  if (input.moneda === "USD" && input.tipoCambioAplicado !== undefined) {
    throw new AppError(400, "El tipo de cambio solo aplica a cobros en PEN");
  }

  const estado = input.estado ?? "exitoso";
  // La fecha del PAGO no existe todavía en un cobro 'pendiente' -- no hay
  // forma honesta de contestar "¿cuándo se cobró?" sobre algo que todavía
  // no se cobró. Se completa recién cuando se registre el pago de verdad
  // (ver registrarPagoCobroService), no acá.
  if (estado === "pendiente" && input.fecha !== undefined) {
    throw new AppError(
      400,
      "La fecha del pago no aplica todavía a un cobro 'pendiente' -- se completa al registrar el pago"
    );
  }

  const suscripcionExistente = await pool.query(
    `SELECT id FROM suscripciones WHERE tenant_id = $1`,
    [tenantId]
  );
  const suscripcionId: string | null = suscripcionExistente.rows[0]?.id ?? null;
  const tipoCambioAplicado = input.tipoCambioAplicado ?? null;
  const fechaPago = estado === "exitoso" ? (input.fecha ?? hoyISO()) : null;

  const cobro = await pool.query(
    `INSERT INTO cobros
       (tenant_id, suscripcion_id, tipo, moneda, monto, estado, descripcion, fecha_pago, tipo_cambio_aplicado)
     VALUES ($1, $2, 'implementacion', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      suscripcionId,
      input.moneda,
      input.monto,
      estado,
      input.descripcion ?? null,
      fechaPago,
      tipoCambioAplicado,
    ]
  );

  await registrarAuditoria({
    accion: "billing.registrar_cobro_implementacion",
    tenantId,
    detalle: {
      cobroId: cobro.rows[0].id,
      monto: input.monto,
      moneda: input.moneda,
      descripcion: input.descripcion ?? null,
      estado,
      suscripcionId,
      fecha: fechaPago,
      tipoCambioAplicado,
    },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

interface ResultadoAplicarPagoCobro {
  tipo: "suscripcion" | "implementacion";
  monto: number;
  saldoAntes: number;
  saldoDespues: number;
}

/** Núcleo compartido de "registrar un pago sobre un cobro pendiente" -- NO
 *  audita (cada llamador tiene su propia acción/detalle, ver abajo). Suma
 *  `montoAPagar` al acumulado; si cubre el `monto` total pasa a 'exitoso',
 *  si no queda 'pendiente' con el saldo restante. 400 si el cobro no
 *  existe, no está 'pendiente', o si `montoAPagar` no es positivo o supera
 *  el saldo (evita que quede `monto_pagado > monto`, que además el CHECK
 *  de la migración 0054 rechazaría a nivel de base -- acá se valida antes
 *  para poder devolver un mensaje útil con el máximo permitido). */
async function aplicarPagoCobro(
  tenantId: string,
  cobroId: string,
  montoAPagar: number,
  // Cuándo pasó ESTE pago -- recién acá tiene sentido completar
  // `fecha_pago` (en registrarCobroImplementacionService un 'pendiente'
  // no puede traer fecha, justamente porque el pago todavía no pasó).
  // Default hoy si no se manda. Con pagos parciales en fechas distintas,
  // el último pago pisa la fecha del anterior -- no hay una fecha "por
  // cuota", es una simplificación consciente.
  fecha: string | undefined
): Promise<ResultadoAplicarPagoCobro> {
  const actual = await pool.query(
    `SELECT estado, tipo, monto, monto_pagado AS "montoPagado" FROM cobros WHERE id = $1 AND tenant_id = $2`,
    [cobroId, tenantId]
  );
  if (actual.rows.length === 0) throw new AppError(404, "Cobro no encontrado para este tenant");
  const cobro = actual.rows[0];
  if (cobro.estado !== "pendiente") {
    throw new AppError(400, `El cobro ya está "${cobro.estado}", no "pendiente"`);
  }

  const monto = aNumero(cobro.monto);
  const pagadoAntes = aNumero(cobro.montoPagado);
  const saldoAntes = Math.round((monto - pagadoAntes) * 100) / 100;
  if (!Number.isFinite(montoAPagar) || montoAPagar <= 0) {
    throw new AppError(400, "El monto del pago tiene que ser mayor a cero");
  }
  if (montoAPagar > saldoAntes) {
    throw new AppError(400, `El pago (${montoAPagar}) supera el saldo pendiente (${saldoAntes})`);
  }

  const pagadoDespues = Math.round((pagadoAntes + montoAPagar) * 100) / 100;
  const saldoDespues = Math.round((monto - pagadoDespues) * 100) / 100;
  const nuevoEstado = saldoDespues <= 0 ? "exitoso" : "pendiente";

  await pool.query(
    `UPDATE cobros SET monto_pagado = $1, estado = $2, fecha_pago = $3 WHERE id = $4`,
    [pagadoDespues, nuevoEstado, fecha ?? hoyISO(), cobroId]
  );

  return { tipo: cobro.tipo, monto, saldoAntes, saldoDespues };
}

/** Pago parcial o total sobre un cobro 'pendiente' -- lo que dispara el
 *  botón "Registrar pago" del frontend cuando el admin carga un monto
 *  específico (menor al saldo, o igual). `fecha` es cuándo pasó ESTE
 *  pago (default hoy) -- es el único lugar donde `fecha_pago` se
 *  completa de verdad para un cobro que arrancó 'pendiente'. */
export async function registrarPagoCobroService(
  tenantId: string,
  cobroId: string,
  montoPagado: number,
  contexto: ContextoAuditoria,
  fecha?: string
): Promise<EstadoBilling> {
  await tenantExiste(tenantId);
  const resultado = await aplicarPagoCobro(tenantId, cobroId, montoPagado, fecha);

  await registrarAuditoria({
    accion: "billing.registrar_pago_cobro",
    tenantId,
    detalle: {
      cobroId,
      tipo: resultado.tipo,
      montoPagado,
      saldoAntes: resultado.saldoAntes,
      saldoDespues: resultado.saldoDespues,
      fecha: fecha ?? hoyISO(),
    },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

/** Atajo de un clic para el caso simple ("Marcar pagado"): paga el saldo
 *  completo restante de una. Por dentro es un caso particular de
 *  aplicarPagoCobro(), pero mantiene su propia acción de auditoría
 *  (`billing.marcar_cobro_pagado`) porque el timeline del frontend
 *  (`describirEvento()`) ya distingue este caso del pago parcial. */
export async function marcarCobroPagadoService(
  tenantId: string,
  cobroId: string,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  await tenantExiste(tenantId);

  const actual = await pool.query(
    `SELECT monto, monto_pagado AS "montoPagado" FROM cobros WHERE id = $1 AND tenant_id = $2`,
    [cobroId, tenantId]
  );
  if (actual.rows.length === 0) throw new AppError(404, "Cobro no encontrado para este tenant");
  const saldo =
    Math.round((aNumero(actual.rows[0].monto) - aNumero(actual.rows[0].montoPagado)) * 100) / 100;

  const resultado = await aplicarPagoCobro(tenantId, cobroId, saldo, undefined);

  await registrarAuditoria({
    accion: "billing.marcar_cobro_pagado",
    tenantId,
    detalle: { cobroId, tipo: resultado.tipo, monto: resultado.monto },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

export interface EditarCobroInput {
  monto?: number;
  moneda?: Moneda;
  descripcion?: string;
  // Cuándo pasó el pago -- editable siempre, es corrección de metadata,
  // no de la cifra cobrada (ver el comentario de más abajo).
  fecha?: string;
  // Idem: el TC pactado se puede corregir aunque el cobro ya esté
  // 'exitoso'. `null` explícito lo borra (solo válido si moneda va a
  // quedar en 'USD').
  tipoCambioAplicado?: number | null;
}

/** `descripcion`/`fecha`/`tipoCambioAplicado` se pueden corregir siempre
 *  -- son metadata de contexto, no la cifra cobrada. `monto`/`moneda`
 *  solo mientras el cobro sigue 'pendiente' -- una vez 'exitoso' es un
 *  registro contable confirmado (ver el comentario de 0041_billing.sql),
 *  cambiarle el monto ahí sería alterar un hecho ya ocurrido, no corregir
 *  un error de carga. Para eso hace falta una nota de crédito/ajuste, que
 *  no existe todavía (fuera de alcance). */
export async function editarCobroService(
  tenantId: string,
  cobroId: string,
  input: EditarCobroInput,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  await tenantExiste(tenantId);

  const actual = await pool.query(
    `SELECT estado, monto, moneda, descripcion, fecha_pago AS "fechaPago",
            tipo_cambio_aplicado AS "tipoCambioAplicado"
     FROM cobros WHERE id = $1 AND tenant_id = $2`,
    [cobroId, tenantId]
  );
  if (actual.rows.length === 0) throw new AppError(404, "Cobro no encontrado para este tenant");
  const cobroActual = actual.rows[0];

  const cambiaMontoOMoneda = input.monto !== undefined || input.moneda !== undefined;
  if (cambiaMontoOMoneda && cobroActual.estado !== "pendiente") {
    throw new AppError(
      400,
      `Solo se puede editar el monto/moneda de un cobro "pendiente" (este ya está "${cobroActual.estado}") -- es un registro contable confirmado`
    );
  }
  if (input.fecha !== undefined && cobroActual.estado === "pendiente") {
    throw new AppError(
      400,
      "La fecha del pago no aplica todavía a un cobro 'pendiente' -- se completa al registrar el pago"
    );
  }

  const antes = {
    monto: aNumero(cobroActual.monto),
    moneda: cobroActual.moneda,
    descripcion: cobroActual.descripcion,
    fecha: cobroActual.fechaPago,
    tipoCambioAplicado:
      cobroActual.tipoCambioAplicado === null ? null : aNumero(cobroActual.tipoCambioAplicado),
  };
  const despues = {
    monto: input.monto ?? antes.monto,
    moneda: input.moneda ?? antes.moneda,
    descripcion: input.descripcion !== undefined ? input.descripcion : antes.descripcion,
    fecha: input.fecha !== undefined ? input.fecha : antes.fecha,
    tipoCambioAplicado:
      input.tipoCambioAplicado !== undefined ? input.tipoCambioAplicado : antes.tipoCambioAplicado,
  };

  if (despues.moneda === "PEN" && despues.tipoCambioAplicado === null) {
    throw new AppError(400, "El tipo de cambio es obligatorio para cobros en PEN");
  }
  if (despues.moneda === "USD" && despues.tipoCambioAplicado !== null) {
    throw new AppError(400, "El tipo de cambio solo aplica a cobros en PEN");
  }

  await pool.query(
    `UPDATE cobros
     SET monto = $1, moneda = $2, descripcion = $3, fecha_pago = $4, tipo_cambio_aplicado = $5
     WHERE id = $6`,
    [
      despues.monto,
      despues.moneda,
      despues.descripcion,
      despues.fecha,
      despues.tipoCambioAplicado,
      cobroId,
    ]
  );

  await registrarAuditoria({
    accion: "billing.editar_cobro",
    tenantId,
    detalle: { cobroId, before: antes, after: despues },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

/** Borra un cobro por completo -- SOLO tipo 'implementacion' (el WHERE lo
 *  hace cumplir, no solo un chequeo previo). Los cobros 'suscripcion' son
 *  subproducto automático de forzarCobroService/el webhook y quedan fuera
 *  a propósito -- son el registro real de un cargo que el sistema hizo,
 *  no algo que el admin tipeó a mano y pueda haberse equivocado. Los de
 *  implementación sí son un ledger manual, así que borrar uno mal cargado
 *  es razonable (a diferencia de editar monto/moneda, no hay tope de
 *  "solo si sigue pendiente": un cobro 'exitoso' cargado de más también
 *  se puede borrar entero). */
export async function eliminarCobroService(
  tenantId: string,
  cobroId: string,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  await tenantExiste(tenantId);

  const borrado = await pool.query(
    `DELETE FROM cobros WHERE id = $1 AND tenant_id = $2 AND tipo = 'implementacion' RETURNING monto, moneda, descripcion`,
    [cobroId, tenantId]
  );
  if (borrado.rows.length === 0) {
    throw new AppError(
      404,
      "Cobro no encontrado, no pertenece a este tenant, o no es de tipo 'implementacion' (los de suscripción no se pueden borrar)"
    );
  }

  await registrarAuditoria({
    accion: "billing.eliminar_cobro",
    tenantId,
    detalle: { cobroId, ...borrado.rows[0] },
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

// Mismo valor que usa platformBillingVencimientos.service.ts para generar
// el cobro de la próxima renovación -- una alerta "próxima a vencer" tiene
// que cubrir exactamente esa ventana, ni más ni menos.
const DIAS_ANTICIPACION_ALERTA = 3;

export interface AlertaBilling {
  cobroId: string;
  tenantId: string;
  tenantNombre: string;
  tenantSlug: string;
  tipo: "suscripcion" | "implementacion";
  descripcion: string | null;
  moneda: Moneda;
  monto: number;
  montoPagado: number;
  saldo: number;
  fechaVencimiento: string | null;
  // Solo tiene sentido para `vencidas` -- 0 en fallidas/proximas.
  diasAtraso: number;
  motivoFallo: string | null;
  creadoEn: string;
}

export interface AlertasBilling {
  vencidas: AlertaBilling[];
  fallidas: AlertaBilling[];
  proximas: AlertaBilling[];
}

interface FilaAlertaCobro {
  cobroId: string;
  tenantId: string;
  tenantNombre: string;
  tenantSlug: string;
  tipo: "suscripcion" | "implementacion";
  descripcion: string | null;
  moneda: Moneda;
  monto: string;
  montoPagado: string;
  motivoFallo: string | null;
  fechaVencimiento: string | null;
  creadoEn: string;
}

function mapearAlertas(filas: FilaAlertaCobro[]): AlertaBilling[] {
  return filas.map((f) => {
    const monto = aNumero(f.monto);
    const montoPagado = aNumero(f.montoPagado);
    const diasAtraso = f.fechaVencimiento
      ? Math.max(0, Math.floor((Date.now() - new Date(f.fechaVencimiento).getTime()) / 86_400_000))
      : 0;
    return {
      cobroId: f.cobroId,
      tenantId: f.tenantId,
      tenantNombre: f.tenantNombre,
      tenantSlug: f.tenantSlug,
      tipo: f.tipo,
      descripcion: f.descripcion,
      moneda: f.moneda,
      monto,
      montoPagado,
      saldo: Math.round((monto - montoPagado) * 100) / 100,
      fechaVencimiento: f.fechaVencimiento,
      diasAtraso,
      motivoFallo: f.motivoFallo,
      creadoEn: f.creadoEn,
    };
  });
}

const COLUMNAS_ALERTA_COBRO = `
  c.id AS "cobroId", c.tenant_id AS "tenantId", t.nombre AS "tenantNombre", t.slug AS "tenantSlug",
  c.tipo, c.descripcion, c.moneda, c.monto, c.monto_pagado AS "montoPagado",
  c.motivo_fallo AS "motivoFallo", c.fecha_vencimiento AS "fechaVencimiento", c.creado_en AS "creadoEn"
`;

/** Junta, cruzando TODOS los tenants, lo que necesita tu atención sin que
 *  tengas que entrar tenant por tenant: facturas vencidas (pendiente y ya
 *  pasó la fecha), cobros con tarjeta rechazada (fallido, y sin un cobro
 *  exitoso posterior que ya lo haya resuelto), y lo que vence en los
 *  próximos días (para saber "esto vence el 17" con anticipación, no
 *  enterarte recién cuando ya venció). "Vencido" es calculado, nunca
 *  guardado (ver el comentario de la migración 0054) -- no puede quedar
 *  desincronizado por un cron que no corrió. */
export async function obtenerAlertasBillingService(): Promise<AlertasBilling> {
  const [vencidas, fallidas, proximas] = await Promise.all([
    pool.query<FilaAlertaCobro>(
      `SELECT ${COLUMNAS_ALERTA_COBRO}
       FROM cobros c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.estado = 'pendiente' AND c.fecha_vencimiento < now()
       ORDER BY c.fecha_vencimiento ASC`
    ),
    pool.query<FilaAlertaCobro>(
      `SELECT ${COLUMNAS_ALERTA_COBRO}
       FROM cobros c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.estado = 'fallido'
         AND c.creado_en > now() - interval '30 days'
         AND NOT EXISTS (
           SELECT 1 FROM cobros c2
           WHERE c2.suscripcion_id = c.suscripcion_id AND c2.tipo = 'suscripcion'
             AND c2.estado = 'exitoso' AND c2.creado_en > c.creado_en
         )
       ORDER BY c.creado_en DESC`
    ),
    pool.query<FilaAlertaCobro>(
      `SELECT ${COLUMNAS_ALERTA_COBRO}
       FROM cobros c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.estado = 'pendiente'
         AND c.fecha_vencimiento >= now()
         AND c.fecha_vencimiento < now() + make_interval(days => $1)
       ORDER BY c.fecha_vencimiento ASC`,
      [DIAS_ANTICIPACION_ALERTA]
    ),
  ]);

  return {
    vencidas: mapearAlertas(vencidas.rows),
    fallidas: mapearAlertas(fallidas.rows),
    proximas: mapearAlertas(proximas.rows),
  };
}

/** Método de pago FALSO, solo utilizable mientras la pasarela activa sea la
 *  Stub (obtenerPasarelaPago().nombre === "stub", es decir sin
 *  CULQI_SECRET_KEY configurada -- ver pasarelaPago.ts) -- el guard de acá
 *  es lo único que evita que esto exista en un ambiente con Culqi real
 *  detrás. Existe para poder probar el camino de tarjeta (forzar cobro,
 *  webhook) desde la UI sin tener que insertar la fila a mano por SQL. */
export async function crearMetodoPagoPruebaService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  if (obtenerPasarelaPago().nombre !== "stub") {
    throw new AppError(
      400,
      "Solo se puede agregar un método de pago de prueba cuando la pasarela activa es la Stub"
    );
  }
  if (actual.suscripcion.metodoFacturacion !== "tarjeta") {
    throw new AppError(
      400,
      "Esta suscripción factura por transferencia -- no tiene sentido agregarle una tarjeta"
    );
  }

  await pool.query(`UPDATE metodos_pago SET es_default = false WHERE tenant_id = $1`, [tenantId]);
  await pool.query(
    `INSERT INTO metodos_pago (tenant_id, pasarela, token_pasarela, marca, ultimos4, vence_mes, vence_anio, es_default)
     VALUES ($1, 'stub', $2, 'visa', '4242', 12, extract(year from now())::int + 2, true)`,
    [tenantId, `stub_tok_${randomUUID()}`]
  );

  await registrarAuditoria({
    accion: "billing.crear_metodo_pago_prueba",
    tenantId,
    detalle: {},
    contexto,
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

export interface ResultadoIntentoCobroTarjeta {
  idPasarela: string | null;
  estado: "exitoso" | "fallido";
  motivoFallo: string | null;
  moneda: "PEN";
  monto: number;
  tipoCambioAplicado: number;
}

/** Cobra la tarjeta guardada de esta suscripción -- NO toca la base (ni
 *  inserta ni actualiza `cobros`/`suscripciones`), solo intenta el cargo
 *  contra la pasarela y devuelve el resultado. La usan tanto
 *  forzarCobroService (crea un cobro nuevo en el momento) como el motor
 *  automático de platformBillingVencimientos.service.ts (actualiza un
 *  cobro 'pendiente' que ya existía) -- cada llamador decide qué hacer con
 *  el resultado en su propia escritura. Tira AppError(400) si no hay
 *  método de pago guardado. Solo pide los 3 campos de la suscripción que
 *  realmente usa (no el objeto completo) para que el motor automático no
 *  tenga que reconstruir un `Suscripcion` entero por cada cobro vencido. */
export async function intentarCobroTarjeta(
  suscripcion: Pick<Suscripcion, "tipoCambioOverride" | "precioReferencia" | "planCodigo">,
  tenantId: string
): Promise<ResultadoIntentoCobroTarjeta> {
  // token_pasarela nunca sale de acá -- ni siquiera en la respuesta de
  // obtenerSuscripcionTenantService, que es lo que ve el frontend.
  const metodo = await pool.query(
    `SELECT token_pasarela AS "tokenPasarela" FROM metodos_pago WHERE tenant_id = $1 AND es_default = true LIMIT 1`,
    [tenantId]
  );
  if (metodo.rows.length === 0) {
    throw new AppError(400, "No hay método de pago guardado para cobrar por tarjeta");
  }

  // Override de esta suscripción si existe (tasa pactada fija con este
  // cliente); si no, el TC global de plataforma vigente en este momento
  // (ver platformTipoCambio.service.ts) -- nunca uno viejo cacheado.
  const tipoCambioAplicado =
    suscripcion.tipoCambioOverride ?? (await obtenerTipoCambioActualService()).valor;
  const monto = Math.round(suscripcion.precioReferencia * tipoCambioAplicado * 100) / 100;

  const resultado = await obtenerPasarelaPago().crearCargo({
    tokenPasarela: metodo.rows[0].tokenPasarela,
    monto,
    moneda: "PEN", // Culqi opera nativo en soles, ver comentario de 0041_billing.sql
    descripcion: `Suscripción ${suscripcion.planCodigo} · tenant ${tenantId}`,
  });

  return {
    idPasarela: resultado.idPasarela,
    estado: resultado.estado,
    motivoFallo: resultado.motivoFallo ?? null,
    moneda: "PEN",
    monto,
    tipoCambioAplicado,
  };
}

export async function forzarCobroService(
  tenantId: string,
  contexto: ContextoAuditoria
): Promise<EstadoBilling> {
  const actual = await requerirSuscripcion(tenantId);
  const { suscripcion } = actual;
  const estadosCobrables: EstadoSuscripcion[] = ["trialing", "activa", "en_gracia", "suspendida"];
  if (!estadosCobrables.includes(suscripcion.estado)) {
    throw new AppError(400, `No se puede cobrar una suscripción "${suscripcion.estado}"`);
  }

  let idPasarela: string | null = null;
  let estadoCobro: "exitoso" | "fallido" = "exitoso";
  let motivoFallo: string | null = null;
  let moneda: Moneda = "USD";
  let tipoCambioAplicado: number | null = null;
  let monto = suscripcion.precioReferencia;

  if (suscripcion.metodoFacturacion === "tarjeta") {
    const resultado = await intentarCobroTarjeta(suscripcion, tenantId);
    idPasarela = resultado.idPasarela;
    estadoCobro = resultado.estado;
    motivoFallo = resultado.motivoFallo;
    moneda = resultado.moneda;
    monto = resultado.monto;
    tipoCambioAplicado = resultado.tipoCambioAplicado;
  }
  // metodoFacturacion === 'transferencia': no hay forma automática de
  // verificar que la plata llegó -- el admin que aprieta "Forzar cobro" ES
  // la fuente de verdad de que la transferencia se confirmó a mano.

  const mesesPeriodo = suscripcion.ciclo === "mensual" ? 1 : 12;
  const montoPagado = estadoCobro === "exitoso" ? monto : 0;
  const cobro = await pool.query(
    `INSERT INTO cobros
       (tenant_id, suscripcion_id, tipo, moneda, monto, monto_pagado, tipo_cambio_aplicado, estado,
        id_pasarela, motivo_fallo, fecha_vencimiento, periodo_inicio, periodo_fin)
     VALUES ($1, $2, 'suscripcion', $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz,
             $10::timestamptz + make_interval(months => $11))
     RETURNING id`,
    [
      tenantId,
      suscripcion.id,
      moneda,
      monto,
      montoPagado,
      tipoCambioAplicado,
      estadoCobro,
      idPasarela,
      motivoFallo,
      suscripcion.periodoActualFin,
      mesesPeriodo,
    ]
  );

  if (estadoCobro === "exitoso") {
    await pool.query(
      `UPDATE suscripciones
       SET estado = 'activa',
           periodo_actual_inicio = periodo_actual_fin,
           periodo_actual_fin = periodo_actual_fin + make_interval(months => $1),
           gracia_termina_en = NULL,
           actualizado_en = now()
       WHERE tenant_id = $2`,
      [mesesPeriodo, tenantId]
    );
    if (suscripcion.estado === "suspendida") {
      await cambiarEstadoTenantService(tenantId, true, "Cobro forzado exitoso", contexto);
    }
  }
  // Cobro fallido: se registra el intento pero no se toca el estado de la
  // suscripción -- el job de vencimientos (o el próximo webhook) decide si
  // corresponde pasar a gracia/suspender, no un cobro forzado puntual.

  await registrarAuditoria({
    accion: "billing.forzar_cobro",
    tenantId,
    detalle: { estadoCobro, monto, moneda, motivoFallo, cobroId: cobro.rows[0].id },
    contexto,
    resultado: estadoCobro === "exitoso" ? "success" : "failure",
  });

  return await obtenerSuscripcionTenantService(tenantId);
}

// Nombres reales de eventos de Culqi a confirmar cuando se activen claves
// reales (ver el comentario en pasarelaPagoCulqi.ts) -- los "cargo.*" en
// español son los que usa StubPasarela en tests.
const EVENTOS_CARGO_EXITOSO = new Set(["charge.succeeded", "cargo.exitoso"]);
const EVENTOS_CARGO_FALLIDO = new Set(["charge.failed", "cargo.fallido"]);

function extraerIdCargo(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "id" in payload) {
    const id = (payload as { id: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** Aplica el efecto de un evento de webhook YA verificado y YA persistido
 *  de forma idempotente (ver routes/webhooksPasarela.ts -- el INSERT ...
 *  ON CONFLICT DO NOTHING es lo que garantiza que esto se llama una sola
 *  vez por evento_id real). */
export async function aplicarEventoWebhookService(
  evento: EventoWebhookVerificado,
  contexto: ContextoAuditoria
): Promise<void> {
  const idPasarela = extraerIdCargo(evento.payload);
  if (!idPasarela) {
    logger.warn(
      { tipo: evento.tipo },
      "Webhook de pasarela sin id de cargo reconocible, se ignora"
    );
    return;
  }

  const cobro = await pool.query(
    `SELECT id, suscripcion_id AS "suscripcionId", tenant_id AS "tenantId" FROM cobros WHERE id_pasarela = $1`,
    [idPasarela]
  );
  if (cobro.rows.length === 0) {
    logger.warn(
      { idPasarela, tipo: evento.tipo },
      "Webhook de pasarela no matchea ningún cobro conocido"
    );
    return;
  }
  const { id: cobroId, suscripcionId, tenantId } = cobro.rows[0];

  if (EVENTOS_CARGO_EXITOSO.has(evento.tipo)) {
    await pool.query(`UPDATE cobros SET estado = 'exitoso' WHERE id = $1`, [cobroId]);
    if (suscripcionId) {
      const s = await pool.query(`SELECT ciclo FROM suscripciones WHERE id = $1`, [suscripcionId]);
      const meses = s.rows[0]?.ciclo === "mensual" ? 1 : 12;
      await pool.query(
        `UPDATE suscripciones
         SET estado = 'activa', periodo_actual_inicio = periodo_actual_fin,
             periodo_actual_fin = periodo_actual_fin + make_interval(months => $1),
             gracia_termina_en = NULL, actualizado_en = now()
         WHERE id = $2`,
        [meses, suscripcionId]
      );
    }
  } else if (EVENTOS_CARGO_FALLIDO.has(evento.tipo)) {
    await pool.query(`UPDATE cobros SET estado = 'fallido' WHERE id = $1`, [cobroId]);
  } else {
    logger.info(
      { tipo: evento.tipo },
      "Webhook de pasarela con tipo no manejado, sin efecto aplicado"
    );
    return;
  }

  await registrarAuditoria({
    accion: "billing.webhook_aplicado",
    tenantId,
    detalle: { tipo: evento.tipo, cobroId, idPasarela },
    contexto,
  });
}
