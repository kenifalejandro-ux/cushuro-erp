// client/src/components/iperc/IpercView.tsx
import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";

interface Iperc {
  id: number;
  tipo: "continuo" | "especifico";
  fecha: string;
  turno: string | null;
  area_frente: string;
  placa_codigo: string | null;
  tarea_especifica: string | null;
  usuario_nombre: string;
  estado: "borrador" | "aprobado" | "rechazado";
  creado_en: string;
}

interface LineaBase {
  id: number;
  proceso_actividad: string;
  area_frente: string | null;
  estado: "borrador" | "aprobado" | "rechazado";
  creado_en: string;
}

interface Equipo {
  id: number;
  placa_codigo: string;
}

interface ItemForm {
  etapa_actividad: string;
  peligro: string;
  riesgo: string;
  probabilidad: number;
  severidad: number;
  medidas_control: string;
}

const ITEM_VACIO: ItemForm = {
  etapa_actividad: "",
  peligro: "",
  riesgo: "",
  probabilidad: 1,
  severidad: 1,
  medidas_control: "",
};

function EstadoBadge({ estado }: { estado: string }) {
  const estilos: Record<string, string> = {
    aprobado: "text-emerald-600",
    rechazado: "text-red-500",
    borrador: "text-amber-500",
  };
  return (
    <span className={`font-bold capitalize ${estilos[estado] ?? "text-slate-500"}`}>{estado}</span>
  );
}

function actualizarItem(
  items: ItemForm[],
  setItems: (v: ItemForm[]) => void,
  i: number,
  campo: keyof ItemForm,
  valor: string | number
) {
  const nuevos = [...items];
  nuevos[i] = { ...nuevos[i], [campo]: valor };
  setItems(nuevos);
}

