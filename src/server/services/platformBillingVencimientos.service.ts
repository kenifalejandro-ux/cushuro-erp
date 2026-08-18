/** src/server/services/platformBillingVencimientos.service.ts
 *
 * Motor de facturación recurrente + vencimientos (disparado por
 * .github/workflows/scheduled-billing-vencimientos.yml, mismo patrón que
 * el backup diario -- ver scheduled-backup.yml). Antes esto SOLO movía el
 * ESTADO de la suscripción mirando fechas -- nunca generaba un cobro ni
 * intentaba cobrar nada, así que la única forma de que existiera un cobro
 * de suscripción era que un admin apretara "Forzar cobro" a mano (ver
 * forzarCobroService en platformBilling.service.ts). Con 10+ tenants eso
 * no escala: ahora corre en 3 pasos, en este orden:
 *
 * 1. **Generar próximos cobros**: suscripciones que vencen dentro de
 *    `DIAS_ANTICIPACION` crean un cobro `pendiente` con `fecha_vencimiento`
 *    -- así "esto vence el 17" existe ANTES de que llegue el día, no
 *    después. Idempotente por diseño (no duplica si el cron corre dos
 *    veces): busca si ya existe un cobro para ese mismo `periodo_inicio`.
 * 2. **Cobrar tarjeta vencida**: cobros `pendiente` con
 *    `fecha_vencimiento` ya pasada, de suscripciones por tarjeta, se
 *    cobran solos (reusa `intentarCobroTarjeta` de platformBilling.service.ts
 *    -- mismo código que usa el botón manual "Forzar cobro"). Un solo
 *    intento, sin reintentos automáticos silenciosos -- si falla, queda
 *    `fallido` y aparece en `obtenerAlertasBillingService()` de inmediato.
 *    Transferencia no se toca acá: sigue pendiente hasta que el admin
 *    confirme el pago a mano (`registrarPagoCobroService`).
 * 3. `trialing`/`activa` vencidas → `en_gracia` (7 días para regularizar);
 *    `en_gracia` cuya gracia también venció → `suspendida`, y ESO sí corta
 *    el acceso real vía cambiarEstadoTenantService() (nunca tocando
 *    tenants.activo directo -- ver el comentario de 0041_billing.sql).
 *    Sin cambios de comportamiento respecto de antes.
 *
 * Cada paso es resiliente por fila (try/catch individual): un tenant con
 * un dato raro (ej. sin método de pago guardado) no debe frenar el
 * procesamiento del resto -- esto corre desatendido todos los días.
 *
 * Notificación: por ahora solo log + un evento en platform_outbox (tipo
 * "notificacion_billing", ver platformOutbox.worker.ts) -- ningún mail
 * real todavía, a propósito. La visibilidad real hoy es
 * `obtenerAlertasBillingService()` + la vista "Alertas" del panel.
 */
import { pool } from "../config/database";
import { logger } from "../config/logger";
import { registrarAuditoria, type ContextoAuditoria } from "./platformAudit.service";
import { escribirEventoOutbox } from "./platformOutbox.service";
import { cambiarEstadoTenantService } from "./platform.service";
import { intentarCobroTarjeta } from "./platformBilling.service";
import { obtenerTipoCambioActualService } from "./platformTipoCambio.service";

const DIAS_GRACIA = 7;

// Mismo valor que usa obtenerAlertasBillingService() en
// platformBilling.service.ts para la lista de "próximas a vencer" -- una
// alerta "próxima" tiene que cubrir exactamente la ventana en la que este
// motor ya generó el cobro pendiente, ni más ni menos.
const DIAS_ANTICIPACION = 3;

const CONTEXTO_JOB: ContextoAuditoria = {
  ip: "internal",
  actorType: "system",
  actorLabel: "job-vencimientos-billing",
};

interface FilaSuscripcionAVencer {
  id: string;
  tenantId: string;
  planCodigo: string;
  metodoFacturacion: "tarjeta" | "transferencia";
  precioReferencia: string;
  tipoCambioOverride: string | null;
  ciclo: "mensual" | "anual";
  periodoActualFin: string;
}

