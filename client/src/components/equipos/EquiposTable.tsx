// client/src/components/equipos/EquiposTable.tsx
import { useState, useEffect, useCallback } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";

interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  // Fase B de combustible (migrations/0062): qué instrumento mide este
  // equipo en un despacho de compra externa -- horómetro (horas de motor)
  // u odómetro (kilometraje), nunca los dos. null = no configurado, y un
  // despacho compra_externa a este equipo se rechaza hasta que se cargue.
  tipo_medidor: "horometro" | "odometro" | null;
  activo: boolean;
  creado_en: string;
}

const TIPOS_COMUNES = [
  "Camioneta",
  "Cargador frontal",
  "Excavadora",
  "Volquete",
  "Perforadora",
  "Otro",
];

const ETIQUETA_TIPO_MEDIDOR: Record<"" | "horometro" | "odometro", string> = {
  "": "No configurado",
  horometro: "Horómetro (horas de motor)",
  odometro: "Odómetro (kilometraje)",
};

export default function EquiposTable() {
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [enviando, setEnviando] = useState(false);

  // El cliente_uuid se fija al ABRIR el modal para CREAR (no al apretar el
  // botón): un doble tap en la tablet antes del re-render mandaría DOS
  // claves distintas si se generara en el submit, y el servidor no tendría
  // forma de distinguir eso de dos equipos legítimos. Editar no usa
  // idempotencia (sobreescribe campos existentes), así que abrir el modal
  // para editar no toca este valor -- ver el mismo comentario en
  // CombustiblePanel.tsx.
  const [clienteUuid, setClienteUuid] = useState("");

  const [formData, setFormData] = useState({
    placa_codigo: "",
    tipo: TIPOS_COMUNES[0],
    marca: "",
    modelo: "",
    tipo_medidor: "" as "" | "horometro" | "odometro",
  });

  const fetchEquipos = useCallback(async (paginaAConsultar: number) => {
    try {
      const res = await apiFetch(`/api/erp/equipos?page=${paginaAConsultar}&pageSize=50`);
      const body = await res.json();
      setEquipos(Array.isArray(body.data) ? body.data : []);
      setTotalPages(body.pagination?.totalPages ?? 1);
      setLoading(false);
    } catch (err) {
      console.error("Error al obtener equipos:", err);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar/cambiar de página (setLoading(true)
    // -> fetch -> setLoading(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEquipos(page);
  }, [page, fetchEquipos]);

  // Cuando la cola offline termina de drenar, los equipos que se dieron de
  // alta sin señal ya existen del lado del servidor -- recargar es lo que
  // hace que aparezcan en el listado sin que el operario tenga que
  // refrescar a mano.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) fetchEquipos(page);
    });
  }, [page, fetchEquipos]);

  const openEditModal = (e: Equipo) => {
    setEditingId(e.id);
    setFormData({
      placa_codigo: e.placa_codigo,
      tipo: e.tipo,
      marca: e.marca ?? "",
      modelo: e.modelo ?? "",
      tipo_medidor: e.tipo_medidor ?? "",
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este equipo?")) return;
    try {
      const res = await apiFetch(`/api/erp/equipos/${id}`, { method: "DELETE" });
      if (res.ok) {
        fetchEquipos(page);
      } else {
        alert("Error: el servidor no permitió eliminar el equipo.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    const url = editingId ? `/api/erp/equipos/${editingId}` : "/api/erp/equipos";
    const method = editingId ? "PUT" : "POST";
    // "" no es un valor válido del enum -- Zod lo rechazaría (esperaba
    // "horometro"/"odometro"/undefined, ver equipos.schema.ts). undefined
    // sí es "no configurado" para el servidor.
    const datosFormulario = {
      ...formData,
      tipo_medidor: formData.tipo_medidor === "" ? undefined : formData.tipo_medidor,
    };
    // cliente_uuid solo viaja al crear -- editar no pasa por
    // idempotentInsert() del lado del servidor.
    const body = editingId ? datosFormulario : { ...datosFormulario, cliente_uuid: clienteUuid };
    setEnviando(true);
    try {
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        alert("Error: revisa los datos del equipo.");
        return;
      }

      setIsModalOpen(false);
      setEditingId(null);
      setFormData({
        placa_codigo: "",
        tipo: TIPOS_COMUNES[0],
        marca: "",
        modelo: "",
        tipo_medidor: "",
      });

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla, y el
      // equipo todavía no existe del lado del servidor.
      if (res.status === 202) {
        // "en este dispositivo" y no "en este equipo" -- acá "equipo" es el
        // propio recurso que se está creando, "guardado en este equipo"
        // sería ambiguo. Mismo mensaje que el resto de los módulos, solo
        // con ese sustituto.
        alert(
          "Sin conexión: el equipo quedó guardado en este dispositivo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      fetchEquipos(page);
    } catch {
      alert("Error de conexión con el backend.");
    } finally {
      setEnviando(false);
    }
  };

  const filteredEquipos = equipos.filter(
    (e) =>
      e.placa_codigo.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.tipo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-10">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Equipos</h1>
          <p className="text-slate-500">Vehículos y maquinaria de la flota</p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setFormData({
              placa_codigo: "",
              tipo: TIPOS_COMUNES[0],
              marca: "",
              modelo: "",
              tipo_medidor: "",
            });
            // Se regenera en cada apertura: si no, el segundo equipo
            // legítimo que se registre reusaría la clave del primero y el
            // servidor devolvería aquel en silencio -- se perdería un
            // registro, que es peor que el duplicado que esto evita.
            setClienteUuid(crypto.randomUUID());
            setIsModalOpen(true);
          }}
          className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
        >
          + Nuevo Equipo
        </button>
      </div>

      <div className="mb-8">
        <input
          type="text"
          placeholder="Buscar por placa/código o tipo..."
          className="w-full bg-white border border-slate-200 rounded-2xl px-5 py-4 outline-none focus:ring-2 focus:ring-slate-900 transition-all shadow-sm"
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                placa/código
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                tipo
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                marca
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                modelo
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                medidor
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                estado
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                editar-eliminar
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredEquipos.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="p-5 font-mono text-sm font-semibold text-slate-800">
                  {e.placa_codigo}
                </td>
                <td className="p-5 text-sm text-slate-600">{e.tipo}</td>
                <td className="p-5 text-sm text-slate-500">{e.marca || "---"}</td>
                <td className="p-5 text-sm text-slate-500">{e.modelo || "---"}</td>
                <td className="p-5 text-sm text-slate-500">
                  {e.tipo_medidor === "horometro"
                    ? "Horómetro"
                    : e.tipo_medidor === "odometro"
                      ? "Odómetro"
                      : "---"}
                </td>
                <td className="p-5 text-sm">
                  <span className={`font-bold ${e.activo ? "text-emerald-600" : "text-slate-400"}`}>
                    {e.activo ? "Activo" : "Inactivo"}
                  </span>
                </td>
                <td className="p-5 text-right space-x-2">
                  <button
                    onClick={() => openEditModal(e)}
                    className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                    title="Editar"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => handleDelete(e.id)}
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

      <div className="flex items-center justify-between mt-4 px-1">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          ← Anterior
        </button>
        <span className="text-sm text-slate-400">
          Página {page} de {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          Siguiente →
        </button>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">{editingId ? "Editar Equipo" : "Nuevo Equipo"}</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-1">
                <label
                  htmlFor="equipo-placa-codigo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Placa / Código
                </label>
                <input
                  id="equipo-placa-codigo"
                  type="text"
                  placeholder="Ej: V-014"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.placa_codigo}
                  onChange={(e) => setFormData({ ...formData, placa_codigo: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="equipo-tipo" className="text-xs font-bold text-slate-500 uppercase">
                  Tipo
                </label>
                <select
                  id="equipo-tipo"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.tipo}
                  onChange={(e) => setFormData({ ...formData, tipo: e.target.value })}
                >
                  {TIPOS_COMUNES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="equipo-tipo-medidor"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Tipo de medidor
                </label>
                <select
                  id="equipo-tipo-medidor"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.tipo_medidor}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tipo_medidor: e.target.value as "" | "horometro" | "odometro",
                    })
                  }
                >
                  {Object.entries(ETIQUETA_TIPO_MEDIDOR).map(([valor, etiqueta]) => (
                    <option key={valor} value={valor}>
                      {etiqueta}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-400">
                  Solo hace falta para despachar combustible de compra externa a este equipo (ruta
                  Bambamarca). Un volquete se mide por horómetro, un tráiler por odómetro.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-marca"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Marca
                  </label>
                  <input
                    id="equipo-marca"
                    type="text"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.marca}
                    onChange={(e) => setFormData({ ...formData, marca: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="equipo-modelo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Modelo
                  </label>
                  <input
                    id="equipo-modelo"
                    type="text"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.modelo}
                    onChange={(e) => setFormData({ ...formData, modelo: e.target.value })}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={enviando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {editingId ? "Guardar Cambios" : "Registrar Equipo"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
