/**client/src/documentos/Documentostable.tsx */

import { useEffect, useState, useCallback } from "react";

import { apiFetch } from "../../services/apiClient";

interface Documento {
  id: number;
  nombre_documento: string;
  responsable: string;
  fecha_vencimiento: string;
  estado_alerta: "VENCIDO" | "POR VENCER" | "VIGENTE";
}

interface DocumentoVersion {
  id: number;
  nombre_original: string;
  mime_type: string;
  tamano_bytes: number;
  subido_en: string;
}

const MIME_TYPES_PERMITIDOS = ["application/pdf", "image/jpeg", "image/png"];
const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024;

function formatearTamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentosTable() {
  const [docs, setDocs] = useState<Documento[]>([]);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<any>({});
  const [editId, setEditId] = useState<number | null>(null);
  // Deshabilita "Guardar"/"Actualizar" mientras la request está en curso --
  // sin esto, un doble clic (o doble tap en una tablet con pantalla lenta
  // en campo) genera dos cliente_uuid distintos y crea dos documentos
  // reales: la idempotencia protege reintentos de la MISMA acción, no dos
  // clics que el sistema ve como dos acciones separadas.
  const [guardando, setGuardando] = useState(false);

  // 🟡 MODAL CONTROL
  const [openModal, setOpenModal] = useState(false);

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // 📎 ARCHIVO ADJUNTO (versiones)
  const [docArchivoId, setDocArchivoId] = useState<number | null>(null);
  const [versiones, setVersiones] = useState<DocumentoVersion[]>([]);
  const [cargandoVersiones, setCargandoVersiones] = useState(false);
  const [subiendoArchivo, setSubiendoArchivo] = useState(false);
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);

  const load = useCallback(
    (paginaAConsultar: number = page) => {
      apiFetch(`/api/erp/documentos?page=${paginaAConsultar}&pageSize=50`)
        .then((r) => r.json())
        .then((body) => {
          setDocs(Array.isArray(body.data) ? body.data : []);
          setTotalPages(body.pagination?.totalPages ?? 1);
          setLoading(false);
        })
        .catch(() => {
          setDocs([]);
          setLoading(false);
        });
    },
    [page]
  );

  useEffect(() => {
    load(page);
  }, [page, load]);

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
    if (guardando) return;

    // Chequeo ANTES de encolar/enviar, no solo confiar en el 400 del
    // servidor: si esto se llena SIN red, apiFetch nunca llega a validar
    // nada -- encolaría igual y recién al sincronizar (quién sabe cuándo)
    // el servidor lo rechazaría. Frenarlo acá evita generar una entrada
    // que va a terminar descartada sin que el operario se entere a tiempo.
    if (!form.nombre_documento?.trim() || !form.fecha_vencimiento) {
      alert("Completá el nombre del documento y la fecha de vencimiento antes de guardar.");
      return;
    }

    setGuardando(true);
    try {
      // Aviso de posible duplicado (mismo nombre + misma fecha de
      // vencimiento -- una renovación normal tiene el mismo nombre pero
      // OTRA fecha, así que no dispara esto). Best-effort a propósito: es
      // una consulta de LECTURA aparte, nunca pasa por la cola offline, así
      // que sin red simplemente no se puede avisar -- se sigue con la
      // creación normal, que si hace falta, se encola como siempre.
      if (form.nombre_documento && form.fecha_vencimiento) {
        try {
          const chequeo = await apiFetch(
            `/api/erp/documentos/duplicado?nombre=${encodeURIComponent(form.nombre_documento)}&fecha=${encodeURIComponent(form.fecha_vencimiento)}`
          );
          if (chequeo.ok) {
            const { duplicado } = await chequeo.json();
            if (
              duplicado &&
              !window.confirm(
                `Ya existe un documento "${form.nombre_documento}" con la misma fecha de vencimiento. ¿Guardar de todos modos?`
              )
            ) {
              return;
            }
          }
        } catch {
          // Sin red u otro error en el chequeo: no bloquea la creación.
        }
      }

      const res = await apiFetch("/api/erp/documentos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Se genera SIEMPRE, haya señal o no en este instante: protege
          // tanto el caso offline como el de una respuesta que se pierde de
          // vuelta después de que el servidor ya guardó (ver
          // client/src/offline/ y checklists, que usa el mismo patrón).
          cliente_uuid: crypto.randomUUID(),
          ...form,
        }),
      });

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga el listado: sin señal el GET también
      // falla, y el documento todavía no existe del lado del servidor.
      if (res.status === 202) {
        setForm({});
        setOpenModal(false);
        alert(
          "Sin conexión: el documento quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      // El schema Zod de POST / puede rechazar el envío (ej. sin fecha de
      // vencimiento) -- antes de esto Documentos no validaba nada, así que
      // esto nunca pasaba. El modal se queda abierto con lo ya tipeado en
      // vez de limpiarse como si hubiera guardado: cerrarlo acá le mostraría
      // al operario un "listo" falso para algo que el servidor rechazó.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detalle = Array.isArray(body?.errors)
          ? body.errors.map((e: { message: string }) => e.message).join(", ")
          : null;
        alert(detalle ?? "No se pudo guardar el documento.");
        return;
      }

      setForm({});
      setOpenModal(false);
      load();
    } finally {
      setGuardando(false);
    }
  };

  // ✏️ EDITAR
  const updateDoc = async () => {
    if (guardando) return;
    setGuardando(true);
    try {
      await apiFetch(`/api/erp/documentos/${editId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      setEditId(null);
      setForm({});
      setOpenModal(false);
      load();
    } finally {
      setGuardando(false);
    }
  };

  // 🗑️ DELETE
  const deleteDoc = async (id: number) => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este documento?")) return;

    try {
      const res = await apiFetch(`/api/erp/documentos/${id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        load();
      } else {
        alert("Error: el servidor no permitió eliminar el documento.");
      }
    } catch {
      alert("Error de conexión con el backend.");
    }
  };

  // 📎 ARCHIVO ADJUNTO
  const cargarVersiones = useCallback(async (documentoId: number) => {
    setCargandoVersiones(true);
    try {
      const res = await apiFetch(`/api/erp/documentos/${documentoId}/versiones`);
      const body = await res.json();
      setVersiones(res.ok && Array.isArray(body) ? body : []);
    } catch {
      setVersiones([]);
    } finally {
      setCargandoVersiones(false);
    }
  }, []);

  const abrirArchivo = (documentoId: number) => {
    setDocArchivoId(documentoId);
    setErrorArchivo(null);
    cargarVersiones(documentoId);
  };

  const subirArchivo = async (file: File) => {
    if (docArchivoId === null) return;

    if (!MIME_TYPES_PERMITIDOS.includes(file.type)) {
      setErrorArchivo("Solo se acepta PDF, JPG o PNG.");
      return;
    }
    if (file.size > TAMANO_MAXIMO_BYTES) {
      setErrorArchivo("El archivo supera el máximo permitido de 10 MB.");
      return;
    }

    setErrorArchivo(null);
    setSubiendoArchivo(true);

    const formData = new FormData();
    formData.append("archivo", file);
    // Mismo motivo que en createDoc(): se genera SIEMPRE, haya señal o no
    // en este instante -- protege tanto el caso offline como el de una
    // respuesta que se pierde después de que el servidor ya guardó (ver
    // client/src/offline/, Caso B de ADR-0002 §8).
    formData.append("cliente_uuid", crypto.randomUUID());

    try {
      const res = await apiFetch(`/api/erp/documentos/${docArchivoId}/versiones`, {
        method: "POST",
        body: formData,
      });

      if (res.status === 202) {
        setErrorArchivo(null);
        alert(
          "Sin conexión: el archivo quedó guardado en este equipo y se enviará solo cuando vuelva la señal."
        );
        return;
      }

      if (!res.ok) {
        setErrorArchivo("No se pudo subir el archivo.");
        return;
      }

      await cargarVersiones(docArchivoId);
    } catch {
      setErrorArchivo("Error de conexión con el backend.");
    } finally {
      setSubiendoArchivo(false);
    }
  };

  const descargarVersion = (versionId: number) => {
    if (docArchivoId === null) return;
    window.open(`/api/erp/documentos/${docArchivoId}/versiones/${versionId}/descarga`, "_blank");
  };

  // 📦 EXCEL
  const uploadExcel = async (file: File) => {
    const reader = new FileReader();

    reader.onload = async (e) => {
      const json = JSON.parse(e.target?.result as string);

      await apiFetch("/api/erp/documentos/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });

      load();
    };

    reader.readAsText(file);
  };

  if (loading) {
    return <div className="p-10 text-center text-gray-500">Cargando documentos...</div>;
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
              onChange={(e) => setForm({ ...form, nombre_documento: e.target.value })}
            />

            <input
              className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
              placeholder="Responsable"
              value={form.responsable || ""}
              onChange={(e) => setForm({ ...form, responsable: e.target.value })}
            />

            <input
              type="date"
              className="border p-2 border border-zinc-400 rounded-[0.5rem] w-full"
              value={form.fecha_vencimiento || ""}
              onChange={(e) => setForm({ ...form, fecha_vencimiento: e.target.value })}
            />

            <div className="flex gap-2">
              {editId ? (
                <button
                  className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
                  onClick={updateDoc}
                  disabled={guardando}
                >
                  {guardando ? "Actualizando..." : "Actualizar"}
                </button>
              ) : (
                <button
                  className="bg-green-600 text-white px-4 py-2 rounded disabled:opacity-50"
                  onClick={createDoc}
                  disabled={guardando}
                >
                  {guardando ? "Guardando..." : "Guardar"}
                </button>
              )}

              <button className="text-gray-500" onClick={() => setOpenModal(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL ARCHIVO ADJUNTO (versiones) */}
      {docArchivoId !== null && (
        <div className="fixed inset-0 bg-zinc-800/50 flex items-center justify-center">
          <div className="bg-white w-[520px] max-h-[80vh] p-6 rounded-xl space-y-4 flex flex-col">
            <h2 className="text-lg font-semibold">Archivo del documento</h2>

            <label className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg cursor-pointer text-center w-fit">
              {subiendoArchivo ? "Subiendo..." : "Subir nueva versión"}
              <input
                type="file"
                hidden
                accept="application/pdf,image/jpeg,image/png"
                disabled={subiendoArchivo}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) subirArchivo(file);
                  e.target.value = "";
                }}
              />
            </label>

            {errorArchivo && <p className="text-sm text-red-600">{errorArchivo}</p>}

            <div className="overflow-y-auto space-y-2 flex-1">
              {cargandoVersiones ? (
                <p className="text-sm text-slate-400">Cargando versiones...</p>
              ) : versiones.length > 0 ? (
                versiones.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900 truncate">{v.nombre_original}</p>
                      <p className="text-xs text-slate-400">
                        {formatearTamano(v.tamano_bytes)} ·{" "}
                        {new Date(v.subido_en).toLocaleString("es-PE")}
                      </p>
                    </div>
                    <button
                      className="text-blue-600 text-sm shrink-0 ml-3"
                      onClick={() => descargarVersion(v.id)}
                    >
                      Descargar
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-400">Todavía no se subió ningún archivo.</p>
              )}
            </div>

            <button
              className="text-gray-500 text-sm"
              onClick={() => {
                setDocArchivoId(null);
                setVersiones([]);
              }}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Alert Banner */}
      {(docs.some((d) => d.estado_alerta === "VENCIDO") ||
        docs.some((d) => d.estado_alerta === "POR VENCER")) && (
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
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Documento
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Responsable
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Vencimiento
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide text-center">
                  Estado
                </th>
                <th className="px-6 py-4 text-xs font-medium text-slate-400 uppercase tracking-wide text-right">
                  Acciones
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {docs.length > 0 ? (
                docs.map((doc) => (
                  <tr key={doc.id} className="hover:bg-slate-50 transition-colors duration-150">
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        <p className="text-sm font-light text-slate-900">{doc.nombre_documento}</p>
                        <p className="text-xs text-slate-400 font-light">
                          ID: {doc.id.toString().padStart(4, "0")}
                        </p>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <span className="text-sm font-light text-slate-600">{doc.responsable}</span>
                    </td>

                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        <p className="text-sm font-light text-slate-900">
                          {new Date(doc.fecha_vencimiento).toLocaleDateString("es-PE", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </p>
                        <p className="text-xs text-slate-400 font-light">
                          {Math.ceil(
                            (new Date(doc.fecha_vencimiento).getTime() - new Date().getTime()) /
                              (1000 * 60 * 60 * 24)
                          )}{" "}
                          días
                        </p>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <div className="flex justify-center">
                        <div
                          className={`px-3 py-1 rounded-md border text-xs font-medium ${getStatusStyle(doc.estado_alerta)}`}
                        >
                          {doc.estado_alerta}
                        </div>
                      </div>
                    </td>

                    {/* ACCIONES ORDENADAS */}
                    <td className="px-6 py-4">
                      <div className="flex justify-end gap-2">
                        <button className="text-slate-600" onClick={() => abrirArchivo(doc.id)}>
                          Archivo
                        </button>

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

                        <button className="text-red-600" onClick={() => deleteDoc(doc.id)}>
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
    </div>
  );
}
