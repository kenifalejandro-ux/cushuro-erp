/**client/src/components/combustible/CombustiblePanel */

import { useState, useEffect } from "react";

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

export default function CombustiblePanel() {
  const [tanque, setTanque] = useState<Tanque | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [loading, setLoading] = useState(true);

  {
    /** lo quitamos temporal para usar mocks */
  }
  useEffect(() => {
    apiFetch("/api/erp/combustible")
      .then((res) => res.json())
      .then((data) => {
        const t = data[0];
        setTanque(t);
        setBarWidth(Number(t.porcentaje));
        setLoading(false);
      })
      .catch((error) => {
        console.error("Error cargando combustible:", error);
        setLoading(false);
      });
  }, []);

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
        <button className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors duration-200">
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
                  Tanque Principal
                </p>
                <div className="flex items-baseline gap-2 mt-2">
                  <p className="text-4xl font-light text-slate-900">6,500</p>
                  <span className="text-slate-400 text-sm font-light">/ 10,000 L</span>
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

            {/* Info adicional */}
            <div className="grid grid-cols-2 gap-6 pt-6 border-t border-slate-100">
              <div className="space-y-1">
                <p className="text-xs text-slate-400 font-light">Consumo diario</p>
                <p className="text-2xl font-light text-slate-900">350 L</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-slate-400 font-light">Autonomía</p>
                <p className="text-2xl font-light text-slate-900">18 días</p>
              </div>
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
    </div>
  );
}
