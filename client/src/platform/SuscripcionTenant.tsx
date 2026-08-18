// client/src/platform/SuscripcionTenant.tsx
//
// Suscripción y cobro del tenant (migración 0041_billing.sql). Mismo
// patrón que DominioTenant/SsoTenant/ScimTenant en TenantDetalleView.tsx:
// card oscura, carga al montar, formularios inline por acción.
//
// Estructura visual (v2, consola tipo Stripe Billing/Chargebee sin salir
// de la estética dark del panel):
//   1. Hero: plan + precio + próxima fecha, grande, domina la card.
//   2. Banner de estado crítico (en_gracia/suspendida) + tinte de fondo de
//      toda la card en esos dos estados.
//   3. Método de pago, en su propia fila.
//   4. Acciones agrupadas por peso: principales primero, irreversibles
//      (cancelar/eliminar) separadas visualmente al final.
//   5. Historial reciente (timeline) -- reusa GET /auditoria (ya existe,
//      la misma que usa AuditoriaView.tsx) filtrado por tenantId, sin
//      endpoint nuevo.
//   6. Cobros de suscripción (historial automático, solo lectura) separado
//      de Cobros de implementación (ledger manual, editable) -- no deben
//      sentirse como la misma lista.

import { useEffect, useState, type FormEvent } from "react";

import {
  listarPlanesApi,
  obtenerSuscripcionTenantApi,
  crearSuscripcionApi,
  cambiarPlanSuscripcionApi,
  extenderGraciaSuscripcionApi,
  cancelarSuscripcionApi,
  reactivarSuscripcionApi,
  forzarCobroSuscripcionApi,
  obtenerPasarelaActivaApi,
  crearMetodoPagoPruebaApi,
  eliminarSuscripcionApi,
  registrarCobroImplementacionApi,
  registrarPagoCobroApi,
  editarCobroApi,
  eliminarCobroApi,
  iniciarCortesiaApi,
  iniciarFacturacionApi,
  listarAuditoriaApi,
  obtenerTipoCambioApi,
  actualizarTipoCambioOverrideApi,
  actualizarTipoCambioDesdeBcrpApi,
  type Plan,
  type Suscripcion,
  type EstadoBilling,
  type EstadoSuscripcion,
  type CobroTenant,
  type EntradaAuditoria,
  type TipoCambio,
} from "./platformApi";

const BADGE_ESTADO: Record<EstadoSuscripcion, string> = {
  trialing: "bg-slate-800 text-slate-300",
  activa: "bg-emerald-950 text-emerald-400",
  en_gracia: "bg-amber-950 text-amber-400",
  suspendida: "bg-red-950 text-red-400",
  cancelada: "bg-red-950 text-red-400",
};

// "trialing" NO es un trial de producto (nadie se autosuscribe al ERP) --
// es una exoneración comercial negociada caso por caso (ej. cliente que ya
// pagó la implementación pero se le exonera la mensualidad por un tiempo).
// La etiqueta refleja eso, aunque el estado interno siga llamándose igual.
const ETIQUETA_ESTADO: Record<EstadoSuscripcion, string> = {
  trialing: "Cortesía (sin cobro)",
  activa: "Activa",
  en_gracia: "En gracia",
  suspendida: "Suspendida",
  cancelada: "Cancelada",
};

// Tinte sutil de fondo de TODA la card en los dos estados que requieren
// atención inmediata -- el badge chico no alcanza para que se note al
// escanear la pantalla rápido (pedido explícito: reforzar la jerarquía
// visual de estados críticos).
const TINTE_CARD: Partial<Record<EstadoSuscripcion, string>> = {
  en_gracia: "bg-amber-950/10 border-amber-900/50",
  suspendida: "bg-red-950/10 border-red-900/50",
};

