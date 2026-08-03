// client/src/components/equipos/EquiposTable.tsx
import { useState, useEffect } from 'react';
import { apiFetch } from '../../services/apiClient';

interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  activo: boolean;
  creado_en: string;
}

const TIPOS_COMUNES = ['Camioneta', 'Cargador frontal', 'Excavadora', 'Volquete', 'Perforadora', 'Otro'];

export default function EquiposTable() {
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [formData, setFormData] = useState({
    placa_codigo: '', tipo: TIPOS_COMUNES[0], marca: '', modelo: '',
  });

  useEffect(() => {
    fetchEquipos(page);
  }, [page]);

  const fetchEquipos = async (paginaAConsultar: number = page) => {
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
  };

  const openEditModal = (e: Equipo) => {
    setEditingId(e.id);
    setFormData({ placa_codigo: e.placa_codigo, tipo: e.tipo, marca: e.marca ?? '', modelo: e.modelo ?? '' });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este equipo?")) return;
    try {
      const res = await apiFetch(`/api/erp/equipos/${id}`, { method: 'DELETE' });
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
    const url = editingId ? `/api/erp/equipos/${editingId}` : '/api/erp/equipos';
    const method = editingId ? 'PUT' : 'POST';
    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        setIsModalOpen(false);
        setEditingId(null);
        setFormData({ placa_codigo: '', tipo: TIPOS_COMUNES[0], marca: '', modelo: '' });
        fetchEquipos(page);
      } else {
        alert("Error: revisa los datos del equipo.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  const filteredEquipos = equipos.filter((e) =>
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
          onClick={() => { setEditingId(null); setFormData({ placa_codigo: '', tipo: TIPOS_COMUNES[0], marca: '', modelo: '' }); setIsModalOpen(true); }}
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
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">placa/código</th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">tipo</th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">marca</th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">modelo</th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest">estado</th>
              <th className="p-5 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">editar-eliminar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredEquipos.map((e) => (
              <tr key={e.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="p-5 font-mono text-sm font-semibold text-slate-800">{e.placa_codigo}</td>
                <td className="p-5 text-sm text-slate-600">{e.tipo}</td>
                <td className="p-5 text-sm text-slate-500">{e.marca || '---'}</td>
                <td className="p-5 text-sm text-slate-500">{e.modelo || '---'}</td>
                <td className="p-5 text-sm">
                  <span className={`font-bold ${e.activo ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {e.activo ? 'Activo' : 'Inactivo'}
                  </span>
                </td>
                <td className="p-5 text-right space-x-2">
                  <button onClick={() => openEditModal(e)} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all" title="Editar">✏️</button>
                  <button onClick={() => handleDelete(e.id)} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all" title="Eliminar">🗑️</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 px-1">
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50">← Anterior</button>
        <span className="text-sm text-slate-400">Página {page} de {totalPages}</span>
        <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50">Siguiente →</button>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl animate-in zoom-in duration-200">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">{editingId ? 'Editar Equipo' : 'Nuevo Equipo'}</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-900 text-2xl">×</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">Placa / Código</label>
                <input
                  type="text" placeholder="Ej: V-014" required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.placa_codigo}
                  onChange={(e) => setFormData({ ...formData, placa_codigo: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-500 uppercase">Tipo</label>
                <select
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                  value={formData.tipo}
                  onChange={(e) => setFormData({ ...formData, tipo: e.target.value })}
                >
                  {TIPOS_COMUNES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">Marca</label>
                  <input
                    type="text" className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.marca}
                    onChange={(e) => setFormData({ ...formData, marca: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">Modelo</label>
                  <input
                    type="text" className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.modelo}
                    onChange={(e) => setFormData({ ...formData, modelo: e.target.value })}
                  />
                </div>
              </div>
              <button type="submit" className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4">
                {editingId ? 'Guardar Cambios' : 'Registrar Equipo'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