/** Un cobro `pendiente` por cada suscripción que vence dentro de la
 *  ventana de anticipación y todavía no tiene uno para ese período. El
 *  monto/TC acá es una ESTIMACIÓN (para que "próximas a vencer" en
 *  Alertas tenga un número) -- si es tarjeta, el cobro real al vencer
 *  recalcula el TC vigente en ese momento y pisa estos valores (ver
 *  `cobrarTarjetasVencidas`), así que nunca queda desactualizado el monto
 *  que realmente se cobra. */
async function generarProximosCobros(): Promise<number> {
  const aVencer = await pool.query<FilaSuscripcionAVencer>(
    `SELECT s.id, s.tenant_id AS "tenantId", p.codigo AS "planCodigo",
            s.metodo_facturacion AS "metodoFacturacion", s.precio_referencia AS "precioReferencia",
            s.tipo_cambio_override AS "tipoCambioOverride", s.ciclo,
            s.periodo_actual_fin AS "periodoActualFin"
     FROM suscripciones s
     JOIN planes p ON p.id = s.plan_id
     WHERE s.estado IN ('trialing', 'activa')
       AND s.periodo_actual_fin >= now()
       AND s.periodo_actual_fin < now() + make_interval(days => $1)
       AND NOT EXISTS (
         SELECT 1 FROM cobros c
         WHERE c.suscripcion_id = s.id AND c.tipo = 'suscripcion'
           AND c.periodo_inicio = s.periodo_actual_fin
           AND c.estado IN ('pendiente', 'exitoso')
       )`,
    [DIAS_ANTICIPACION]
  );

  let generados = 0;
  for (const s of aVencer.rows) {
    try {
      const mesesPeriodo = s.ciclo === "mensual" ? 1 : 12;
      const precioReferencia = Number(s.precioReferencia);
      let moneda: "USD" | "PEN" = "USD";
      let monto = precioReferencia;
      let tipoCambioAplicado: number | null = null;

      if (s.metodoFacturacion === "tarjeta") {
        moneda = "PEN";
        tipoCambioAplicado = s.tipoCambioOverride
          ? Number(s.tipoCambioOverride)
          : (await obtenerTipoCambioActualService()).valor;
        monto = Math.round(precioReferencia * tipoCambioAplicado * 100) / 100;
      }

      // OJO: periodo_inicio/fecha_vencimiento salen de un SELECT sobre
      // suscripciones.periodo_actual_fin DENTRO de este mismo INSERT, no
      // del valor que ya trajimos a JS (s.periodoActualFin) -- `pg`
      // devuelve TIMESTAMPTZ como Date de milisegundos, truncando
      // microsegundos, y eso rompía la comparación de idempotencia de más
      // abajo (`c.periodo_inicio = s.periodo_actual_fin`) contra el valor
      // de precisión completa que sigue en la tabla. Así nunca hay
      // round-trip por JS para este valor.
      await pool.query(
        `INSERT INTO cobros
           (tenant_id, suscripcion_id, tipo, moneda, monto, monto_pagado, tipo_cambio_aplicado,
            estado, fecha_vencimiento, periodo_inicio, periodo_fin)
         SELECT s2.tenant_id, s2.id, 'suscripcion', $2, $3, 0, $4, 'pendiente',
                s2.periodo_actual_fin, s2.periodo_actual_fin,
                s2.periodo_actual_fin + make_interval(months => $5)
         FROM suscripciones s2 WHERE s2.id = $1
         RETURNING id`,
        [s.id, moneda, monto, tipoCambioAplicado, mesesPeriodo]
      );

      await registrarAuditoria({
        accion: "billing.generar_cobro_proximo",
        tenantId: s.tenantId,
        detalle: {
          suscripcionId: s.id,
          planCodigo: s.planCodigo,
          monto,
          moneda,
          fechaVencimiento: s.periodoActualFin,
        },
        contexto: CONTEXTO_JOB,
      });
      generados++;
    } catch (err) {
      logger.error(
        { tenantId: s.tenantId, suscripcionId: s.id, err },
        "No se pudo generar el próximo cobro de esta suscripción -- se sigue con el resto"
      );
    }
  }
  return generados;
}