function fecha(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

// `tipoCambioEfectivo` = override de la suscripción si tiene, si no el TC
// global de plataforma -- mismo criterio que forzarCobroService del lado
// del backend, para que lo que se MUESTRA acá coincida con lo que
// realmente se va a cobrar el día del próximo forzar cobro.
function resumenProximaFecha(
  s: Suscripcion,
  tipoCambioEfectivo: number | null
): { etiqueta: string; valor: string } {
  switch (s.estado) {
    case "trialing":
      return { etiqueta: "Cortesía hasta", valor: fecha(s.trialTerminaEn) };
    case "activa": {
      const equivalente =
        s.metodoFacturacion === "tarjeta" && tipoCambioEfectivo
          ? ` (≈ PEN ${(s.precioReferencia * tipoCambioEfectivo).toFixed(2)})`
          : "";
      return {
        etiqueta: "Próximo cobro",
        valor: `USD ${s.precioReferencia.toFixed(2)}${equivalente} · ${fecha(s.periodoActualFin)}`,
      };
    }
    case "en_gracia":
      return { etiqueta: "Gracia hasta", valor: fecha(s.graciaTerminaEn) };
    case "suspendida":
      return { etiqueta: "Gracia venció", valor: fecha(s.graciaTerminaEn) };
    case "cancelada":
      return { etiqueta: "Cancelada el", valor: fecha(s.canceladaEn) };
  }
}

// `detalle` de auditoría es `unknown` (puede ser cualquier JSON) -- acceso
// defensivo nomás para armar una frase legible, nunca se confía en que
// una clave puntual exista.
function campo(detalle: unknown, clave: string): any {
  if (!detalle || typeof detalle !== "object") return undefined;
  return (detalle as Record<string, any>)[clave];
}

/** No existe un mapeo de etiquetas reusable en el resto del panel
 *  (AuditoriaView.tsx muestra el string crudo de `accion`) -- este es
 *  propio de acá, para las ~14 acciones que escribe platformBilling.service.ts. */
function describirEvento(e: EntradaAuditoria): string {
  const d = e.detalle;
  switch (e.accion) {
    case "billing.crear_suscripcion":
      return `Alta de suscripción · plan ${campo(d, "plan") ?? "?"} · USD ${campo(d, "precioReferencia") ?? "?"}`;
    case "billing.cambiar_plan":
      return `Cambio de plan: ${campo(campo(d, "before"), "plan") ?? "?"} → ${campo(campo(d, "after"), "plan") ?? "?"}`;
    case "billing.extender_gracia":
      return `Gracia extendida ${campo(d, "dias") ?? "?"} días`;
    case "billing.cancelar_suscripcion":
      return "Suscripción cancelada";
    case "billing.reactivar_suscripcion":
      return "Suscripción reactivada";
    case "billing.eliminar_suscripcion":
      return "Suscripción eliminada";
    case "billing.forzar_cobro":
      return `Cobro forzado: ${campo(d, "estadoCobro") ?? "?"} (${campo(d, "moneda") ?? ""} ${campo(d, "monto") ?? ""})`;
    case "billing.entra_en_gracia":
      return "Entró en gracia (vencimiento automático)";
    case "billing.suspendida_por_vencimiento":
      return "Suspendida por vencimiento de gracia";
    case "billing.registrar_cobro_implementacion":
      return `Cobro de implementación registrado (${campo(d, "estado") ?? "?"}, ${campo(d, "moneda") ?? ""} ${campo(d, "monto") ?? ""})`;
    case "billing.marcar_cobro_pagado":
      return "Cobro de implementación marcado como pagado";
    case "billing.editar_cobro":
      return "Cobro editado";
    case "billing.iniciar_cortesia":
      return `Cortesía reiniciada desde hoy (${campo(d, "trialMeses") ?? "?"} meses)`;
    case "billing.webhook_aplicado":
      return `Webhook de pasarela aplicado (${campo(d, "tipo") ?? "?"})`;
    case "billing.crear_metodo_pago_prueba":
      return "Método de pago de prueba agregado";
    default:
      return e.accion;
  }
}

export default function SuscripcionTenant({
  tenantId,
  tenantActivo,
}: {
  tenantId: string;
  tenantActivo: boolean;
}) {
  const [estado, setEstado] = useState<EstadoBilling | null>(null);
  const [planes, setPlanes] = useState<Plan[]>([]);
  const [pasarelaActiva, setPasarelaActiva] = useState<"stub" | "culqi" | null>(null);
  const [tipoCambio, setTipoCambio] = useState<TipoCambio | null>(null);
  const [actualizandoTipoCambio, setActualizandoTipoCambio] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);

  // Sin esto, cualquier acción exitosa (ej. "Iniciar cortesía") no daba
  // NINGUNA señal visual de que pasó algo -- el único rastro quedaba en el
  // historial de más abajo, y si el resultado era igual al anterior (ej.
  // reiniciar la cortesía dos veces el mismo día) ni siquiera se notaba
  // que cambió algo. Se autolimpia solo para no quedar pegado.
  function mostrarExito(mensaje: string) {
    setMensajeExito(mensaje);
    setTimeout(() => setMensajeExito((actual) => (actual === mensaje ? null : actual)), 3000);
  }
  // Fuerza a TimelineSuscripcion a refetchear cada vez que una acción
  // cambia algo -- el timeline vive de /auditoria, que no se actualiza
  // solo cuando cambia `estado`.
  const [historialVersion, setHistorialVersion] = useState(0);

  async function cargar() {
    setCargando(true);
    try {
      // soloActivos=true en los planes: mismo criterio que PlanYCuotasTenant
      // -- uno dado de baja no se ofrece para asignar de nuevo.
      const [suscripcion, listaPlanes, pasarela, tc] = await Promise.all([
        obtenerSuscripcionTenantApi(tenantId),
        listarPlanesApi(true),
        obtenerPasarelaActivaApi(),
        obtenerTipoCambioApi(),
      ]);
      setEstado(suscripcion);
      setPlanes(listaPlanes);
      setPasarelaActiva(pasarela);
      setTipoCambio(tc);
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar la suscripción");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Separado de `procesando` a propósito: es una acción sobre el TC
  // global, no sobre esta suscripción -- no tiene sentido bloquear los
  // botones de la suscripción mientras esto está en vuelo.
  async function actualizarTipoCambioDesdeBcrp() {
    setActualizandoTipoCambio(true);
    try {
      setTipoCambio(await actualizarTipoCambioDesdeBcrpApi());
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo actualizar el tipo de cambio desde el BCRP");
    } finally {
      setActualizandoTipoCambio(false);
    }
  }

  async function ejecutar(accion: () => Promise<EstadoBilling>, mensajeExito: string) {
    setProcesando(true);
    try {
      setEstado(await accion());
      setError(null);
      mostrarExito(mensajeExito);
      setHistorialVersion((v) => v + 1);
    } catch (err: any) {
      setError(err.message || "No se pudo completar la acción");
    } finally {
      setProcesando(false);
    }
  }

  // Distinto de `ejecutar`: eliminarSuscripcionApi no devuelve EstadoBilling
  // (la suscripción deja de existir), así que se refresca todo con cargar()
  // en vez de pisar el estado a mano -- mantiene cobrosRecientes/metodoPago
  // consistentes con lo que quedó en la base.
  async function eliminar() {
    setProcesando(true);
    try {
      await eliminarSuscripcionApi(tenantId);
      await cargar();
      mostrarExito("Suscripción eliminada");
      setHistorialVersion((v) => v + 1);
    } catch (err: any) {
      setError(err.message || "No se pudo eliminar la suscripción");
    } finally {
      setProcesando(false);
    }
  }

  const estadoActual = estado?.suscripcion?.estado;
  const tinte = estadoActual ? (TINTE_CARD[estadoActual] ?? "bg-slate-900 border-slate-800") : "";

  return (
    <div
      className={`border rounded-xl p-4 mb-6 transition-colors ${tinte || "bg-slate-900 border-slate-800"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-light text-slate-400">Suscripción y cobro</h3>
        <div className="flex items-center gap-2">
          <span
            title="Si el tenant puede o no entrar a loguearse -- independiente del estado de facturación de acá abajo. Se cambia con el botón 'Desactivar/Activar empresa' arriba de todo en esta página."
            className={`px-2 py-0.5 rounded-full text-xs ${
              tenantActivo ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
            }`}
          >
            Acceso: {tenantActivo ? "Activo" : "Suspendido"}
          </span>
          {estado?.suscripcion && (
            <span
              className={`px-2 py-0.5 rounded-full text-xs ${BADGE_ESTADO[estado.suscripcion.estado]}`}
            >
              {ETIQUETA_ESTADO[estado.suscripcion.estado]}
            </span>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}

      {mensajeExito && (
        <p className="text-sm text-emerald-400 bg-emerald-950/40 border border-emerald-900 rounded-lg px-3 py-2 mb-3">
          ✓ {mensajeExito}
        </p>
      )}

      {cargando ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : (
        estado && (
          <>
            {estado.suscripcion ? (
              <PanelSuscripcionActiva
                estado={estado as EstadoBilling & { suscripcion: Suscripcion }}
                planes={planes}
                procesando={procesando}
                pasarelaActiva={pasarelaActiva}
                tipoCambio={tipoCambio}
                actualizandoTipoCambio={actualizandoTipoCambio}
                onActualizarTipoCambioDesdeBcrp={actualizarTipoCambioDesdeBcrp}
                onCambiarPlan={(plan, precioReferencia, motivo) =>
                  ejecutar(
                    () => cambiarPlanSuscripcionApi(tenantId, plan, precioReferencia, motivo),
                    `Plan cambiado a ${plan}`
                  )
                }
                onExtenderGracia={(dias, motivo) =>
                  ejecutar(
                    () => extenderGraciaSuscripcionApi(tenantId, dias, motivo),
                    `Gracia extendida ${dias} días`
                  )
                }
                onCancelar={(motivo) =>
                  ejecutar(() => cancelarSuscripcionApi(tenantId, motivo), "Suscripción cancelada")
                }
                onReactivar={() =>
                  ejecutar(() => reactivarSuscripcionApi(tenantId), "Suscripción reactivada")
                }
                onForzarCobro={() =>
                  ejecutar(() => forzarCobroSuscripcionApi(tenantId), "Cobro procesado")
                }
                onAgregarMetodoPagoPrueba={() =>
                  ejecutar(
                    () => crearMetodoPagoPruebaApi(tenantId),
                    "Método de pago de prueba agregado"
                  )
                }
                onEliminar={eliminar}
                onIniciarCortesia={(trialMeses) =>
                  ejecutar(
                    () => iniciarCortesiaApi(tenantId, trialMeses),
                    `Cortesía reiniciada (${trialMeses} ${trialMeses === 1 ? "mes" : "meses"} desde hoy)`
                  )
                }
                onIniciarFacturacion={() =>
                  ejecutar(() => iniciarFacturacionApi(tenantId), "Facturación iniciada desde hoy")
                }
                onActualizarTipoCambioOverride={(valor) =>
                  ejecutar(
                    () => actualizarTipoCambioOverrideApi(tenantId, valor),
                    valor === null ? "Override de TC quitado" : "Override de TC guardado"
                  )
                }
              />
            ) : (
              <EmptyStateAlta
                planes={planes}
                procesando={procesando}
                tipoCambio={tipoCambio}
                actualizandoTipoCambio={actualizandoTipoCambio}
                onActualizarTipoCambioDesdeBcrp={actualizarTipoCambioDesdeBcrp}
                onCrear={(input) =>
                  ejecutar(() => crearSuscripcionApi(tenantId, input), "Suscripción dada de alta")
                }
              />
            )}

            <TimelineSuscripcion tenantId={tenantId} refreshToken={historialVersion} />

            <SeccionCobrosSuscripcion
              cobros={estado.cobrosRecientes.filter((c) => c.tipo === "suscripcion")}
              procesando={procesando}
              onRegistrarPago={(cobroId, montoPagado, fecha) =>
                ejecutar(
                  () => registrarPagoCobroApi(tenantId, cobroId, montoPagado, fecha),
                  "Pago registrado"
                )
              }
            />

            <SeccionCobrosImplementacion
              cobros={estado.cobrosRecientes.filter((c) => c.tipo === "implementacion")}
              procesando={procesando}
              tipoCambio={tipoCambio}
              onRegistrar={(input) =>
                ejecutar(
                  () => registrarCobroImplementacionApi(tenantId, input),
                  "Cobro de implementación registrado"
                )
              }
              onRegistrarPago={(cobroId, montoPagado, fecha) =>
                ejecutar(
                  () => registrarPagoCobroApi(tenantId, cobroId, montoPagado, fecha),
                  "Pago registrado"
                )
              }
              onEditar={(cobroId, input) =>
                ejecutar(() => editarCobroApi(tenantId, cobroId, input), "Cobro editado")
              }
              onEliminar={(cobroId) =>
                ejecutar(() => eliminarCobroApi(tenantId, cobroId), "Cobro eliminado")
              }
            />
          </>
        )
      )}
    </div>
  );
}

function BannerEstado({ suscripcion }: { suscripcion: Suscripcion }) {
  if (suscripcion.estado === "en_gracia") {
    return (
      <div className="flex items-center gap-2 bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2.5 text-sm text-amber-300">
        <span aria-hidden="true" className="text-base">
          ⚠
        </span>
        <span>
          En período de gracia — se suspende el{" "}
          <strong>{fecha(suscripcion.graciaTerminaEn)}</strong> si no se regulariza el cobro.
        </span>
      </div>
    );
  }
  if (suscripcion.estado === "suspendida") {
    return (
      <div className="flex items-center gap-2 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2.5 text-sm text-red-300">
        <span aria-hidden="true" className="text-base">
          ⛔
        </span>
        <span>
          Suspendida — el acceso del tenant está cortado desde que venció la gracia el{" "}
          <strong>{fecha(suscripcion.graciaTerminaEn)}</strong>.
        </span>
      </div>
    );
  }
  return null;
}

/** Plan + precio + próxima fecha, grande -- esto es lo que tiene que
 *  dominar la card al escanearla, no un dato más entre cuatro columnas
 *  chicas iguales. */
function HeroSuscripcion({
  suscripcion,
  tipoCambioEfectivo,
}: {
  suscripcion: Suscripcion;
  tipoCambioEfectivo: number | null;
}) {
  const { etiqueta, valor } = resumenProximaFecha(suscripcion, tipoCambioEfectivo);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-xs text-slate-500 mb-1">Plan actual</p>
        <p className="text-2xl font-light text-slate-100">{suscripcion.planNombre}</p>
        <p className="text-xs text-slate-500 mt-1 capitalize">
          {suscripcion.ciclo} · {suscripcion.metodoFacturacion}
        </p>
      </div>
      <div className="text-right">
        <p className="text-xs text-slate-500 mb-1">{etiqueta}</p>
        <p className="text-xl font-light text-slate-100">{valor}</p>
      </div>
    </div>
  );
}

function MetodoPagoRow({
  metodoFacturacion,
  metodoPago,
  pasarelaActiva,
  procesando,
  onAgregarMetodoPagoPrueba,
}: {
  metodoFacturacion: "tarjeta" | "transferencia";
  metodoPago: EstadoBilling["metodoPago"];
  pasarelaActiva: "stub" | "culqi" | null;
  procesando: boolean;
  onAgregarMetodoPagoPrueba: () => void;
}) {
  // La tarjeta guardada solo importa si esta suscripción factura por
  // tarjeta -- con transferencia no se usa para cobrar nada (ver el
  // comentario de obtenerSuscripcionTenantService), mostrarla igual
  // sugiere falsamente "así se te va a cobrar".
  if (metodoFacturacion !== "tarjeta") {
    return (
      <div className="flex items-center gap-2 bg-slate-950/40 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-500">
        <span aria-hidden="true">💳</span>
        <span>No aplica — esta suscripción factura por transferencia</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/40 border border-slate-800 rounded-lg px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span aria-hidden="true">💳</span>
        {metodoPago ? (
          <span className="text-slate-200">
            {metodoPago.marca ?? "tarjeta"} •••• {metodoPago.ultimos4}
            {metodoPago.venceMes && metodoPago.venceAnio
              ? ` · vence ${metodoPago.venceMes}/${metodoPago.venceAnio}`
              : ""}
          </span>
        ) : (
          <span className="text-slate-500">Sin método de pago guardado</span>
        )}
      </div>
      {pasarelaActiva === "stub" && (
        <button
          onClick={onAgregarMetodoPagoPrueba}
          disabled={procesando}
          title="Solo disponible en modo Stub (desarrollo/tests). No se va a ver reflejada acá arriba -- es una tarjeta de testing interno, no un registro real del tenant -- pero sí habilita probar 'Forzar cobro' por tarjeta."
          className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
        >
          + Agregar método de prueba (no se muestra, solo para probar cobros)
        </button>
      )}
    </div>
  );
}

/** Se muestra siempre, aunque factura por transferencia: aunque ahí no
 *  haya conversión automática de por medio, es el dato que Kenif necesita
 *  para decirle al cliente cuántos soles transferir por un precio en
 *  USD. El override (excepción por cliente) solo tiene sentido con
 *  tarjeta -- con transferencia se oculta la acción de fijarlo (el
 *  backend igual lo rechaza con 400). */
function TipoCambioRow({
  tipoCambioGlobal,
  override,
  puedeFijarOverride,
  actualizando,
  onActualizarDesdeBcrp,
  procesando,
  onActualizarOverride,
}: {
  tipoCambioGlobal: TipoCambio | null;
  override: number | null;
  puedeFijarOverride: boolean;
  actualizando: boolean;
  onActualizarDesdeBcrp: () => void;
  procesando: boolean;
  onActualizarOverride: (valor: number | null) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [valorEdit, setValorEdit] = useState(override ? String(override) : "");

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/40 border border-slate-800 rounded-lg px-3 py-2 text-xs">
      <div className="text-slate-400">
        TC global:{" "}
        <span className="text-slate-200">
          USD 1 = PEN {tipoCambioGlobal?.valor.toFixed(2) ?? "—"}
        </span>
        {tipoCambioGlobal && (
          <span className="text-slate-600"> (act. {fecha(tipoCambioGlobal.creadoEn)})</span>
        )}
        {override !== null && (
          <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-950 text-blue-300">
            Override de este cliente: PEN {override.toFixed(2)}
          </span>
        )}
        <button
          onClick={onActualizarDesdeBcrp}
          disabled={actualizando}
          title="Trae el último valor publicado por el BCRP (TC interbancario venta) y lo guarda como el nuevo TC global"
          className="ml-2 text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
        >
          {actualizando ? "Actualizando..." : "↻ Actualizar desde API"}
        </button>
      </div>
      {!puedeFijarOverride && (
        <span className="text-slate-600">Solo referencia — la tasa propia aplica a tarjeta</span>
      )}
      {puedeFijarOverride && !editando && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setValorEdit(override ? String(override) : "");
              setEditando(true);
            }}
            disabled={procesando}
            className="text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
          >
            {override !== null ? "Editar tasa propia" : "Fijar tasa propia para este cliente"}
          </button>
          {override !== null && (
            <button
              onClick={() => onActualizarOverride(null)}
              disabled={procesando}
              className="text-red-500 hover:text-red-400 underline underline-offset-2 disabled:opacity-50"
            >
              Quitar override
            </button>
          )}
        </div>
      )}
      {puedeFijarOverride && editando && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step="0.01"
            autoFocus
            value={valorEdit}
            onChange={(e) => setValorEdit(e.target.value)}
            placeholder="ej. 3.80"
            className="w-24 px-2 py-1 rounded-lg border border-slate-700 bg-slate-950 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
          <button
            onClick={() => {
              const v = Number(valorEdit);
              if (!valorEdit || !Number.isFinite(v) || v <= 0) return;
              onActualizarOverride(v);
              setEditando(false);
            }}
            disabled={procesando || !valorEdit}
            className="px-2 py-1 rounded-lg bg-slate-100 text-slate-900 font-medium hover:bg-white disabled:opacity-50 transition-colors"
          >
            Guardar
          </button>
          <button
            onClick={() => setEditando(false)}
            className="text-slate-500 hover:text-slate-300"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

function TimelineSuscripcion({
  tenantId,
  refreshToken,
}: {
  tenantId: string;
  refreshToken: number;
}) {
  const [eventos, setEventos] = useState<EntradaAuditoria[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    // Mismo patrón estándar de carga al montar que el resto del panel.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargando(true);
    // Reusa /api/platform/auditoria (la misma que AuditoriaView.tsx) --
    // filtrado por tenantId nomás, porque el backend filtra `accion` por
    // igualdad exacta, no prefijo. "billing.*" se filtra acá.
    listarAuditoriaApi({ tenantId, limit: 200 })
      .then((pagina) => {
        if (cancelado) return;
        setEventos(pagina.entradas.filter((e) => e.accion.startsWith("billing.")).slice(0, 8));
      })
      .catch(() => {
        // Silencioso a propósito: el timeline es complementario, un fallo
        // acá no debería tapar el resto de la sección con un error.
      })
      .finally(() => {
        if (!cancelado) setCargando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [tenantId, refreshToken]);

  if (cargando || eventos.length === 0) return null;

  return (
    <div className="mt-4 pt-4 border-t border-slate-800">
      <p className="text-xs text-slate-500 mb-2">Historial reciente</p>
      <ul className="space-y-1.5">
        {eventos.map((e) => (
          <li key={e.id} className="flex items-baseline gap-3 text-xs">
            <span className="text-slate-600 shrink-0 w-20">
              {new Date(e.creadoEn).toLocaleDateString()}
            </span>
            <span className="text-slate-400">{describirEvento(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PanelSuscripcionActiva({
  estado,
  planes,
  procesando,
  pasarelaActiva,
  tipoCambio,
  actualizandoTipoCambio,
  onActualizarTipoCambioDesdeBcrp,
  onCambiarPlan,
  onExtenderGracia,
  onCancelar,
  onReactivar,
  onForzarCobro,
  onAgregarMetodoPagoPrueba,
  onEliminar,
  onIniciarCortesia,
  onIniciarFacturacion,
  onActualizarTipoCambioOverride,
}: {
  estado: EstadoBilling & { suscripcion: Suscripcion };
  planes: Plan[];
  procesando: boolean;
  pasarelaActiva: "stub" | "culqi" | null;
  tipoCambio: TipoCambio | null;
  actualizandoTipoCambio: boolean;
  onActualizarTipoCambioDesdeBcrp: () => void;
  onCambiarPlan: (plan: string, precioReferencia: number, motivo?: string) => void;
  onExtenderGracia: (dias: number, motivo?: string) => void;
  onCancelar: (motivo?: string) => void;
  onReactivar: () => void;
  onForzarCobro: () => void;
  onAgregarMetodoPagoPrueba: () => void;
  onEliminar: () => void;
  onIniciarCortesia: (trialMeses: number) => void;
  onIniciarFacturacion: () => void;
  onActualizarTipoCambioOverride: (valor: number | null) => void;
}) {
  const { suscripcion, metodoPago } = estado;
  const [diasGracia, setDiasGracia] = useState(7);
  const [mostrarCancelar, setMostrarCancelar] = useState(false);
  const [motivoCancelar, setMotivoCancelar] = useState("");
  const [planPendiente, setPlanPendiente] = useState("");
  const [precioNuevoPlan, setPrecioNuevoPlan] = useState("");
  const [motivoNuevoPlan, setMotivoNuevoPlan] = useState("");
  const [mesesCortesia, setMesesCortesia] = useState(6);

  function eliminarConConfirmacion() {
    if (
      window.confirm(
        `¿Eliminar la suscripción completa de este tenant? Los cobros pasados NO se borran (quedan como registro contable), pero se pierde el plan/precio/ciclo actual y hay que darla de alta de nuevo. No se puede deshacer.`
      )
    ) {
      onEliminar();
    }
  }

  const puedeExtenderGracia =
    suscripcion.estado === "en_gracia" || suscripcion.estado === "suspendida";
  const puedeReactivar = ["cancelada", "suspendida", "en_gracia"].includes(suscripcion.estado);
  const puedeCobrar = ["trialing", "activa", "en_gracia", "suspendida"].includes(
    suscripcion.estado
  );
  const puedeCancelar = suscripcion.estado !== "cancelada";
  const puedeIniciarFacturacion = ["trialing", "activa"].includes(suscripcion.estado);
  const tipoCambioEfectivo = suscripcion.tipoCambioOverride ?? tipoCambio?.valor ?? null;

  function iniciarFacturacionConConfirmacion() {
    if (
      window.confirm(
        `¿Iniciar la facturación desde hoy? Esto resetea el período (próximo cobro pasa a hoy + 1 ${suscripcion.ciclo === "mensual" ? "mes" : "año"}), sin importar cuándo se dio de alta o cuándo termina la cortesía actual.`
      )
    ) {
      onIniciarFacturacion();
    }
  }

  return (
    <div className="space-y-4">
      <BannerEstado suscripcion={suscripcion} />

      <HeroSuscripcion suscripcion={suscripcion} tipoCambioEfectivo={tipoCambioEfectivo} />

      <MetodoPagoRow
        metodoFacturacion={suscripcion.metodoFacturacion}
        metodoPago={metodoPago}
        pasarelaActiva={pasarelaActiva}
        procesando={procesando}
        onAgregarMetodoPagoPrueba={onAgregarMetodoPagoPrueba}
      />

      <TipoCambioRow
        tipoCambioGlobal={tipoCambio}
        override={suscripcion.tipoCambioOverride}
        puedeFijarOverride={suscripcion.metodoFacturacion === "tarjeta"}
        actualizando={actualizandoTipoCambio}
        onActualizarDesdeBcrp={onActualizarTipoCambioDesdeBcrp}
        procesando={procesando}
        onActualizarOverride={onActualizarTipoCambioOverride}
      />

      {suscripcion.estado === "trialing" && (
        <div className="flex flex-wrap items-center gap-2 bg-slate-950/60 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-400">
          <span>
            La cortesía corre desde el alta ({fecha(suscripcion.periodoActualInicio)}). Si el tenant
            todavía no está operando en producción, reiniciá el conteo cuando arranque de verdad:
          </span>
          <select
            value={mesesCortesia}
            onChange={(e) => setMesesCortesia(Number(e.target.value))}
            disabled={procesando}
            className="bg-[#1D2124] border border-slate-600 rounded-lg px-2 py-1 text-xs text-slate-100 disabled:opacity-50"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? "mes" : "meses"}
              </option>
            ))}
          </select>
          <button
            onClick={() => onIniciarCortesia(mesesCortesia)}
            disabled={procesando}
            className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            Iniciar cortesía desde hoy
          </button>
        </div>
      )}

      {/* Acciones principales -- lo que se usa seguido. */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={planPendiente}
          disabled={procesando}
          onChange={(e) => {
            setPlanPendiente(e.target.value);
            setPrecioNuevoPlan("");
            setMotivoNuevoPlan("");
          }}
          className="bg-[#1D2124] border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-100 disabled:opacity-50"
        >
          <option value="">Cambiar plan a...</option>
          {planes
            .filter((p) => p.codigo !== suscripcion.planCodigo)
            .map((p) => (
              <option key={p.id} value={p.codigo}>
                {p.nombre}
              </option>
            ))}
        </select>

        {puedeExtenderGracia && (
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={90}
              value={diasGracia}
              onChange={(e) => setDiasGracia(Number(e.target.value))}
              disabled={procesando}
              className="w-16 bg-[#1D2124] border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-100 disabled:opacity-50"
            />
            <button
              onClick={() => onExtenderGracia(diasGracia)}
              disabled={procesando}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
            >
              Extender gracia
            </button>
          </span>
        )}

        {puedeCobrar && (
          <button
            onClick={onForzarCobro}
            disabled={procesando}
            className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            Forzar cobro
          </button>
        )}

        {puedeIniciarFacturacion && (
          <button
            onClick={iniciarFacturacionConConfirmacion}
            disabled={procesando}
            title="Resetea el período a partir de hoy y pasa a 'activa' -- para cuando el tenant arranca de verdad en producción, desacoplado de cuándo se dio de alta el registro."
            className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-100 text-xs font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            Iniciar facturación desde hoy
          </button>
        )}

        {puedeReactivar && (
          <button
            onClick={onReactivar}
            disabled={procesando}
            className="px-3 py-1.5 rounded-lg bg-emerald-950 text-emerald-400 text-xs font-medium hover:bg-emerald-900 disabled:opacity-50 transition-colors"
          >
            Reactivar
          </button>
        )}
      </div>

      {planPendiente && (
        <div className="flex flex-wrap items-end gap-2 bg-slate-950/60 border border-slate-700 rounded-lg p-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              Precio mensual nuevo (USD) para{" "}
              {planes.find((p) => p.codigo === planPendiente)?.nombre}
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              required
              value={precioNuevoPlan}
              onChange={(e) => setPrecioNuevoPlan(e.target.value)}
              placeholder="ej. 299"
              className="w-32 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
            />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-400 mb-1">Motivo (opcional)</label>
            <input
              value={motivoNuevoPlan}
              onChange={(e) => setMotivoNuevoPlan(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
            />
          </div>
          <button
            onClick={() => {
              const precio = Number(precioNuevoPlan);
              if (!precioNuevoPlan || !Number.isFinite(precio) || precio < 0) return;
              onCambiarPlan(planPendiente, precio, motivoNuevoPlan.trim() || undefined);
              setPlanPendiente("");
              setPrecioNuevoPlan("");
              setMotivoNuevoPlan("");
            }}
            disabled={procesando || !precioNuevoPlan}
            className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
          >
            Confirmar cambio de plan
          </button>
          <button
            onClick={() => setPlanPendiente("")}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Zona de riesgo -- separada y de menor peso a propósito: son
          acciones irreversibles o poco frecuentes, no deben competir
          visualmente con "Forzar cobro"/"Cambiar plan". */}
      {puedeCancelar && (
        <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-slate-800/60">
          <span className="text-[10px] uppercase tracking-wide text-slate-600">Zona de riesgo</span>
          {!mostrarCancelar && (
            <button
              onClick={() => setMostrarCancelar(true)}
              disabled={procesando}
              className="text-xs text-red-500 hover:text-red-400 underline underline-offset-2 disabled:opacity-50"
            >
              Cancelar suscripción
            </button>
          )}
          <button
            onClick={eliminarConConfirmacion}
            disabled={procesando}
            title="Borra la suscripción por completo (no solo cancelarla) -- para corregir una alta mal hecha, no para el ciclo de vida normal"
            className="text-xs text-red-500 hover:text-red-400 underline underline-offset-2 disabled:opacity-50"
          >
            Eliminar suscripción
          </button>
        </div>
      )}

      {mostrarCancelar && (
        <div className="flex flex-wrap items-center gap-2 bg-slate-950/60 border border-red-900 rounded-lg p-3">
          <input
            value={motivoCancelar}
            onChange={(e) => setMotivoCancelar(e.target.value)}
            placeholder="Motivo (opcional)"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
          <button
            onClick={() => {
              onCancelar(motivoCancelar.trim() || undefined);
              setMostrarCancelar(false);
              setMotivoCancelar("");
            }}
            disabled={procesando}
            className="px-3 py-1.5 rounded-lg bg-red-950 text-red-400 text-xs font-medium hover:bg-red-900 disabled:opacity-50 transition-colors"
          >
            Confirmar cancelación
          </button>
          <button
            onClick={() => setMostrarCancelar(false)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

/** Historial de cobros de suscripción -- byproduct automático de "Forzar
 *  cobro"/webhook, no un ledger manual. Se muestra separado y SIN acciones
 *  de edición a propósito: no "se siente la misma lista" que los cobros
 *  de implementación (eso sí es un ledger que el admin carga a mano). */
/** Saldo pendiente de un cobro -- 0 una vez que monto_pagado cubre monto
 *  (en ese punto el backend ya lo pasó a 'exitoso', no debería seguir
 *  mostrándose como deuda). */
function saldoCobro(c: CobroTenant): number {
  return Math.round((c.monto - c.montoPagado) * 100) / 100;
}

/** Único punto de "pagar" en toda la sección: un clic muestra un input ya
 *  precargado con el saldo completo (así el caso común -- pagar todo -- es
 *  un clic + Enter, sin tipear nada), pero es editable para un pago
 *  parcial. Llama siempre a registrarPagoCobroApi -- ver
 *  platformBilling.service.ts, el saldo completo y un pago parcial son el
 *  mismo camino de código en el backend. */
function AccionRegistrarPago({
  cobro,
  procesando,
  onRegistrarPago,
}: {
  cobro: CobroTenant;
  procesando: boolean;
  onRegistrarPago: (cobroId: string, montoPagado: number, fecha: string) => void;
}) {
  const saldo = saldoCobro(cobro);
  const [editando, setEditando] = useState(false);
  const [monto, setMonto] = useState(String(saldo));
  const [fecha, setFecha] = useState(hoyISO());

  if (!editando) {
    return (
      <button
        onClick={() => {
          setMonto(String(saldo));
          setFecha(hoyISO());
          setEditando(true);
        }}
        disabled={procesando}
        className="text-xs text-emerald-400 hover:text-emerald-300 underline underline-offset-2 disabled:opacity-50"
      >
        Registrar pago
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        max={saldo}
        step="0.01"
        autoFocus
        value={monto}
        onChange={(e) => setMonto(e.target.value)}
        className="w-20 px-2 py-1 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <input
        type="date"
        value={fecha}
        onChange={(e) => setFecha(e.target.value)}
        title="Cuándo pasó este pago realmente -- no tiene que ser hoy"
        className="px-2 py-1 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <button
        onClick={() => {
          const m = Number(monto);
          if (!monto || !Number.isFinite(m) || m <= 0 || m > saldo || !fecha) return;
          onRegistrarPago(cobro.id, m, fecha);
          setEditando(false);
        }}
        disabled={procesando || !monto || !fecha}
        className="px-2 py-1 rounded-lg bg-slate-100 text-slate-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
      >
        Confirmar
      </button>
      <button
        onClick={() => setEditando(false)}
        className="text-xs text-slate-500 hover:text-slate-300"
      >
        Cancelar
      </button>
    </span>
  );
}

/** "Vence DD/MM" en gris para un cobro pendiente todavía no vencido,
 *  "Venció DD/MM" en rojo si ya pasó la fecha -- mismo cálculo que hace
 *  Alertas (estado='pendiente' && fechaVencimiento < ahora), pero acá es
 *  solo texto informativo, no dispara nada por sí solo. */
function EtiquetaVencimiento({ cobro }: { cobro: CobroTenant }) {
  if (cobro.estado !== "pendiente" || !cobro.fechaVencimiento) return null;
  const vencido = new Date(cobro.fechaVencimiento) < new Date();
  return (
    <span className={vencido ? "text-red-400" : "text-slate-500"}>
      {" · "}
      {vencido ? "Venció" : "Vence"} {fecha(cobro.fechaVencimiento)}
    </span>
  );
}

function SeccionCobrosSuscripcion({
  cobros,
  procesando,
  onRegistrarPago,
}: {
  cobros: CobroTenant[];
  procesando: boolean;
  onRegistrarPago: (cobroId: string, montoPagado: number, fecha: string) => void;
}) {
  if (cobros.length === 0) return null;
  return (
    <div className="mt-4 pt-4 border-t border-slate-800">
      <p className="text-xs text-slate-500 mb-1.5">Cobros de suscripción</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[420px]">
          <tbody className="divide-y divide-slate-800">
            {cobros.map((c) => {
              const saldo = saldoCobro(c);
              return (
                <tr key={c.id} className="text-slate-300">
                  <td className="py-1.5 pr-3">{new Date(c.creadoEn).toLocaleDateString()}</td>
                  <td className="py-1.5 pr-3">
                    {c.moneda} {c.monto.toFixed(2)}
                    <EtiquetaVencimiento cobro={c} />
                  </td>
                  <td className="py-1.5 pr-3">
                    {saldo > 0 ? (
                      <span className="text-amber-400">
                        Saldo {c.moneda} {saldo.toFixed(2)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`px-2 py-0.5 rounded-full ${
                        c.estado === "exitoso"
                          ? "bg-emerald-950 text-emerald-400"
                          : c.estado === "fallido"
                            ? "bg-red-950 text-red-400"
                            : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {c.estado}
                    </span>
                    {c.estado === "fallido" && c.motivoFallo && (
                      <span className="ml-1.5 text-slate-500">{c.motivoFallo}</span>
                    )}
                  </td>
                  <td className="py-1.5 whitespace-nowrap">
                    {c.estado === "pendiente" && (
                      <AccionRegistrarPago
                        cobro={c}
                        procesando={procesando}
                        onRegistrarPago={onRegistrarPago}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function SeccionCobrosImplementacion({
  cobros,
  procesando,
  tipoCambio,
  onRegistrar,
  onRegistrarPago,
  onEditar,
  onEliminar,
}: {
  cobros: CobroTenant[];
  procesando: boolean;
  tipoCambio: TipoCambio | null;
  onRegistrar: (input: {
    monto: number;
    moneda: "USD" | "PEN";
    descripcion?: string;
    estado?: "pendiente" | "exitoso";
    fecha?: string;
    tipoCambioAplicado?: number;
  }) => void;
  onRegistrarPago: (cobroId: string, montoPagado: number, fecha: string) => void;
  onEditar: (
    cobroId: string,
    input: {
      monto?: number;
      moneda?: "USD" | "PEN";
      descripcion?: string;
      fecha?: string;
      tipoCambioAplicado?: number | null;
    }
  ) => void;
  onEliminar: (cobroId: string) => void;
}) {
  const [mostrarForm, setMostrarForm] = useState(false);
  const [monto, setMonto] = useState("");
  const [moneda, setMoneda] = useState<"USD" | "PEN">("USD");
  const [descripcion, setDescripcion] = useState("");
  const [estadoCobro, setEstadoCobro] = useState<"pendiente" | "exitoso">("exitoso");
  const [fecha, setFecha] = useState(hoyISO());
  const [tipoCambioAplicado, setTipoCambioAplicado] = useState("");
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [montoEdit, setMontoEdit] = useState("");
  const [monedaEdit, setMonedaEdit] = useState<"USD" | "PEN">("USD");
  const [descripcionEdit, setDescripcionEdit] = useState("");
  const [fechaEdit, setFechaEdit] = useState(hoyISO());
  const [tipoCambioAplicadoEdit, setTipoCambioAplicadoEdit] = useState("");

  function empezarEdicion(c: CobroTenant) {
    setEditandoId(c.id);
    setMontoEdit(String(c.monto));
    setMonedaEdit(c.moneda);
    setDescripcionEdit(c.descripcion ?? "");
    setFechaEdit((c.fechaPago ?? c.creadoEn).slice(0, 10));
    setTipoCambioAplicadoEdit(c.tipoCambioAplicado ? String(c.tipoCambioAplicado) : "");
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
        <p className="text-xs text-slate-500">Cobros de implementación</p>
        {!mostrarForm && (
          <button
            onClick={() => setMostrarForm(true)}
            disabled={procesando}
            className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 disabled:opacity-50"
          >
            + Registrar cobro de implementación
          </button>
        )}
      </div>

      {mostrarForm && (
        <div className="flex flex-wrap items-end gap-2 bg-slate-950/60 border border-slate-700 rounded-lg p-3 mb-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Monto</label>
            <input
              type="number"
              min={0}
              step="0.01"
              required
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              placeholder="ej. 10000"
              className="w-32 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Moneda</label>
            <select
              value={moneda}
              onChange={(e) => {
                setMoneda(e.target.value as "USD" | "PEN");
                setTipoCambioAplicado("");
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
            >
              <option value="USD">USD</option>
              <option value="PEN">PEN</option>
            </select>
          </div>
          {estadoCobro === "exitoso" && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Fecha del pago</label>
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                title="Cuándo pasó el pago realmente -- no tiene que ser hoy"
                className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
              />
            </div>
          )}
          {moneda === "PEN" && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">TC pactado</label>
              <input
                type="number"
                min={0}
                step="0.01"
                required
                value={tipoCambioAplicado}
                onChange={(e) => setTipoCambioAplicado(e.target.value)}
                placeholder={`ej. ${tipoCambio?.valor.toFixed(2) ?? "3.75"} (el de ESE día, no el actual)`}
                title="Obligatorio en PEN -- el TC que se pactó con el cliente ese día, no el TC global de hoy"
                className="w-40 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
              />
            </div>
          )}
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-400 mb-1">Descripción (opcional)</label>
            <input
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="ej. Adelanto implementación ERP"
              className="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Estado</label>
            <select
              value={estadoCobro}
              onChange={(e) => setEstadoCobro(e.target.value as "pendiente" | "exitoso")}
              title="Pendiente: cuota pactada (ej. saldo) que todavía no se cobró"
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
            >
              <option value="exitoso">Pagado ahora</option>
              <option value="pendiente">Pendiente de cobro</option>
            </select>
          </div>
          <button
            onClick={() => {
              const m = Number(monto);
              if (!monto || !Number.isFinite(m) || m <= 0) return;
              const tc = Number(tipoCambioAplicado);
              if (moneda === "PEN" && (!tipoCambioAplicado || !Number.isFinite(tc) || tc <= 0))
                return;
              onRegistrar({
                monto: m,
                moneda,
                descripcion: descripcion.trim() || undefined,
                estado: estadoCobro,
                fecha: estadoCobro === "exitoso" ? fecha || undefined : undefined,
                tipoCambioAplicado: moneda === "PEN" ? tc : undefined,
              });
              setMostrarForm(false);
              setMonto("");
              setDescripcion("");
              setEstadoCobro("exitoso");
              setFecha(hoyISO());
              setTipoCambioAplicado("");
            }}
            disabled={procesando || !monto || (moneda === "PEN" && !tipoCambioAplicado)}
            className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
          >
            Registrar cobro
          </button>
          <button
            onClick={() => setMostrarForm(false)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Cancelar
          </button>
        </div>
      )}

      {cobros.length === 0 ? (
        <p className="text-xs text-slate-500">Sin cobros de implementación todavía.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[420px]">
            <tbody className="divide-y divide-slate-800">
              {cobros.map((c) =>
                editandoId === c.id ? (
                  <tr key={c.id} className="text-slate-300 bg-slate-950/60">
                    <td colSpan={5} className="py-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Monto</label>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={montoEdit}
                            onChange={(e) => setMontoEdit(e.target.value)}
                            disabled={c.estado !== "pendiente"}
                            title={
                              c.estado !== "pendiente"
                                ? "Solo editable mientras el cobro sigue pendiente"
                                : undefined
                            }
                            className="w-28 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 disabled:opacity-50"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Moneda</label>
                          <select
                            value={monedaEdit}
                            onChange={(e) => setMonedaEdit(e.target.value as "USD" | "PEN")}
                            disabled={c.estado !== "pendiente"}
                            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 disabled:opacity-50"
                          >
                            <option value="USD">USD</option>
                            <option value="PEN">PEN</option>
                          </select>
                        </div>
                        {c.estado === "pendiente" ? (
                          <p className="text-xs text-slate-600 self-end pb-2">
                            La fecha del pago se completa al registrar el pago (todavía no pasó).
                          </p>
                        ) : (
                          <div>
                            <label className="block text-xs text-slate-400 mb-1">
                              Fecha del pago
                            </label>
                            <input
                              type="date"
                              value={fechaEdit}
                              onChange={(e) => setFechaEdit(e.target.value)}
                              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
                            />
                          </div>
                        )}
                        {monedaEdit === "PEN" && (
                          <div>
                            <label className="block text-xs text-slate-400 mb-1">TC pactado</label>
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={tipoCambioAplicadoEdit}
                              onChange={(e) => setTipoCambioAplicadoEdit(e.target.value)}
                              placeholder="ej. 3.38"
                              className="w-28 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
                            />
                          </div>
                        )}
                        <div className="flex-1 min-w-[160px]">
                          <label className="block text-xs text-slate-400 mb-1">Descripción</label>
                          <input
                            value={descripcionEdit}
                            onChange={(e) => setDescripcionEdit(e.target.value)}
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
                          />
                        </div>
                        <button
                          onClick={() => {
                            const tc = Number(tipoCambioAplicadoEdit);
                            if (
                              monedaEdit === "PEN" &&
                              (!tipoCambioAplicadoEdit || !Number.isFinite(tc) || tc <= 0)
                            ) {
                              return;
                            }
                            const input: {
                              monto?: number;
                              moneda?: "USD" | "PEN";
                              descripcion?: string;
                              fecha?: string;
                              tipoCambioAplicado?: number | null;
                            } = {
                              descripcion: descripcionEdit.trim() || undefined,
                              fecha: c.estado !== "pendiente" ? fechaEdit || undefined : undefined,
                              tipoCambioAplicado: monedaEdit === "PEN" ? tc : null,
                            };
                            if (c.estado === "pendiente") {
                              const m = Number(montoEdit);
                              if (!montoEdit || !Number.isFinite(m) || m <= 0) return;
                              input.monto = m;
                              input.moneda = monedaEdit;
                            }
                            onEditar(c.id, input);
                            setEditandoId(null);
                          }}
                          disabled={procesando || (monedaEdit === "PEN" && !tipoCambioAplicadoEdit)}
                          className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-900 text-xs font-medium hover:bg-white disabled:opacity-50 transition-colors"
                        >
                          Guardar
                        </button>
                        <button
                          onClick={() => setEditandoId(null)}
                          className="text-xs text-slate-500 hover:text-slate-300"
                        >
                          Cancelar
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id} className="text-slate-300">
                    <td className="py-1.5 pr-3">
                      {new Date(c.fechaPago ?? c.creadoEn).toLocaleDateString()}
                    </td>
                    <td className="py-1.5 pr-3">
                      {c.moneda} {c.monto.toFixed(2)}
                      {c.tipoCambioAplicado && (
                        <span className="text-slate-500">
                          {" "}
                          · TC {c.tipoCambioAplicado.toFixed(2)}
                        </span>
                      )}
                      {c.descripcion && <span className="text-slate-500"> · {c.descripcion}</span>}
                      <EtiquetaVencimiento cobro={c} />
                    </td>
                    <td className="py-1.5 pr-3">
                      {saldoCobro(c) > 0 ? (
                        <span className="text-amber-400">
                          Saldo {c.moneda} {saldoCobro(c).toFixed(2)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-1.5">
                      <span
                        className={`px-2 py-0.5 rounded-full ${
                          c.estado === "exitoso"
                            ? "bg-emerald-950 text-emerald-400"
                            : c.estado === "fallido"
                              ? "bg-red-950 text-red-400"
                              : "bg-slate-800 text-slate-400"
                        }`}
                      >
                        {c.estado}
                      </span>
                    </td>
                    <td className="py-1.5 pl-3 space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => empezarEdicion(c)}
                        disabled={procesando}
                        className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 disabled:opacity-50"
                      >
                        Editar
                      </button>
                      {c.estado === "pendiente" && (
                        <AccionRegistrarPago
                          cobro={c}
                          procesando={procesando}
                          onRegistrarPago={onRegistrarPago}
                        />
                      )}
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `¿Eliminar este cobro de implementación (${c.moneda} ${c.monto.toFixed(2)}${c.descripcion ? ` · ${c.descripcion}` : ""})? No se puede deshacer.`
                            )
                          ) {
                            onEliminar(c.id);
                          }
                        }}
                        disabled={procesando}
                        className="text-xs text-red-500 hover:text-red-400 underline underline-offset-2 disabled:opacity-50"
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Empty state guiado: contexto corto + el form de alta dentro de una
 *  "card" propia, en vez de un párrafo plano seguido de inputs sueltos. */
function EmptyStateAlta({
  planes,
  procesando,
  tipoCambio,
  actualizandoTipoCambio,
  onActualizarTipoCambioDesdeBcrp,
  onCrear,
}: {
  planes: Plan[];
  procesando: boolean;
  tipoCambio: TipoCambio | null;
  actualizandoTipoCambio: boolean;
  onActualizarTipoCambioDesdeBcrp: () => void;
  onCrear: (input: {
    plan: string;
    ciclo: "mensual" | "anual";
    metodoFacturacion: "tarjeta" | "transferencia";
    precioReferencia?: number;
    trialMeses?: number;
    tipoCambioOverride?: number;
  }) => void;
}) {
  return (
    <div>
      <div className="mb-4">
        <p className="text-sm text-slate-200 mb-1">Este tenant todavía no tiene una suscripción</p>
        <p className="text-xs text-slate-500">
          Dala de alta con el plan y precio negociados para empezar a facturar — o dejala en
          cortesía si el arranque en producción todavía no está confirmado.
        </p>
      </div>
      <div className="bg-slate-950/40 border border-slate-800 rounded-lg p-4">
        <FormAltaSuscripcion
          planes={planes}
          procesando={procesando}
          tipoCambio={tipoCambio}
          actualizandoTipoCambio={actualizandoTipoCambio}
          onActualizarTipoCambioDesdeBcrp={onActualizarTipoCambioDesdeBcrp}
          onCrear={onCrear}
        />
      </div>
    </div>
  );
}

function FormAltaSuscripcion({
  planes,
  procesando,
  tipoCambio,
  actualizandoTipoCambio,
  onActualizarTipoCambioDesdeBcrp,
  onCrear,
}: {
  planes: Plan[];
  procesando: boolean;
  tipoCambio: TipoCambio | null;
  actualizandoTipoCambio: boolean;
  onActualizarTipoCambioDesdeBcrp: () => void;
  onCrear: (input: {
    plan: string;
    ciclo: "mensual" | "anual";
    metodoFacturacion: "tarjeta" | "transferencia";
    precioReferencia?: number;
    trialMeses?: number;
    tipoCambioOverride?: number;
  }) => void;
}) {
  const [plan, setPlan] = useState("");
  const [ciclo, setCiclo] = useState<"mensual" | "anual">("mensual");
  const [metodoFacturacion, setMetodoFacturacion] = useState<"tarjeta" | "transferencia">(
    "transferencia"
  );
  const [precioReferencia, setPrecioReferencia] = useState("");
  const [trialMeses, setTrialMeses] = useState(0);
  const [tipoCambioOverride, setTipoCambioOverride] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!plan) return;
    onCrear({
      plan,
      ciclo,
      metodoFacturacion,
      // Ausente = el backend intenta usar el precio de lista del plan, que
      // hoy ningún plan tiene cargado -- por eso este campo es requerido en
      // la práctica (ver precioListaDelPlan en platformBilling.service.ts).
      precioReferencia: precioReferencia ? Number(precioReferencia) : undefined,
      trialMeses: trialMeses || undefined,
      tipoCambioOverride:
        metodoFacturacion === "tarjeta" && tipoCambioOverride
          ? Number(tipoCambioOverride)
          : undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <select
          required
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        >
          <option value="">Elegir plan...</option>
          {planes.map((p) => (
            <option key={p.id} value={p.codigo}>
              {p.nombre}
            </option>
          ))}
        </select>
        <select
          value={ciclo}
          onChange={(e) => setCiclo(e.target.value as "mensual" | "anual")}
          className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        >
          <option value="mensual">Mensual</option>
          <option value="anual">Anual</option>
        </select>
        <select
          value={metodoFacturacion}
          onChange={(e) => setMetodoFacturacion(e.target.value as "tarjeta" | "transferencia")}
          className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        >
          <option value="transferencia">Transferencia</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
        <input
          type="number"
          min={0}
          step="0.01"
          required
          value={precioReferencia}
          onChange={(e) => setPrecioReferencia(e.target.value)}
          placeholder="Precio mensual (USD), ej. 149"
          className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
        />
        {metodoFacturacion === "tarjeta" ? (
          <input
            type="number"
            min={0}
            step="0.01"
            value={tipoCambioOverride}
            onChange={(e) => setTipoCambioOverride(e.target.value)}
            placeholder={`TC propio (opcional; en blanco = global, USD 1 = PEN ${tipoCambio?.valor.toFixed(2) ?? "—"})`}
            title="Tasa pactada fija para este cliente -- excepción, no la norma. Vacío usa el TC global de plataforma."
            className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
          />
        ) : (
          <div className="flex items-center px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/40 text-xs text-slate-500">
            TC global de referencia: USD 1 = PEN {tipoCambio?.valor.toFixed(2) ?? "—"}
          </div>
        )}
        <select
          value={trialMeses}
          onChange={(e) => setTrialMeses(Number(e.target.value))}
          title="Exoneración comercial negociada con el cliente -- no es un trial de producto"
          className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30 sm:col-span-2"
        >
          <option value={0}>Sin cortesía (cobra desde el alta)</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? "mes" : "meses"} de cortesía
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {tipoCambio && <span>TC global act. {fecha(tipoCambio.creadoEn)}</span>}
        <button
          type="button"
          onClick={onActualizarTipoCambioDesdeBcrp}
          disabled={actualizandoTipoCambio}
          title="Trae el último valor publicado por el BCRP (TC interbancario venta) y lo guarda como el nuevo TC global"
          className="text-slate-500 hover:text-slate-300 underline underline-offset-2 disabled:opacity-50"
        >
          {actualizandoTipoCambio ? "Actualizando..." : "↻ Actualizar TC desde API"}
        </button>
      </div>
      <button
        type="submit"
        disabled={procesando || !plan}
        className="px-4 py-2 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors"
      >
        {procesando ? "Creando..." : "Dar de alta la suscripción"}
      </button>
    </form>
  );
}