function ItemsEditor({
  items,
  setItems,
}: {
  items: ItemForm[];
  setItems: (v: ItemForm[]) => void;
}) {
  return (
    <div className="space-y-4 border-t pt-4">
      <label className="text-xs font-bold text-slate-500 uppercase">Ítems de riesgo</label>
      {items.map((item, i) => (
        <div key={i} className="bg-slate-50 rounded-xl p-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="Etapa/actividad"
              required
              className="border border-slate-200 rounded-lg p-2 text-sm outline-none"
              value={item.etapa_actividad}
              onChange={(e) =>
                actualizarItem(items, setItems, i, "etapa_actividad", e.target.value)
              }
            />
            <input
              placeholder="Peligro"
              required
              className="border border-slate-200 rounded-lg p-2 text-sm outline-none"
              value={item.peligro}
              onChange={(e) => actualizarItem(items, setItems, i, "peligro", e.target.value)}
            />
          </div>
          <input
            placeholder="Riesgo"
            required
            className="w-full border border-slate-200 rounded-lg p-2 text-sm outline-none"
            value={item.riesgo}
            onChange={(e) => actualizarItem(items, setItems, i, "riesgo", e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-500 flex items-center gap-2">
              Probabilidad (1-4)
              <select
                className="border border-slate-200 rounded-lg p-1 text-sm"
                value={item.probabilidad}
                onChange={(e) =>
                  actualizarItem(items, setItems, i, "probabilidad", Number(e.target.value))
                }
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500 flex items-center gap-2">
              Severidad (1-4)
              <select
                className="border border-slate-200 rounded-lg p-1 text-sm"
                value={item.severidad}
                onChange={(e) =>
                  actualizarItem(items, setItems, i, "severidad", Number(e.target.value))
                }
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            placeholder="Medidas de control"
            required
            className="w-full border border-slate-200 rounded-lg p-2 text-sm outline-none"
            value={item.medidas_control}
            onChange={(e) => actualizarItem(items, setItems, i, "medidas_control", e.target.value)}
          />
          {items.length > 1 && (
            <button
              type="button"
              onClick={() => setItems(items.filter((_, idx) => idx !== i))}
              className="text-xs text-red-500 hover:underline"
            >
              Quitar ítem
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setItems([...items, { ...ITEM_VACIO }])}
        className="text-sm text-slate-600 hover:text-slate-900 font-medium"
      >
        + Agregar ítem
      </button>
    </div>
  );
}

export default function IpercView() {
  const [subTab, setSubTab] = useState<"iperc" | "lineasBase">("iperc");
  const [ipercs, setIpercs] = useState<Iperc[]>([]);
  const [lineasBase, setLineasBase] = useState<LineaBase[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);

  // Paginación por cursor (ver ChecklistsView.tsx y
  // src/server/shared/utils/pagination.ts): mismo criterio, solo
  // Anterior/Siguiente, sin salto a página arbitraria.
  const [cursorIpercs, setCursorIpercs] = useState<number | null>(null);
  const [historialCursorIpercs, setHistorialCursorIpercs] = useState<(number | null)[]>([]);
  const [siguienteCursorIpercs, setSiguienteCursorIpercs] = useState<number | null>(null);
  const [hayMasIpercs, setHayMasIpercs] = useState(false);

  const [modalIpercAbierto, setModalIpercAbierto] = useState(false);
  const [modalLineaBaseAbierto, setModalLineaBaseAbierto] = useState(false);

  const [formIperc, setFormIperc] = useState({
    tipo: "continuo" as "continuo" | "especifico",
    area_frente: "",
    turno: "",
    equipo_id: "",
    tarea_especifica: "",
  });
  const [itemsIperc, setItemsIperc] = useState<ItemForm[]>([{ ...ITEM_VACIO }]);

  const [formLineaBase, setFormLineaBase] = useState({ proceso_actividad: "", area_frente: "" });
  const [itemsLineaBase, setItemsLineaBase] = useState<ItemForm[]>([{ ...ITEM_VACIO }]);

  const cargarIpercs = async (cursor: number | null = null) => {
    const params = new URLSearchParams({ pageSize: "50" });
    if (cursor !== null) params.set("cursor", String(cursor));
    const res = await apiFetch(`/api/erp/iperc?${params}`);
    const body = await res.json();
    setIpercs(Array.isArray(body.data) ? body.data : []);
    setCursorIpercs(cursor);
    setSiguienteCursorIpercs(body.pagination?.nextCursor ?? null);
    setHayMasIpercs(Boolean(body.pagination?.hasMore));
  };

  const handleSiguienteIpercs = () => {
    if (!hayMasIpercs) return;
    setHistorialCursorIpercs((h) => [...h, cursorIpercs]);
    cargarIpercs(siguienteCursorIpercs);
  };

  const handleAnteriorIpercs = () => {
    setHistorialCursorIpercs((h) => {
      const nuevo = [...h];
      const anterior = nuevo.pop() ?? null;
      cargarIpercs(anterior);
      return nuevo;
    });
  };

  const cargarLineasBase = async () => {
    const res = await apiFetch("/api/erp/iperc/lineas-base?page=1&pageSize=50");
    const body = await res.json();
    setLineasBase(Array.isArray(body.data) ? body.data : []);
  };

  const cargarEquipos = async () => {
    const res = await apiFetch("/api/erp/equipos?page=1&pageSize=200");
    const body = await res.json();
    setEquipos(Array.isArray(body.data) ? body.data : []);
  };

  const cargarTodo = useCallback(async () => {
    setLoading(true);
    await Promise.all([cargarIpercs(), cargarLineasBase(), cargarEquipos()]);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTodo();
  }, [cargarTodo]);

  // Cuando la cola offline termina de drenar, los IPERC que se crearon sin
  // señal ya existen del lado del servidor -- recargar es lo que hace que
  // aparezcan en el listado sin que el operario tenga que refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) {
        setHistorialCursorIpercs([]);
        cargarIpercs();
      }
    });
  }, []);

  // ── IPERC ─────────────────────────────────────────────────────────────
  const handleCrearIperc = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiFetch("/api/erp/iperc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Se genera SIEMPRE, haya señal o no: protege también la respuesta
        // que se pierde de vuelta después de que el servidor ya guardó
        // (puede pasar con la señal perfecta al apretar el botón). Es el
        // mismo valor que viaja en la cola si hay que reintentar (ver
        // client/src/offline/), nunca se regenera.
        cliente_uuid: crypto.randomUUID(),
        tipo: formIperc.tipo,
        area_frente: formIperc.area_frente,
        turno: formIperc.turno || undefined,
        equipo_id: formIperc.equipo_id ? Number(formIperc.equipo_id) : undefined,
        tarea_especifica: formIperc.tipo === "especifico" ? formIperc.tarea_especifica : undefined,
        items: itemsIperc,
      }),
    });
    if (res.ok) {
      setModalIpercAbierto(false);
      setFormIperc({
        tipo: "continuo",
        area_frente: "",
        turno: "",
        equipo_id: "",
        tarea_especifica: "",
      });
      setItemsIperc([{ ...ITEM_VACIO }]);

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga el listado: sin señal el GET también
      // falla, y el IPERC todavía no existe del lado del servidor.
      if (res.status === 202) {
        alert(
          "Sin conexión: el IPERC quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      setHistorialCursorIpercs([]);
      cargarIpercs();
    } else {
      const body = await res.json().catch(() => ({}));
      alert(body.message || "Error al crear el IPERC.");
    }
  };

  const handleCambiarEstadoIperc = async (id: number, estado: "aprobado" | "rechazado") => {
    const res = await apiFetch(`/api/erp/iperc/${id}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado }),
    });
    if (res.ok) cargarIpercs(cursorIpercs);
    else alert("No tienes permiso para cambiar el estado (solo admin).");
  };

  const handleEliminarIperc = async (id: number) => {
    if (!window.confirm("¿Eliminar este IPERC?")) return;
    const res = await apiFetch(`/api/erp/iperc/${id}`, { method: "DELETE" });
    if (res.ok) {
      setHistorialCursorIpercs([]);
      cargarIpercs();
    } else {
      alert("No se pudo eliminar (solo admin).");
    }
  };

  // ── Línea Base ────────────────────────────────────────────────────────
  const handleCrearLineaBase = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiFetch("/api/erp/iperc/lineas-base", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proceso_actividad: formLineaBase.proceso_actividad,
        area_frente: formLineaBase.area_frente || undefined,
        items: itemsLineaBase,
      }),
    });
    if (res.ok) {
      setModalLineaBaseAbierto(false);
      setFormLineaBase({ proceso_actividad: "", area_frente: "" });
      setItemsLineaBase([{ ...ITEM_VACIO }]);
      cargarLineasBase();
    } else {
      alert("Error al crear la línea base.");
    }
  };

  const handleCambiarEstadoLineaBase = async (id: number, estado: "aprobado" | "rechazado") => {
    const res = await apiFetch(`/api/erp/iperc/lineas-base/${id}/estado`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado }),
    });
    if (res.ok) cargarLineasBase();
    else alert("No tienes permiso para cambiar el estado (solo admin).");
  };

  const handleEliminarLineaBase = async (id: number) => {
    if (!window.confirm("¿Eliminar esta línea base?")) return;
    const res = await apiFetch(`/api/erp/iperc/lineas-base/${id}`, { method: "DELETE" });
    if (res.ok) cargarLineasBase();
    else alert("No se pudo eliminar (solo admin).");
  };

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">IPERC</h1>
          <p className="text-slate-500">
            Identificación de peligros, evaluación de riesgos y controles
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSubTab("iperc")}
            className={`px-4 py-2 rounded-xl font-medium text-sm ${subTab === "iperc" ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}
          >
            IPERC
          </button>
          <button
            onClick={() => setSubTab("lineasBase")}
            className={`px-4 py-2 rounded-xl font-medium text-sm ${subTab === "lineasBase" ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}
          >
            Líneas Base
          </button>
        </div>
      </div>

      {subTab === "iperc" && (
        <>
          <div className="flex justify-end mb-6">
            <button
              onClick={() => setModalIpercAbierto(true)}
              className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
            >
              + Nuevo IPERC
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    tipo
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    área/frente
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    equipo
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    realizado por
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    estado
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                    acciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ipercs.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-5 text-sm capitalize text-slate-600">{i.tipo}</td>
                    <td className="p-5 text-sm text-slate-800">{i.area_frente}</td>
                    <td className="p-5 font-mono text-sm text-slate-500">
                      {i.placa_codigo || "---"}
                    </td>
                    <td className="p-5 text-sm text-slate-500">{i.usuario_nombre}</td>
                    <td className="p-5 text-sm">
                      <EstadoBadge estado={i.estado} />
                    </td>
                    <td className="p-5 text-right space-x-1">
                      {i.estado === "borrador" && (
                        <>
                          <button
                            onClick={() => handleCambiarEstadoIperc(i.id, "aprobado")}
                            className="px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 rounded-lg"
                            title="Aprobar"
                          >
                            ✔ Aprobar
                          </button>
                          <button
                            onClick={() => handleCambiarEstadoIperc(i.id, "rechazado")}
                            className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded-lg"
                            title="Rechazar"
                          >
                            ✕ Rechazar
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => handleEliminarIperc(i.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        title="Eliminar"
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between items-center mt-4">
            <button
              onClick={handleAnteriorIpercs}
              disabled={historialCursorIpercs.length === 0}
              className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              ← Anterior
            </button>
            <button
              onClick={handleSiguienteIpercs}
              disabled={!hayMasIpercs}
              className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              Siguiente →
            </button>
          </div>
        </>
      )}

      {subTab === "lineasBase" && (
        <>
          <div className="flex justify-end mb-6">
            <button
              onClick={() => setModalLineaBaseAbierto(true)}
              className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
            >
              + Nueva Línea Base
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    proceso/actividad
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    área/frente
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    estado
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                    acciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lineasBase.map((lb) => (
                  <tr key={lb.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-5 text-sm font-semibold text-slate-800">
                      {lb.proceso_actividad}
                    </td>
                    <td className="p-5 text-sm text-slate-500">{lb.area_frente || "---"}</td>
                    <td className="p-5 text-sm">
                      <EstadoBadge estado={lb.estado} />
                    </td>
                    <td className="p-5 text-right space-x-1">
                      {lb.estado === "borrador" && (
                        <>
                          <button
                            onClick={() => handleCambiarEstadoLineaBase(lb.id, "aprobado")}
                            className="px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 rounded-lg"
                          >
                            ✔ Aprobar
                          </button>
                          <button
                            onClick={() => handleCambiarEstadoLineaBase(lb.id, "rechazado")}
                            className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded-lg"
                          >
                            ✕ Rechazar
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => handleEliminarLineaBase(lb.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                        title="Eliminar"
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Modal: nuevo IPERC */}
      {modalIpercAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nuevo IPERC</h3>
              <button
                onClick={() => setModalIpercAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearIperc} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">Tipo</label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white"
                    value={formIperc.tipo}
                    onChange={(e) =>
                      setFormIperc({
                        ...formIperc,
                        tipo: e.target.value as "continuo" | "especifico",
                      })
                    }
                  >
                    <option value="continuo">Continuo</option>
                    <option value="especifico">Específico</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">
                    Equipo (opcional)
                  </label>
                  <select
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white"
                    value={formIperc.equipo_id}
                    onChange={(e) => setFormIperc({ ...formIperc, equipo_id: e.target.value })}
                  >
                    <option value="">Ninguno</option>
                    {equipos.map((eq) => (
                      <option key={eq.id} value={eq.id}>
                        {eq.placa_codigo}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">Área/frente</label>
                <input
                  type="text"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={formIperc.area_frente}
                  onChange={(e) => setFormIperc({ ...formIperc, area_frente: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Turno (opcional)
                </label>
                <input
                  type="text"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={formIperc.turno}
                  onChange={(e) => setFormIperc({ ...formIperc, turno: e.target.value })}
                />
              </div>
              {formIperc.tipo === "especifico" && (
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">
                    Tarea específica
                  </label>
                  <input
                    type="text"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={formIperc.tarea_especifica}
                    onChange={(e) =>
                      setFormIperc({ ...formIperc, tarea_especifica: e.target.value })
                    }
                  />
                </div>
              )}

              <ItemsEditor items={itemsIperc} setItems={setItemsIperc} />

              <button
                type="submit"
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4"
              >
                Registrar IPERC
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Modal: nueva línea base */}
      {modalLineaBaseAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nueva Línea Base</h3>
              <button
                onClick={() => setModalLineaBaseAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearLineaBase} className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Proceso/actividad
                </label>
                <input
                  type="text"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={formLineaBase.proceso_actividad}
                  onChange={(e) =>
                    setFormLineaBase({ ...formLineaBase, proceso_actividad: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Área/frente (opcional)
                </label>
                <input
                  type="text"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={formLineaBase.area_frente}
                  onChange={(e) =>
                    setFormLineaBase({ ...formLineaBase, area_frente: e.target.value })
                  }
                />
              </div>

              <ItemsEditor items={itemsLineaBase} setItems={setItemsLineaBase} />

              <button
                type="submit"
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4"
              >
                Crear Línea Base
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
