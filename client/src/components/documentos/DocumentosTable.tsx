/**client/src/documentos/Documentostable.tsx */

import { useEffect, useState } from "react";

interface Documento {
  id: number;
  nombre_documento: string;
  responsable: string;
  fecha_vencimiento: string;
  estado_alerta: "VENCIDO" | "POR VENCER" | "VIGENTE";
}

export default function DocumentosTable() {

  const [docs, setDocs] = useState<Documento[]>([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<any>({});
  const [editId, setEditId] = useState<number | null>(null);

  // 🟡 MODAL CONTROL
  const [openModal, setOpenModal] = useState(false);

  const load = () => {
    fetch("/api/erp/documentos")
      .then(r => r.json())
      .then(data => {
        setDocs(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => {
        setDocs([]);
        setLoading(false);
      });
  };

  useEffect(() => {
    load();
  }, []);

  const getStatusStyle = (estado: string) => {
    switch (estado) {
      case "VENCIDO":
        return "bg-red-100 text-red-600 border border-red-200";
      case "POR VENCER":
        return "bg-amber-100 text-amber-600 border border-amber-200";
      default:
        return "bg-green-100 text-green-600 border border-green-200";
    }
  };

  // ➕ CREAR
  const createDoc = async () => {
    await fetch("/api/erp/documentos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });

    setForm({});
    setOpenModal(false);
    load();
  };

  // ✏️ EDITAR
  const updateDoc = async () => {
    await fetch(`/api/erp/documentos/${editId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });

    setEditId(null);
    setForm({});
    setOpenModal(false);
    load();
  };

  // 🗑️ DELETE
  const deleteDoc = async (id: number) => {
    await fetch(`/api/erp/documentos/${id}`, {
      method: "DELETE"
    });

    load();
  };

  // 📦 EXCEL
  const uploadExcel = async (file: File) => {
    const reader = new FileReader();

    reader.onload = async (e) => {
      const json = JSON.parse(e.target?.result as string);

      await fetch("/api/erp/documentos/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json)
      });

      load();
    };

    reader.readAsText(file);
  };

  if (loading) {
    return (
      <div className="p-10 text-center text-gray-500">
        Cargando documentos...
      </div>
    );
  }

  return (
  <div className="animate-in fade-in duration-700 slide-in-from-bottom-4">

    {/* Header */}
    <div className="flex flex-col lg:flex-row lg:items-center gap-6 mb-12">

      {/* IZQUIERDA */}
      <div className="space-y-1">
        <h1 className="text-3xl lg:text-4xl font-light text-slate-800 tracking-tight">
          Documentación Legal
        </h1>
      </div>

      {/* DERECHA (BOTONES) */}
      <div className="flex items-center gap-3 ml-auto">

        {/* ➕ BOTÓN NUEVO */}
        <button
          onClick={() => {
            setForm({});
            setEditId(null);
            setOpenModal(true);
          }}
          className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors duration-200"
        >
          Nuevo Documento
        </button>

        {/* 📦 EXCEL */}
        <label className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg cursor-pointer">
          Excel
          <input
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadExcel(file);
            }}
          />
        </label>

      </div>
    </div>

    {/* MODAL ERP (NUEVO / EDITAR) */}
    {openModal && (
      <div className="fixed inset-0 bg-zinc-800/50 flex items-center justify-center">

        <div className="bg-white w-[520px] h-[320px] p-6 rounded-xl space-y-3">

          <h2 className="text-lg font-semibold">
            {editId ? "Editar Documento" : "Nuevo Documento"}
          </h2>

          <input
            className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
            placeholder="Documento"
            value={form.nombre_documento || ""}
            onChange={(e) =>
              setForm({ ...form, nombre_documento: e.target.value })
            }
          />

          <input
            className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
            placeholder="Responsable"
            value={form.responsable || ""}
            onChange={(e) =>
              setForm({ ...form, responsable: e.target.value })
            }
          />

          <input
            type="date"
            className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
            value={form.fecha_vencimiento || ""}
            onChange={(e) =>
              setForm({ ...form, fecha_vencimiento: e.target.value })
            }
          />

          <div className="flex gap-2">

            {editId ? (
              <button
                className="bg-blue-600 text-white px-4 py-2 rounded"
                onClick={updateDoc}
              >
                Actualizar
              </button>
            ) : (
              <button
                className="bg-green-600 text-white px-4 py-2 rounded"
                onClick={createDoc}
              >
                Guardar
              </button>
            )}

            <button
              className="text-gray-500"
              onClick={() => setOpenModal(false)}
            >
              Cancelar
            </button>

          </div>

        </div>

      </div>
    )}

    {/* Alert Banner */}
    {(docs.some(d => d.estado_alerta === 'VENCIDO') || docs.some(d => d.estado_alerta === 'POR VENCER')) && (
      <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-center gap-3">
          <div className="w-1.5 h-1.5 bg-amber-500 rounded-full"></div>
          <p className="text-sm text-amber-900 font-light">
            Sistema de alertas activo · Margen de notificación: 15 días
          </p>
        </div>
      </div>
    )}

    {/* TABLE */}
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">

        <table className="w-full text-left">

          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">Documento</th>
              <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">Responsable</th>
              <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">Vencimiento</th>
              <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide text-center">Estado</th>
              <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide text-right">Acciones</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100">

            {docs.length > 0 ? (
              docs.map((doc) => (
                <tr
                  key={doc.id}
                  className="hover:bg-slate-50 transition-colors duration-150"
                >

                  <td className="px-6 py-4">
                    <div className="space-y-1">
                      <p className="text-sm font-light text-slate-900">
                        {doc.nombre_documento}
                      </p>
                      <p className="text-xs text-slate-400 font-light">
                        ID: {doc.id.toString().padStart(4, '0')}
                      </p>
                    </div>
                  </td>

                  <td className="px-6 py-4">
                    <span className="text-sm font-light text-slate-600">
                      {doc.responsable}
                    </span>
                  </td>

                  <td className="px-6 py-4">
                    <div className="space-y-1">
                      <p className="text-sm font-light text-slate-900">
                        {new Date(doc.fecha_vencimiento).toLocaleDateString('es-PE', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric'
                        })}
                      </p>
                      <p className="text-xs text-slate-400 font-light">
                        {Math.ceil((new Date(doc.fecha_vencimiento).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))} días
                      </p>
                    </div>
                  </td>

                  <td className="px-6 py-4">
                    <div className="flex justify-center">
                      <div className={`px-3 py-1 rounded-md border text-xs font-medium ${getStatusStyle(doc.estado_alerta)}`}>
                        {doc.estado_alerta}
                      </div>
                    </div>
                  </td>

                  {/* ACCIONES ORDENADAS */}
                  <td className="px-6 py-4">
                    <div className="flex justify-end gap-2">

                      <button
                        className="text-blue-600"
                        onClick={() => {
                          setForm(doc);
                          setEditId(doc.id);
                          setOpenModal(true);
                        }}
                      >
                        Editar
                      </button>

                      <button
                        className="text-red-600"
                        onClick={() => deleteDoc(doc.id)}
                      >
                        Eliminar
                      </button>

                    </div>
                  </td>

                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-6 py-20">
                  <div className="text-center space-y-3">
                    <div className="inline-flex items-center justify-center w-12 h-12 bg-slate-100 rounded-lg">
                      <div className="w-4 h-4 bg-slate-300 rounded-sm"></div>
                    </div>
                    <p className="text-sm font-light text-slate-400">
                      No hay documentos registrados
                    </p>
                  </div>
                </td>
              </tr>
            )}

          </tbody>

        </table>
      </div>
    </div>
  </div>
);
}
