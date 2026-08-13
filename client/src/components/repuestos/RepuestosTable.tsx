/**client/src/components/repuestos/repuestostable.tsx */

import { useState, useEffect, useCallback } from "react";

import { apiFetch } from "../../services/apiClient";

// 1. ESTRUCTURA DE DATOS: Define qué campos tiene un repuesto
interface Repuesto {
  id: number;
  codigo: string;
  nombre: string;
  categoria: string;
  stock: number;
  stock_minimo: number;
  stock_maximo: number;
  precio: string;
  fecha: string; // <-- Agrega esta línea para que reconozca r.fecha
}

export default function RepuestosTable() {
  // --- ESTADOS (CAMPOS DE MEMORIA) ---
  const [repuestos, setRepuestos] = useState<Repuesto[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  //  Crea la función para abrir el modo edición:
  const openEditModal = (r: Repuesto) => {
    setEditingId(r.id); // Guardamos el ID que vamos a editar
    setFormData({
      codigo: r.codigo,
      nombre: r.nombre,
      categoria: r.categoria,
      stock: r.stock,
      stock_minimo: r.stock_minimo,
      stock_maximo: r.stock_maximo,
      precio: Number(r.precio),
    });
    setIsModalOpen(true);
  };

  // Estado para el formulario (se usa tanto para crear como para editar)
  const [formData, setFormData] = useState({
    codigo: "",
    nombre: "",
    categoria: "General",
    stock: 0,
    stock_minimo: 5,
    stock_maximo: 30,
    precio: 0,
  });

  const fetchRepuestos = useCallback(
    async (paginaAConsultar: number = page) => {
      try {
        const res = await apiFetch(`/api/erp/repuestos?page=${paginaAConsultar}&pageSize=50`);
        const body = await res.json();
        setRepuestos(Array.isArray(body.data) ? body.data : []);
        setTotalPages(body.pagination?.totalPages ?? 1);
        setLoading(false);
      } catch (err) {
        console.error("Error al obtener repuestos:", err);
        setLoading(false);
      }
    },
    [page]
  );

  // 2. CARGA: Trae los datos de la base de datos (paginado) al montar y al cambiar de página
  useEffect(() => {
    // Patrón estándar de carga (setLoading(true) -> fetch -> setLoading(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRepuestos(page);
  }, [page, fetchRepuestos]);

  // 3. LÓGICA DE ELIMINACIÓN: Borra un registro por ID
  const handleDelete = async (id: number) => {
    // 1. Pedir confirmación al usuario
    if (!window.confirm("¿Estás seguro de que deseas eliminar este repuesto?")) return;

    try {
      // 2. Llamada a la API
      const res = await apiFetch(`/api/erp/repuestos/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        // 3. Recargar la página actual (no solo filtrar en memoria, para que
        // el total y las páginas restantes sigan siendo correctos)
        fetchRepuestos(page);
        alert("Eliminado con éxito");
      } else {
        alert("Error: El servidor no permitió eliminar el registro.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  // 4. CARGA MASIVA EXCEL: Procesa archivos .xlsx
  // xlsx se carga on-demand (import dinámico) para que su chunk no viaje
  // en el bundle inicial: solo hace falta cuando se usa esta importación.
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const bstr = evt.target?.result;
      const XLSX = await import("xlsx");
      const wb = XLSX.read(bstr, { type: "binary" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws);

      apiFetch("/api/erp/repuestos/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(() => {
        alert("Importación masiva completada");
        fetchRepuestos();
      });
    };
    reader.readAsBinaryString(file);
  };

  // 5. REGISTRO MANUAL: Envía el formulario a la base de datos
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Si hay editingId es PUT (editar), si no es POST (crear)
    const url = editingId ? `/api/erp/repuestos/${editingId}` : "/api/erp/repuestos";

    const method = editingId ? "PUT" : "POST";

    try {
      const res = await apiFetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        setIsModalOpen(false);
        setEditingId(null);
        fetchRepuestos();
        setFormData({
          codigo: "",
          nombre: "",
          categoria: "General",
          stock: 0,
          stock_minimo: 5,
          stock_maximo: 30,
          precio: 0,
        });
      }
    } catch {
      alert("Error al procesar la solicitud en PHP.");
    }
  };

  // 6. BUSCADOR: filtra solo dentro de la página actual (50 filas) — como
  // el listado ahora pagina en el servidor, buscar en todo el inventario
  // requeriría mandar el término al backend (pendiente, no en este cambio).
  const filteredRepuestos = repuestos.filter(
    (r) =>
      r.nombre.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.codigo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return <div className="p-20 text-center text-slate-500">Cargando...</div>;

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      {/* CABECERA: Título y Botones de acción */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-10">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Inventario de Repuestos</h1>
          <p className="text-slate-500">Control de existencias y carga masiva</p>
        </div>

        <div className="flex items-center gap-3">
          <label className="px-4 py-2.5 bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 rounded-xl cursor-pointer transition-all flex items-center gap-2">
            <span>📊 Importar Excel</span>
            <input
              type="file"
              accept=".xlsx, .xls"
              className="hidden"
              onChange={handleExcelUpload}
            />
          </label>
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
          >
            + Nuevo Repuesto
          </button>
        </div>
      </div>

      {/* BARRA DE BÚSQUEDA */}
      <div className="mb-8">
        <input
          type="text"
          placeholder="Buscar repuesto por nombre o código..."
          className="w-full bg-white border border-slate-200 rounded-2xl px-5 py-4 outline-none focus:ring-2 focus:ring-slate-900 transition-all shadow-sm"
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* TABLA DE DATOS */}
      <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">id</th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                codigo
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                nombre
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                categoria
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                stock
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                stock_minimo
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                stock_maximo
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">
                precio
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                fecha-creación
              </th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                editar-eliminar
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredRepuestos.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="p-5 text-sm text-slate-400">#{r.id}</td>
                <td className="p-5 font-mono text-sm text-slate-500">{r.codigo}</td>
                <td className="p-5 text-sm font-semibold text-slate-800">{r.nombre}</td>
                <td className="p-5 text-sm text-slate-600">{r.categoria}</td>
                <td className="p-5 text-sm">
                  <span
                    className={`font-bold ${
                      Number(r.stock) <= Number(r.stock_minimo)
                        ? "text-red-500" // Alerta: Stock bajo
                        : Number(r.stock) >= Number(r.stock_maximo)
                          ? "text-orange-500" // Alerta: Sobre-stock
                          : "text-emerald-600" // Todo bien
                    }`}
                  >
                    {r.stock}
                  </span>
                </td>
                <td className="p-5 text-sm text-slate-400 font-medium">{r.stock_minimo}</td>
                <td className="p-5 text-sm text-slate-400 font-medium">{r.stock_maximo}</td>

                <td className="p-5 text-sm font-medium text-slate-900">
                  S/ {Number(r.precio).toFixed(2)}
                </td>

                {/* FECHA DE CREACIÓN (Mapeada desde el backend) */}
                <td className="p-5 text-sm text-slate-500 text-right">{r.fecha || "---"}</td>

                {/* ACCIONES (EDITAR - ELIMINAR) */}
                <td className="p-5 text-right space-x-2">
                  <button
                    onClick={() => openEditModal(r)}
                    className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                    title="Editar"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => handleDelete(r.id)}
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

      {/* PAGINACIÓN */}
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

      {/* MODAL PARA NUEVO REGISTRO */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Nuevo Repuesto</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            {/* FORMULARIO PARA NUEVO REGISTRO */}

            <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
              {/* Fila 1: Código */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-codigo"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Código del Repuesto
                </label>
                <input
                  id="repuesto-codigo"
                  type="text"
                  placeholder="Ej: FIL-001"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.codigo}
                  onChange={(e) => setFormData({ ...formData, codigo: e.target.value })}
                />
              </div>

              {/* Fila 2: Nombre */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-nombre"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Nombre del Producto
                </label>
                <input
                  id="repuesto-nombre"
                  type="text"
                  placeholder="Nombre completo"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.nombre}
                  onChange={(e) => setFormData({ ...formData, nombre: e.target.value })}
                />
              </div>

              {/* Fila 3: Categoría (Selección) */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-categoria"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Categoría
                </label>
                <select
                  id="repuesto-categoria"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.categoria}
                  onChange={(e) => setFormData({ ...formData, categoria: e.target.value })}
                >
                  <option value="Motor">Motor</option>
                  <option value="Frenos">Frenos</option>
                  <option value="Eléctrico">Eléctrico</option>
                  <option value="Refrigeración">Refrigeración</option>
                  <option value="Suspensión">Suspensión</option>
                  <option value="Alimentación">Alimentación</option>
                </select>
              </div>

              {/* Fila 4: Stocks (Dos columnas) */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="repuesto-stock-actual"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Stock Actual
                  </label>
                  <input
                    id="repuesto-stock-actual"
                    type="number"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.stock}
                    onChange={(e) => setFormData({ ...formData, stock: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1 grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="repuesto-stock-minimo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Stock Mínimo
                    </label>
                    <input
                      id="repuesto-stock-minimo"
                      type="number"
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                      value={formData.stock_minimo}
                      onChange={(e) =>
                        setFormData({ ...formData, stock_minimo: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="repuesto-stock-maximo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Stock Máximo
                    </label>
                    <input
                      id="repuesto-stock-maximo"
                      type="number"
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                      value={formData.stock_maximo}
                      onChange={(e) =>
                        setFormData({ ...formData, stock_maximo: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Fila 5: Precio */}
              <div className="space-y-1">
                <label
                  htmlFor="repuesto-precio"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Precio Unitario (S/)
                </label>
                <input
                  id="repuesto-precio"
                  type="number"
                  step="0.01"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.precio}
                  onChange={(e) => setFormData({ ...formData, precio: Number(e.target.value) })}
                />
              </div>

              <button
                type="submit"
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4"
              >
                {editingId ? "Guardar Cambios" : "Registrar en Inventario"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
