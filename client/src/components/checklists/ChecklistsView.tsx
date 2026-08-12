// client/src/components/checklists/ChecklistsView.tsx
import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";

interface Plantilla {
  id: number;
  nombre: string;
  tipo_equipo: string | null;
  creado_en: string;
}

interface PlantillaConItems extends Plantilla {
  items: { id: number; descripcion: string; orden: number }[];
}

interface Checklist {
  id: number;
  equipo_id: number;
  placa_codigo: string;
  plantilla_id: number;
  usuario_nombre: string;
  fecha: string;
  turno: string | null;
  resultado: string;
  observaciones_generales: string | null;
  creado_en: string;
}

interface Equipo {
  id: number;
  placa_codigo: string;
}

type ItemEstado = "bien" | "malo" | "na";

export default function ChecklistsView() {
  const [subTab, setSubTab] = useState<"checklists" | "plantillas">("checklists");

  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [plantillas, setPlantillas] = useState<Plantilla[]>([]);
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);

  // Paginación por cursor (no por número de página, ver
  // src/server/shared/utils/pagination.ts): el historial de cursores
  // vistos es lo que permite "Anterior" sin poder saltar a una página
  // arbitraria — igual que Equipos/Repuestos/Documentos, que tampoco lo
  // permiten.
  const [cursorChecklists, setCursorChecklists] = useState<number | null>(null);
  const [historialCursorChecklists, setHistorialCursorChecklists] = useState<(number | null)[]>([]);
  const [siguienteCursorChecklists, setSiguienteCursorChecklists] = useState<number | null>(null);
  const [hayMasChecklists, setHayMasChecklists] = useState(false);

  const [modalPlantillaAbierto, setModalPlantillaAbierto] = useState(false);
  const [modalChecklistAbierto, setModalChecklistAbierto] = useState(false);

  const [formPlantilla, setFormPlantilla] = useState({ nombre: "", tipo_equipo: "", items: [""] });

  const [formChecklist, setFormChecklist] = useState({
    equipo_id: "",
    plantilla_id: "",
    turno: "",
    observaciones_generales: "",
  });
  const [plantillaSeleccionada, setPlantillaSeleccionada] = useState<PlantillaConItems | null>(
    null
  );
  const [estadosItems, setEstadosItems] = useState<
    Record<number, { estado: ItemEstado; observacion: string }>
  >({});

  const cargarChecklists = async (cursor: number | null = null) => {
    const params = new URLSearchParams({ pageSize: "50" });
    if (cursor !== null) params.set("cursor", String(cursor));
    const res = await apiFetch(`/api/erp/checklists?${params}`);
    const body = await res.json();
    setChecklists(Array.isArray(body.data) ? body.data : []);
    setCursorChecklists(cursor);
    setSiguienteCursorChecklists(body.pagination?.nextCursor ?? null);
    setHayMasChecklists(Boolean(body.pagination?.hasMore));
  };

  const handleSiguienteChecklists = () => {
    if (!hayMasChecklists) return;
    setHistorialCursorChecklists((h) => [...h, cursorChecklists]);
    cargarChecklists(siguienteCursorChecklists);
  };

  const handleAnteriorChecklists = () => {
    setHistorialCursorChecklists((h) => {
      const nuevo = [...h];
      const anterior = nuevo.pop() ?? null;
      cargarChecklists(anterior);
      return nuevo;
    });
  };

  const cargarPlantillas = async () => {
    const res = await apiFetch("/api/erp/checklists/plantillas?page=1&pageSize=50");
    const body = await res.json();
    setPlantillas(Array.isArray(body.data) ? body.data : []);
  };

  const cargarEquipos = async () => {
    const res = await apiFetch("/api/erp/equipos?page=1&pageSize=200");
    const body = await res.json();
    setEquipos(Array.isArray(body.data) ? body.data : []);
  };

  const cargarTodo = useCallback(async () => {
    setLoading(true);
    // allSettled y no all: sin señal, estos GET fallan por red. Con
    // Promise.all una sola falla cortaba la función antes del
    // setLoading(false) y la pantalla quedaba clavada en "Cargando..."
    // para siempre. Acá cada carga falla por su cuenta y las que el
    // service worker sí tenga cacheadas (equipos, plantillas — ver
    // vite.config.js) igual llenan el formulario para poder trabajar.
    await Promise.allSettled([cargarChecklists(), cargarPlantillas(), cargarEquipos()]);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTodo();
  }, [cargarTodo]);

  // Cuando la cola offline termina de drenar, los checklists que se
  // llenaron sin señal ya existen del lado del servidor — recargar es lo
  // que hace que aparezcan en el listado sin que el operario tenga que
  // refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) {
        setHistorialCursorChecklists([]);
        cargarChecklists();
      }
    });
  }, []);

  // ── Plantillas ────────────────────────────────────────────────────────
  const handleCrearPlantilla = async (e: React.FormEvent) => {
    e.preventDefault();
    const items = formPlantilla.items
      .map((d, i) => ({ descripcion: d, orden: i }))
      .filter((it) => it.descripcion.trim());
    if (items.length === 0) {
      alert("La plantilla necesita al menos un ítem.");
      return;
    }
    const res = await apiFetch("/api/erp/checklists/plantillas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: formPlantilla.nombre,
        tipo_equipo: formPlantilla.tipo_equipo || undefined,
        items,
      }),
    });
    if (res.ok) {
      setModalPlantillaAbierto(false);
      setFormPlantilla({ nombre: "", tipo_equipo: "", items: [""] });
      cargarPlantillas();
    } else {
      alert("Error al crear la plantilla.");
    }
  };

  const handleEliminarPlantilla = async (id: number) => {
    if (!window.confirm("¿Eliminar esta plantilla?")) return;
    const res = await apiFetch(`/api/erp/checklists/plantillas/${id}`, { method: "DELETE" });
    if (res.ok) cargarPlantillas();
    else alert("No se pudo eliminar (puede estar en uso).");
  };

  // ── Checklists ────────────────────────────────────────────────────────
  const handleSeleccionarPlantilla = async (plantillaId: string) => {
    setFormChecklist({ ...formChecklist, plantilla_id: plantillaId });
    if (!plantillaId) {
      setPlantillaSeleccionada(null);
      return;
    }
    try {
      const res = await apiFetch(`/api/erp/checklists/plantillas/${plantillaId}`);
      const plantilla = await res.json();
      setPlantillaSeleccionada(plantilla);
      const iniciales: Record<number, { estado: ItemEstado; observacion: string }> = {};
      for (const item of plantilla.items) iniciales[item.id] = { estado: "bien", observacion: "" };
      setEstadosItems(iniciales);
    } catch {
      // Sin señal y sin esta plantilla en el caché del service worker: no
      // se pueden mostrar los ítems, así que no hay checklist que llenar.
      // Se avisa en vez de dejar el modal a medias sin explicación.
      setPlantillaSeleccionada(null);
      alert(
        "No se pudo cargar esta plantilla sin conexión. Abrila una vez con señal para poder usarla en campo."
      );
    }
  };

  const handleCrearChecklist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plantillaSeleccionada || !formChecklist.equipo_id) return;

    const items = plantillaSeleccionada.items.map((it) => ({
      descripcion: it.descripcion,
      estado: estadosItems[it.id]?.estado ?? "bien",
      observacion: estadosItems[it.id]?.observacion || undefined,
    }));

    const res = await apiFetch("/api/erp/checklists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Se genera SIEMPRE, haya señal o no en este instante: lo que
        // protege no es solo el caso offline, sino el de la respuesta que
        // se pierde de vuelta después de que el servidor ya guardó. Ese
        // puede pasar con la señal perfecta al apretar el botón. Es el
        // mismo valor que después viaja en la cola si hay que reintentar
        // (ver client/src/offline/), nunca se regenera.
        cliente_uuid: crypto.randomUUID(),
        equipo_id: Number(formChecklist.equipo_id),
        plantilla_id: Number(formChecklist.plantilla_id),
        turno: formChecklist.turno || undefined,
        observaciones_generales: formChecklist.observaciones_generales || undefined,
        items,
      }),
    });
    if (res.ok) {
      setModalChecklistAbierto(false);
      setFormChecklist({ equipo_id: "", plantilla_id: "", turno: "", observaciones_generales: "" });
      setPlantillaSeleccionada(null);

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga el listado: sin señal el GET también
      // falla, y el checklist todavía no existe del lado del servidor.
      if (res.status === 202) {
        alert(
          "Sin conexión: el checklist quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      setHistorialCursorChecklists([]);
      cargarChecklists();
    } else {
      alert("Error al crear el checklist.");
    }
  };

  const handleEliminarChecklist = async (id: number) => {
    if (!window.confirm("¿Eliminar este checklist?")) return;
    const res = await apiFetch(`/api/erp/checklists/${id}`, { method: "DELETE" });
    if (res.ok) {
      setHistorialCursorChecklists([]);
      cargarChecklists();
    } else {
      alert("No se pudo eliminar el checklist.");
    }
  };

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Checklists de pre-uso</h1>
          <p className="text-slate-500">Plantillas e inspecciones de equipos</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSubTab("checklists")}
            className={`px-4 py-2 rounded-xl font-medium text-sm ${subTab === "checklists" ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}
          >
            Checklists
          </button>
          <button
            onClick={() => setSubTab("plantillas")}
            className={`px-4 py-2 rounded-xl font-medium text-sm ${subTab === "plantillas" ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}
          >
            Plantillas
          </button>
        </div>
      </div>

      {subTab === "checklists" && (
        <>
          <div className="flex justify-end mb-6">
            <button
              onClick={() => {
                if (plantillas.length === 0) {
                  alert("Primero crea una plantilla.");
                  return;
                }
                setModalChecklistAbierto(true);
              }}
              className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
            >
              + Nuevo Checklist
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    equipo
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    fecha
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    turno
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    realizado por
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    resultado
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                    eliminar
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {checklists.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-5 font-mono text-sm font-semibold text-slate-800">
                      {c.placa_codigo}
                    </td>
                    <td className="p-5 text-sm text-slate-600">{c.fecha}</td>
                    <td className="p-5 text-sm text-slate-500">{c.turno || "---"}</td>
                    <td className="p-5 text-sm text-slate-500">{c.usuario_nombre}</td>
                    <td className="p-5 text-sm">
                      <span
                        className={`font-bold ${c.resultado === "bien" ? "text-emerald-600" : "text-red-500"}`}
                      >
                        {c.resultado === "bien" ? "Bien" : "Observado"}
                      </span>
                    </td>
                    <td className="p-5 text-right">
                      <button
                        onClick={() => handleEliminarChecklist(c.id)}
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
              onClick={handleAnteriorChecklists}
              disabled={historialCursorChecklists.length === 0}
              className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              ← Anterior
            </button>
            <button
              onClick={handleSiguienteChecklists}
              disabled={!hayMasChecklists}
              className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              Siguiente →
            </button>
          </div>
        </>
      )}

      {subTab === "plantillas" && (
        <>
          <div className="flex justify-end mb-6">
            <button
              onClick={() => setModalPlantillaAbierto(true)}
              className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
            >
              + Nueva Plantilla
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    nombre
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                    tipo de equipo
                  </th>
                  <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                    eliminar
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {plantillas.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-5 text-sm font-semibold text-slate-800">{p.nombre}</td>
                    <td className="p-5 text-sm text-slate-500">{p.tipo_equipo || "Uso general"}</td>
                    <td className="p-5 text-right">
                      <button
                        onClick={() => handleEliminarPlantilla(p.id)}
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

      {/* Modal: nueva plantilla */}
      {modalPlantillaAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nueva Plantilla</h3>
              <button
                onClick={() => setModalPlantillaAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearPlantilla} className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">Nombre</label>
                <input
                  type="text"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formPlantilla.nombre}
                  onChange={(e) => setFormPlantilla({ ...formPlantilla, nombre: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Tipo de equipo (opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ej: Camioneta"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formPlantilla.tipo_equipo}
                  onChange={(e) =>
                    setFormPlantilla({ ...formPlantilla, tipo_equipo: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Ítems a revisar
                </label>
                {formPlantilla.items.map((valor, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      required
                      placeholder={`Ítem ${i + 1}`}
                      className="flex-1 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                      value={valor}
                      onChange={(e) => {
                        const items = [...formPlantilla.items];
                        items[i] = e.target.value;
                        setFormPlantilla({ ...formPlantilla, items });
                      }}
                    />
                    {formPlantilla.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setFormPlantilla({
                            ...formPlantilla,
                            items: formPlantilla.items.filter((_, idx) => idx !== i),
                          })
                        }
                        className="px-3 text-slate-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setFormPlantilla({ ...formPlantilla, items: [...formPlantilla.items, ""] })
                  }
                  className="text-sm text-slate-600 hover:text-slate-900 font-medium"
                >
                  + Agregar ítem
                </button>
              </div>
              <button
                type="submit"
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4"
              >
                Crear Plantilla
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Modal: nuevo checklist */}
      {modalChecklistAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nuevo Checklist</h3>
              <button
                onClick={() => {
                  setModalChecklistAbierto(false);
                  setPlantillaSeleccionada(null);
                }}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearChecklist} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  {/* htmlFor + id, no un <label> suelto al lado: sin la
                      asociación explícita un lector de pantalla anuncia el
                      select sin nombre. Mismo patrón que LoginPage.tsx. */}
                  <label
                    htmlFor="checklist-equipo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Equipo
                  </label>
                  <select
                    id="checklist-equipo"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formChecklist.equipo_id}
                    onChange={(e) =>
                      setFormChecklist({ ...formChecklist, equipo_id: e.target.value })
                    }
                  >
                    <option value="">Selecciona...</option>
                    {equipos.map((eq) => (
                      <option key={eq.id} value={eq.id}>
                        {eq.placa_codigo}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="checklist-plantilla"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Plantilla
                  </label>
                  <select
                    id="checklist-plantilla"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formChecklist.plantilla_id}
                    onChange={(e) => handleSeleccionarPlantilla(e.target.value)}
                  >
                    <option value="">Selecciona...</option>
                    {plantillas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="checklist-turno"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Turno (opcional)
                </label>
                <input
                  id="checklist-turno"
                  type="text"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formChecklist.turno}
                  onChange={(e) => setFormChecklist({ ...formChecklist, turno: e.target.value })}
                />
              </div>

              {plantillaSeleccionada && (
                <div className="space-y-3 border-t pt-4">
                  <label className="text-xs font-bold text-slate-500 uppercase">Ítems</label>
                  {plantillaSeleccionada.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 bg-slate-50 rounded-xl p-3"
                    >
                      <span className="text-sm text-slate-700">{item.descripcion}</span>
                      <select
                        className="border border-slate-200 rounded-lg p-2 text-sm outline-none bg-white"
                        value={estadosItems[item.id]?.estado ?? "bien"}
                        onChange={(e) =>
                          setEstadosItems({
                            ...estadosItems,
                            [item.id]: {
                              ...estadosItems[item.id],
                              estado: e.target.value as ItemEstado,
                            },
                          })
                        }
                      >
                        <option value="bien">Bien</option>
                        <option value="malo">Malo</option>
                        <option value="na">N/A</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="checklist-observaciones"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Observaciones generales (opcional)
                </label>
                <textarea
                  id="checklist-observaciones"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formChecklist.observaciones_generales}
                  onChange={(e) =>
                    setFormChecklist({ ...formChecklist, observaciones_generales: e.target.value })
                  }
                />
              </div>

              <button
                type="submit"
                disabled={!plantillaSeleccionada}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-40"
              >
                Registrar Checklist
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
