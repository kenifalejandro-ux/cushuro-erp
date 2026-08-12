/**client/src/components/combustible/CombustiblePanel */

import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import CountUp from "../dashboard/CountUp";

interface Tanque {
  id: number;
  tanque_nombre: string;
  capacidad_total: string;
  nivel_actual: string;
  porcentaje: string;
  fecha_actualizacion: string;
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Formato que espera un <input type="datetime-local">: sin zona horaria,
 *  con la hora LOCAL del dispositivo (no UTC) -- así "ahora" en el input
 *  coincide con el reloj real del operario en campo. */
function ahoraParaInputLocal(): string {
  const ahora = new Date();
  ahora.setMinutes(ahora.getMinutes() - ahora.getTimezoneOffset());
  return ahora.toISOString().slice(0, 16);
}

export default function CombustiblePanel() {
  const [tanque, setTanque] = useState<Tanque | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [nivel, setNivel] = useState("");
  const [leidoEn, setLeidoEn] = useState(ahoraParaInputLocal());
  const [enviando, setEnviando] = useState(false);

  // El cliente_uuid se fija al ABRIR el modal, no al apretar el botón.
  // `enviando` bloquea el botón, pero eso solo achica la ventana: si los
  // dos taps entran antes del re-render, generar el uuid en el submit
  // mandaba DOS claves distintas y el servidor creaba dos lecturas. Con el
  // uuid atado a la apertura del formulario, la deduplicación del servidor
  // cierra el hueco de verdad. Ver el mismo comentario en ChecklistsView.
  const [clienteUuid, setClienteUuid] = useState("");

  const cargarTanque = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible");
    const data = await res.json();
    const t = data[0] ?? null;
    setTanque(t);
    setBarWidth(t ? Number(t.porcentaje) : 0);
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar (setLoading(true) -> fetch ->
    // setLoading(false)), usado en toda la app -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTanque().finally(() => setLoading(false));
  }, [cargarTanque]);

  // Cuando la cola offline termina de drenar, la lectura que se cargó sin
  // señal ya existe del lado del servidor -- recargar es lo que hace que
  // nivel_actual se ponga al día sin que el operario tenga que refrescar.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) cargarTanque();
    });
  }, [cargarTanque]);

  const abrirModal = () => {
    setNivel("");
    setLeidoEn(ahoraParaInputLocal());
    // Se regenera en cada apertura: si no, la segunda lectura legítima del
    // turno reusaría la clave de la primera y el servidor devolvería
    // aquella en silencio — se perdería una lectura, que es peor que el
    // duplicado que estamos evitando.
    setClienteUuid(crypto.randomUUID());
    setModalAbierto(true);
  };

  const handleRegistrarLectura = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    if (!tanque) return;
    setEnviando(true);
    try {
      const res = await apiFetch("/api/erp/combustible/lecturas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Viene del estado (se fijó al abrir el modal), NO de un
          // crypto.randomUUID() acá adentro -- ver el comentario donde se
          // declara clienteUuid.
          cliente_uuid: clienteUuid,
          combustible_id: tanque.id,
          nivel: Number(nivel),
          leido_en: new Date(leidoEn).toISOString(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Error al registrar la lectura.");
        return;
      }

      setModalAbierto(false);

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla, y la
      // lectura todavía no existe del lado del servidor.
      if (res.status === 202) {
        alert(
          "Sin conexión: la lectura quedó guardada en este equipo y se enviará sola cuando vuelva la señal."
        );
        return;
      }

      await cargarTanque();
    } finally {
      setEnviando(false);
    }
  };

  if (loading) {
    return <div className="p-10">Cargando combustible...</div>;
  }

  if (!tanque) {
    return <div className="p-10">No hay datos disponibles.</div>;
  }

  return (
    <div className="animate-in fade-in duration-700 slide-in-from-bottom-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-12">
        <div className="space-y-1">
          <h1 className="text-3xl lg:text-4xl font-light text-slate-800 tracking-tight">
            Control de Combustible
          </h1>
          <p className="text-slate-500 text-sm font-light">Monitoreo en tiempo real de tanques</p>
        </div>
        <button
          onClick={abrirModal}
          className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors duration-200"
        >
          Actualizar Nivel
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Tanque Principal */}
        <div className="bg-white border border-slate-200 rounded-xl p-8 hover:shadow-sm transition-all duration-300">
          <div className="space-y-8">
            {/* Header del tanque */}
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {tanque.tanque_nombre}
                </p>
                <div className="flex items-baseline gap-2 mt-2">
                  <p className="text-4xl font-light text-slate-900">
                    {Number(tanque.nivel_actual).toLocaleString("es-PE")}
                  </p>
                  <span className="text-slate-400 text-sm font-light">
                    / {Number(tanque.capacidad_total).toLocaleString("es-PE")} L
                  </span>
                </div>
              </div>
              <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                <div className="w-4 h-4 bg-blue-500 rounded-sm"></div>
              </div>
            </div>

            {/* Barra de Nivel */}
            <div className="space-y-4">
              <div className="relative w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-1000 ease-out"
                  style={{ width: `${barWidth}%` }}
                ></div>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-900 font-light">
                  <CountUp end={barWidth} />% lleno
                </span>
                <span className="text-xs text-slate-400 font-light">Capacidad operativa</span>
              </div>
            </div>

            {/* Última lectura -- reemplaza los mocks de consumo/autonomía:
                no hay ningún cálculo real de consumo diario o autonomía
                todavía, mostrarlo sería inventar un dato. */}
            <div className="pt-6 border-t border-slate-100">
              <p className="text-xs text-slate-400 font-light">Última lectura registrada</p>
              <p className="text-lg font-light text-slate-900">
                {formatearFecha(tanque.fecha_actualizacion)}
              </p>
            </div>
          </div>
        </div>

        {/* Panel de Futuras Funciones */}
        <div className="bg-slate-50 border border-slate-200 border-dashed rounded-xl p-8 flex flex-col justify-center items-center text-center space-y-4">
          <div className="w-16 h-16 bg-white rounded-lg flex items-center justify-center border border-slate-200">
            <div className="w-6 h-6 bg-slate-300 rounded-sm"></div>
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-light text-slate-600">Análisis Avanzado</h3>
            <p className="text-sm text-slate-400 font-light max-w-sm leading-relaxed">
              Próximamente: historial de consumo, proyecciones y alertas inteligentes
            </p>
          </div>
        </div>
      </div>

      {/* Modal: registrar lectura */}
      {modalAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Actualizar Nivel</h3>
              <button
                onClick={() => setModalAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleRegistrarLectura} className="p-6 space-y-4">
              <div className="space-y-1">
                <label
                  htmlFor="combustible-nivel"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Nivel (litros)
                </label>
                <input
                  id="combustible-nivel"
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={nivel}
                  onChange={(e) => setNivel(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="combustible-leido-en"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha y hora de la lectura
                </label>
                <input
                  id="combustible-leido-en"
                  type="datetime-local"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={leidoEn}
                  onChange={(e) => setLeidoEn(e.target.value)}
                />
              </div>
              <button
                type="submit"
                disabled={enviando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {enviando ? "Registrando..." : "Registrar lectura"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