interface FilaCobroVencido {
  cobroId: string;
  tenantId: string;
  precioReferencia: string;
  tipoCambioOverride: string | null;
  planCodigo: string;
  estadoSuscripcion: string;
}

/** Cobros `pendiente` de tipo 'suscripcion' por tarjeta cuya fecha de
 *  vencimiento ya llegó: un solo intento automático contra la pasarela,
 *  sin reintentos silenciosos (ver el comentario del archivo). */
async function cobrarTarjetasVencidas(): Promise<{ exitosos: number; fallidos: number }> {
  const vencidos = await pool.query<FilaCobroVencido>(
    `SELECT c.id AS "cobroId", c.tenant_id AS "tenantId", s.precio_referencia AS "precioReferencia",
            s.tipo_cambio_override AS "tipoCambioOverride", p.codigo AS "planCodigo",
            s.estado AS "estadoSuscripcion"
     FROM cobros c
     JOIN suscripciones s ON s.id = c.suscripcion_id
     JOIN planes p ON p.id = s.plan_id
     WHERE c.estado = 'pendiente' AND c.tipo = 'suscripcion' AND c.fecha_vencimiento <= now()
       AND s.metodo_facturacion = 'tarjeta'
       AND s.estado IN ('trialing', 'activa', 'en_gracia', 'suspendida')`
  );

  let exitosos = 0;
  let fallidos = 0;
  for (const fila of vencidos.rows) {
    try {
      const resultado = await intentarCobroTarjeta(
        {
          tipoCambioOverride:
            fila.tipoCambioOverride === null ? null : Number(fila.tipoCambioOverride),
          precioReferencia: Number(fila.precioReferencia),
          planCodigo: fila.planCodigo,
        },
        fila.tenantId
      );

      if (resultado.estado === "exitoso") {
        await pool.query(
          `UPDATE cobros
           SET estado = 'exitoso', monto = $1, monto_pagado = $1, moneda = $2,
               tipo_cambio_aplicado = $3, id_pasarela = $4
           WHERE id = $5`,
          [
            resultado.monto,
            resultado.moneda,
            resultado.tipoCambioAplicado,
            resultado.idPasarela,
            fila.cobroId,
          ]
        );
        await pool.query(
          `UPDATE suscripciones
           SET estado = 'activa', periodo_actual_inicio = periodo_actual_fin,
               periodo_actual_fin = periodo_actual_fin +
                 make_interval(months => CASE WHEN ciclo = 'mensual' THEN 1 ELSE 12 END),
               gracia_termina_en = NULL, actualizado_en = now()
           WHERE tenant_id = $1`,
          [fila.tenantId]
        );
        // Solo reactiva si venía 'suspendida' -- igual que forzarCobroService.
        // Llamarlo siempre (aunque ya estuviera activa) generaría una
        // entrada de auditoría "cambiar_estado_tenant" redundante en el
        // caso común (renovación normal, nunca estuvo suspendida).
        if (fila.estadoSuscripcion === "suspendida") {
          await cambiarEstadoTenantService(
            fila.tenantId,
            true,
            "Cobro automático de renovación exitoso",
            CONTEXTO_JOB
          );
        }
        await registrarAuditoria({
          accion: "billing.cobro_automatico_exitoso",
          tenantId: fila.tenantId,
          detalle: { cobroId: fila.cobroId, monto: resultado.monto, moneda: resultado.moneda },
          contexto: CONTEXTO_JOB,
        });
        exitosos++;
      } else {
        await pool.query(
          `UPDATE cobros
           SET estado = 'fallido', monto = $1, moneda = $2, tipo_cambio_aplicado = $3,
               id_pasarela = $4, motivo_fallo = $5
           WHERE id = $6`,
          [
            resultado.monto,
            resultado.moneda,
            resultado.tipoCambioAplicado,
            resultado.idPasarela,
            resultado.motivoFallo,
            fila.cobroId,
          ]
        );
        await registrarAuditoria({
          accion: "billing.cobro_automatico_fallido",
          tenantId: fila.tenantId,
          detalle: { cobroId: fila.cobroId, motivoFallo: resultado.motivoFallo },
          contexto: CONTEXTO_JOB,
          resultado: "failure",
        });
        fallidos++;
      }
    } catch (err) {
      // Ej. AppError 400 "no hay método de pago guardado" -- no es un
      // error del job, es un dato faltante de este tenant puntual.
      const mensaje =
        err instanceof Error ? err.message : "Error desconocido al intentar el cobro automático";
      await pool.query(`UPDATE cobros SET estado = 'fallido', motivo_fallo = $1 WHERE id = $2`, [
        mensaje,
        fila.cobroId,
      ]);
      logger.error(
        { tenantId: fila.tenantId, cobroId: fila.cobroId, err },
        "Falló el intento automático de cobro por tarjeta"
      );
      fallidos++;
    }
  }
  return { exitosos, fallidos };
}

