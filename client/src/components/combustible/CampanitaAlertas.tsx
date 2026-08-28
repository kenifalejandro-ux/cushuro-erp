// client/src/components/combustible/CampanitaAlertas.tsx
//
// Campanita de alertas de combustible (hueco de talonario, vale anulado) --
// visible en el Header para gerencia (rol admin) con el módulo habilitado.
// Solo combustible por ahora (ver la decisión en el plan): si otro módulo
// necesita esto mañana, se replica el patrón, no se generaliza de entrada.

import { Bell } from "lucide-react";
import { useState } from "react";

import { useAlertasCombustibleStream } from "./useAlertasCombustibleStream";

const ETIQUETA_TIPO: Record<string, string> = {
  hueco_detectado: "Hueco de talonario",
  vale_anulado: "Vale anulado",
  sobredespacho: "Sobredespacho",
};

function formatearAlerta(alerta: { tipo: string; serie_talonario: string; n_vale: number }) {
  const vale = `${alerta.serie_talonario}-${String(alerta.n_vale).padStart(5, "0")}`;
  return `${ETIQUETA_TIPO[alerta.tipo] ?? alerta.tipo}: ${vale}`;
}

interface CampanitaAlertasProps {
  activo: boolean;
  onIrACombustible?: () => void;
}

export default function CampanitaAlertas({ activo, onIrACombustible }: CampanitaAlertasProps) {
  const [abierta, setAbierta] = useState(false);
  const { alertas, noLeidas, marcarTodasLeidas } = useAlertasCombustibleStream(activo);

  if (!activo) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setAbierta((v) => !v)}
        className="relative p-2 text-slate-400 hover:text-[#DDF500] hover:bg-white/5 rounded-md transition-all"
        title="Alertas de combustible"
      >
        <Bell size={18} />
        {noLeidas > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {noLeidas > 99 ? "99+" : noLeidas}
          </span>
        )}
      </button>

      {abierta && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAbierta(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 overflow-hidden">
            <div className="p-3 border-b border-slate-100 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-800">Alertas de combustible</span>
              {noLeidas > 0 && (
                <button
                  onClick={() => marcarTodasLeidas()}
                  className="text-xs text-slate-500 hover:text-slate-900 hover:underline"
                >
                  Marcar todas leídas
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto">
              {alertas.length === 0 ? (
                <p className="p-4 text-sm text-slate-400 text-center">Sin alertas pendientes</p>
              ) : (
                alertas.map((a) => (
                  <div key={a.id} className="p-3 border-b border-slate-50 last:border-0">
                    <p className="text-sm font-semibold text-slate-800">{formatearAlerta(a)}</p>
                    {a.tipo === "vale_anulado" && typeof a.detalle.motivo === "string" && (
                      <p className="text-xs text-slate-500 mt-0.5">Motivo: {a.detalle.motivo}</p>
                    )}
                    <p className="text-[10px] text-slate-400 mt-1">
                      {new Date(a.creado_en).toLocaleString("es-PE")}
                    </p>
                  </div>
                ))
              )}
            </div>

            {onIrACombustible && (
              <button
                onClick={() => {
                  setAbierta(false);
                  onIrACombustible();
                }}
                className="w-full p-3 text-xs font-semibold text-center text-slate-600 hover:bg-slate-50 border-t border-slate-100"
              >
                Ver todas en Combustible
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