export interface ResultadoVencimientos {
  cobrosGenerados: number;
  cobrosAutomaticosExitosos: number;
  cobrosAutomaticosFallidos: number;
  entraronEnGracia: number;
  suspendidas: number;
}

export async function procesarVencimientosService(): Promise<ResultadoVencimientos> {
  const cobrosGenerados = await generarProximosCobros();
  const { exitosos: cobrosAutomaticosExitosos, fallidos: cobrosAutomaticosFallidos } =
    await cobrarTarjetasVencidas();

  const entranEnGracia = await pool.query(
    `UPDATE suscripciones
     SET estado = 'en_gracia', gracia_termina_en = now() + make_interval(days => $1), actualizado_en = now()
     WHERE estado IN ('trialing', 'activa') AND periodo_actual_fin < now()
     RETURNING id, tenant_id AS "tenantId"`,
    [DIAS_GRACIA]
  );

  for (const fila of entranEnGracia.rows) {
    logger.warn(
      { tenantId: fila.tenantId, suscripcionId: fila.id },
      "Suscripción entra en gracia por vencimiento"
    );
    await registrarAuditoria({
      accion: "billing.entra_en_gracia",
      tenantId: fila.tenantId,
      detalle: { suscripcionId: fila.id, diasGracia: DIAS_GRACIA },
      contexto: CONTEXTO_JOB,
    });
    await escribirEventoOutbox(pool, {
      tipo: "notificacion_billing",
      payload: { tenantId: fila.tenantId, tipo: "entra_en_gracia" },
    });
  }

  const seSuspenden = await pool.query(
    `UPDATE suscripciones
     SET estado = 'suspendida', actualizado_en = now()
     WHERE estado = 'en_gracia' AND gracia_termina_en < now()
     RETURNING id, tenant_id AS "tenantId"`
  );

  for (const fila of seSuspenden.rows) {
    logger.warn(
      { tenantId: fila.tenantId, suscripcionId: fila.id },
      "Suscripción suspendida por vencimiento del período de gracia"
    );
    await cambiarEstadoTenantService(
      fila.tenantId,
      false,
      "Suspensión automática por impago (venció el período de gracia)",
      CONTEXTO_JOB
    );
    await registrarAuditoria({
      accion: "billing.suspendida_por_vencimiento",
      tenantId: fila.tenantId,
      detalle: { suscripcionId: fila.id },
      contexto: CONTEXTO_JOB,
    });
    await escribirEventoOutbox(pool, {
      tipo: "notificacion_billing",
      payload: { tenantId: fila.tenantId, tipo: "suspendido" },
    });
  }

  return {
    cobrosGenerados,
    cobrosAutomaticosExitosos,
    cobrosAutomaticosFallidos,
    entraronEnGracia: entranEnGracia.rows.length,
    suspendidas: seSuspenden.rows.length,
  };
}
