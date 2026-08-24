/**client/src/components/combustible/CombustiblePanel */

import { useState, useEffect, useCallback, useMemo } from "react";

import { suscribirseASincronizacion } from "../../offline/offlineSync";
import { apiFetch } from "../../services/apiClient";
import { ahoraParaInputLocal } from "../../utils/fechaLocal";

interface Tanque {
  id: number;
  codigo: string;
  tanque_nombre: string;
  tipo_combustible: "diesel_b5" | "gasolina_90" | "glp";
  unidad: "gal" | "L";
  tipo_punto: "fijo" | "cisterna" | "surtidor";
  ubicacion: string | null;
  capacidad_total: string;
  // null cuando el tanque no tiene ninguna lectura vigente (todas anuladas):
  // el nivel es DESCONOCIDO, no cero. Desde la migración 0059 estos tres
  // campos no son columnas, se derivan de la última lectura vigente.
  nivel_actual: string | null;
  nivel_minimo: string;
  moneda: string;
  activo: boolean;
  porcentaje: string | null;
  fecha_actualizacion: string | null;
}

/** Una fila del histórico de aforos (combustible_lecturas, migración
 *  0045). Llega de GET /combustible/:id/lecturas, ya ordenada de la más
 *  reciente a la más vieja. */
interface Lectura {
  id: number;
  nivel: string;
  leido_en: string;
  origen: string;
  // null = vigente. Una lectura anulada NUNCA se borra (ver migrations/0058):
  // queda visible como evidencia de que hubo un error, pero deja de contar
  // para el nivel del tanque y para la variación.
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulada_por_nombre: string | null;
  // Quién tomó la medición. null si el usuario fue borrado (ON DELETE SET
  // NULL, ver 0045) o si la lectura la generó el sistema (`origen` =
  // 'inicial' al crear el tanque, o 'backfill' de una migración vieja).
  registrada_por_nombre: string | null;
}

const ETIQUETA_TIPO_COMBUSTIBLE: Record<Tanque["tipo_combustible"], string> = {
  diesel_b5: "Diésel B5",
  gasolina_90: "Gasolina 90",
  glp: "GLP",
};

const ETIQUETA_TIPO_PUNTO: Record<Tanque["tipo_punto"], string> = {
  fijo: "Tanque fijo",
  cisterna: "Cisterna",
  surtidor: "Surtidor",
};

/** Cuánto tiene que moverse una lectura respecto de la anterior para
 *  merecer una confirmación, expresado como fracción de la capacidad del
 *  tanque.
 *
 *  Es relativo a la capacidad y no un número fijo a propósito: 500 L de
 *  diferencia son rutina en un tanque de 20.000 y una anomalía en uno de
 *  1.000.
 *
 *  El valor NO busca atrapar todo error de tipeo -- 18.000 en vez de 19.000
 *  pasa por debajo de cualquier umbral razonable, y para eso está la
 *  anulación con motivo. Busca que el aviso salte poco, para que cuando
 *  salte alguien lo lea: un "¿estás seguro?" en cada registro se clickea en
 *  automático a la semana y deja de servir (mismo criterio que el punto 4
 *  de docs/architecture/control-de-combustible.md sobre el ruido). */
const FRACCION_SALTO_SOSPECHOSO = 0.5;

/** Decide si una lectura merece confirmarse antes de mandarla, comparándola
 *  con el nivel vigente del tanque.
 *
 *  Pura y sin dependencias de React a propósito: el día que Repuestos (u
 *  otro módulo con histórico) necesite el mismo aviso, esto se mueve a un
 *  util compartido sin arrastrar nada. Hoy vive acá porque con un solo caso
 *  real todavía no se sabe cuál es la forma correcta de la abstracción.
 *
 *  Devuelve `null` cuando no hay nada que advertir. */
function motivoParaConfirmarLectura(
  nivelNuevo: number,
  nivelActual: number,
  capacidad: number,
  unidad: string
): string | null {
  const salto = nivelNuevo - nivelActual;
  if (Math.abs(salto) <= capacidad * FRACCION_SALTO_SOSPECHOSO) return null;

  const fmt = (n: number) => `${Math.abs(n).toLocaleString("es-PE")} ${unidad}`;
  const direccion = salto < 0 ? "menos que" : "más que";
  return (
    `Estás por registrar ${fmt(nivelNuevo)}, que es ${fmt(salto)} ${direccion} ` +
    `la última lectura (${fmt(nivelActual)}).\n\n` +
    `¿Es correcto?`
  );
}

/** Espejo de MAX_FILAS_CARGA_MASIVA_TANQUES en
 *  server/schemas/combustible.schema.ts -- mismo motivo que
 *  MAX_FILAS_IMPORTACION en RepuestosTable.tsx: avisa antes de mandar
 *  miles de filas al servidor para que las rechace. */
const MAX_FILAS_IMPORTACION = 5000;

/** Traduce la respuesta de error a algo accionable -- mismo criterio que
 *  RepuestosTable.tsx/DocumentosTable.tsx. */
async function mensajeDeErrorDelServidor(res: Response, filas: number): Promise<string> {
  if (res.status === 413) {
    return `El archivo es demasiado grande para enviarlo de una vez (${filas} filas). Dividilo en varios archivos.`;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body?.error === "cuota_excedida") {
      return `Se alcanzó el límite de tanques del plan (${body.uso} de ${body.limite}). Importar ${filas} más lo superaría.`;
    }
    return "No tenés permiso para importar tanques.";
  }
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const primero = body?.errors?.[0];
    if (primero) {
      // `field` viaja como "0.tanque_nombre" (índice de fila + columna, ver
      // validate.ts: issue.path.join(".")) -- hay que quedarse también con
      // la columna, no solo el índice: si no, el aviso dice "Fila 2:
      // Required" sin decir QUÉ campo falta.
      const partes = String(primero.field).split(".");
      const indice = Number(partes[0]);
      const campo = partes.slice(1).join(".");
      const ubicacion = Number.isInteger(indice)
        ? `Fila ${indice + 2}${campo ? ` (columna "${campo}")` : ""}: `
        : "";
      return `${ubicacion}${primero.message}`;
    }
    return "El archivo tiene filas con datos inválidos.";
  }
  return "El servidor rechazó la importación. Intentalo de nuevo.";
}

const FORM_INICIAL = {
  codigo: "",
  tanque_nombre: "",
  tipo_combustible: "diesel_b5" as Tanque["tipo_combustible"],
  unidad: "gal" as Tanque["unidad"],
  tipo_punto: "fijo" as Tanque["tipo_punto"],
  ubicacion: "",
  capacidad_total: "",
  nivel_actual: "0",
  nivel_minimo: "0",
  moneda: "PEN",
  activo: true,
};

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CombustiblePanel() {
  const [tanques, setTanques] = useState<Tanque[]>([]);
  const [loading, setLoading] = useState(true);

  // --- Alta / edición de tanque ---
  const [modalTanqueAbierto, setModalTanqueAbierto] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [formData, setFormData] = useState(FORM_INICIAL);
  // Bloquea el botón mientras el request está en vuelo Y corta un segundo
  // submit que haya entrado antes del re-render (mismo patrón que
  // handleRegistrarMovimiento en RepuestosTable.tsx) -- esto NO participa
  // de la cola offline (alta de tanque es tarea de oficina, con red), así
  // que no hace falta cliente_uuid, solo esta guarda contra el doble clic.
  const [guardando, setGuardando] = useState(false);

  // --- Importación masiva ---
  const [importando, setImportando] = useState(false);
  const [errorImportacion, setErrorImportacion] = useState<string | null>(null);
  // Un solo banner verde para TODA la pantalla (importación y lectura), no
  // uno por flujo: si no, dos avisos de éxito podrían apilarse y compiten
  // por la atención en vez de sumarla.
  const [mensajeExito, setMensajeExito] = useState<string | null>(null);

  // --- Historial de lecturas (solo lectura, GET /:id/lecturas) ---
  const [tanqueHistorial, setTanqueHistorial] = useState<Tanque | null>(null);
  const [lecturas, setLecturas] = useState<Lectura[]>([]);
  const [cargandoLecturas, setCargandoLecturas] = useState(false);
  // Lectura que se está por anular (null = nadie). El motivo va en su propio
  // formulario y no en un window.prompt(): es obligatorio y queda guardado
  // como evidencia, así que merece un campo de verdad.
  const [lecturaAAnular, setLecturaAAnular] = useState<Lectura | null>(null);
  const [motivoAnulacion, setMotivoAnulacion] = useState("");
  const [anulando, setAnulando] = useState(false);

  // --- Registrar lectura (offline-capaz, como antes) ---
  const [tanqueLectura, setTanqueLectura] = useState<Tanque | null>(null);
  const [nivel, setNivel] = useState("");
  const [leidoEn, setLeidoEn] = useState(ahoraParaInputLocal());
  // Si el operario NO tocó la hora, la lectura es "ahora" y hay que
  // mandarla con precisión de segundos. El input datetime-local recorta a
  // minutos, y esos segundos perdidos hacen que una lectura tomada recién
  // quede fechada ANTES del alta del tanque (que sí guarda segundos) -- el
  // nivel entonces no se mueve, porque gana la lectura inicial.
  const [horaEditadaAMano, setHoraEditadaAMano] = useState(false);
  const [enviandoLectura, setEnviandoLectura] = useState(false);
  // El cliente_uuid se fija al ABRIR el modal, no al apretar el botón --
  // ver el mismo comentario donde vivía antes en este archivo.
  const [clienteUuid, setClienteUuid] = useState("");

  const cargarTanques = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible");
    const data = await res.json();
    setTanques(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargarTanques().finally(() => setLoading(false));
  }, [cargarTanques]);

  // Cuando la cola offline termina de drenar, una lectura cargada sin señal
  // ya existe del lado del servidor -- recargar pone nivel_actual al día
  // sin que el operario tenga que refrescar.
  useEffect(() => {
    return suscribirseASincronizacion(({ sincronizadas }) => {
      if (sincronizadas > 0) cargarTanques();
    });
  }, [cargarTanques]);

  // --- Alta / edición ---

  const abrirModalNuevo = () => {
    setEditandoId(null);
    setFormData(FORM_INICIAL);
    setModalTanqueAbierto(true);
  };

  const abrirModalEditar = (t: Tanque) => {
    setEditandoId(t.id);
    setFormData({
      codigo: t.codigo,
      tanque_nombre: t.tanque_nombre,
      tipo_combustible: t.tipo_combustible,
      unidad: t.unidad,
      tipo_punto: t.tipo_punto,
      ubicacion: t.ubicacion ?? "",
      capacidad_total: t.capacidad_total,
      // El formulario de edición no muestra el nivel (se corrige por
      // "Registrar lectura", no por acá), así que este valor solo llena el
      // estado. Un tanque sin lecturas cae a "0" nada más para que el campo
      // controlado no quede sin valor.
      nivel_actual: t.nivel_actual ?? "0",
      nivel_minimo: t.nivel_minimo,
      moneda: t.moneda,
      activo: t.activo,
    });
    setModalTanqueAbierto(true);
  };

  const handleGuardarTanque = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardando) return;
    setGuardando(true);
    try {
      const esEdicion = editandoId !== null;
      const url = esEdicion ? `/api/erp/combustible/${editandoId}` : "/api/erp/combustible";
      const body = esEdicion
        ? {
            codigo: formData.codigo,
            tanque_nombre: formData.tanque_nombre,
            tipo_combustible: formData.tipo_combustible,
            unidad: formData.unidad,
            tipo_punto: formData.tipo_punto,
            ubicacion: formData.ubicacion || undefined,
            capacidad_total: Number(formData.capacidad_total),
            nivel_minimo: Number(formData.nivel_minimo),
            moneda: formData.moneda,
            activo: formData.activo,
          }
        : {
            codigo: formData.codigo,
            tanque_nombre: formData.tanque_nombre,
            tipo_combustible: formData.tipo_combustible,
            unidad: formData.unidad,
            tipo_punto: formData.tipo_punto,
            ubicacion: formData.ubicacion || undefined,
            capacidad_total: Number(formData.capacidad_total),
            nivel_actual: Number(formData.nivel_actual),
            nivel_minimo: Number(formData.nivel_minimo),
            moneda: formData.moneda,
          };

      const res = await apiFetch(url, {
        method: esEdicion ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody.error || "Error al guardar el tanque.");
        return;
      }

      setModalTanqueAbierto(false);
      setEditandoId(null);
      await cargarTanques();
    } finally {
      setGuardando(false);
    }
  };

  const handleDesactivar = async (t: Tanque) => {
    if (!window.confirm(`¿Desactivar el tanque "${t.tanque_nombre}"?`)) return;
    const res = await apiFetch(`/api/erp/combustible/${t.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("No se pudo desactivar el tanque.");
      return;
    }
    await cargarTanques();
  };

  // --- Importación masiva -- xlsx se carga on-demand (import dinámico)
  // para que su chunk no viaje en el bundle inicial, mismo patrón que
  // RepuestosTable.tsx. ---
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Sin esto, elegir el MISMO archivo dos veces seguidas no dispara
    // onChange -- justo lo que querría hacer alguien que corrigió su
    // planilla y la vuelve a subir con el mismo nombre.
    e.target.value = "";
    if (!file) return;

    setErrorImportacion(null);
    setMensajeExito(null);
    setImportando(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setImportando(false);
      setErrorImportacion("No se pudo leer el archivo.");
    };
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const XLSX = await import("xlsx");
        const wb = XLSX.read(bstr, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error("El archivo no tiene ninguna hoja de cálculo.");
        const data = XLSX.utils.sheet_to_json(ws);

        if (data.length === 0) throw new Error("La primera hoja está vacía.");
        if (data.length > MAX_FILAS_IMPORTACION) {
          throw new Error(
            `El archivo tiene ${data.length} filas y el máximo es ${MAX_FILAS_IMPORTACION}. Dividilo en varios archivos.`
          );
        }

        const res = await apiFetch("/api/erp/combustible/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        if (!res.ok) {
          setErrorImportacion(await mensajeDeErrorDelServidor(res, data.length));
          return;
        }

        const body = await res.json().catch(() => ({}));
        setMensajeExito(`Se importaron ${body.insertados ?? data.length} tanques correctamente.`);
        await cargarTanques();
      } catch (err) {
        setErrorImportacion(err instanceof Error ? err.message : "Error al procesar el archivo.");
      } finally {
        setImportando(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  // --- Historial de lecturas ---

  /** Trae el histórico del tanque bajo demanda (al abrir el modal), no en
   *  la carga inicial de la tabla: son datos que crecen con el trabajo de
   *  campo y solo hacen falta cuando alguien los pide -- traerlos para
   *  todos los tanques en cada render sería trabajo tirado. */
  /** Variación de cada lectura contra la ANTERIOR VIGENTE, no contra la fila
   *  de al lado. La diferencia importa: si una lectura anulada contara, un
   *  error de tipeo (500 en vez de 19.000) dejaría para siempre un -18.500
   *  seguido de un +18.500 en el historial -- exactamente el desbalance
   *  fantasma que la anulación viene a limpiar.
   *
   *  Las anuladas no reciben variación propia: ya no representan una
   *  medición del tanque. */
  const variacionPorLectura = useMemo(() => {
    const vigentes = lecturas.filter((l) => l.anulada_en === null);
    const porId = new Map<number, number>();
    // `lecturas` llega de la más reciente a la más vieja, así que la
    // anterior en el tiempo es la siguiente del array.
    vigentes.forEach((l, i) => {
      const anterior = vigentes[i + 1];
      if (anterior) porId.set(l.id, Number(l.nivel) - Number(anterior.nivel));
    });
    return porId;
  }, [lecturas]);

  const cargarLecturas = useCallback(async (tanqueId: number) => {
    setCargandoLecturas(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/${tanqueId}/lecturas?pageSize=100`);
      if (!res.ok) {
        setLecturas([]);
        return;
      }
      const body = await res.json();
      setLecturas(Array.isArray(body.data) ? body.data : []);
    } catch {
      setLecturas([]);
    } finally {
      setCargandoLecturas(false);
    }
  }, []);

  const abrirModalHistorial = async (t: Tanque) => {
    setTanqueHistorial(t);
    setLecturas([]);
    await cargarLecturas(t.id);
  };

  const handleAnularLectura = async (e: React.FormEvent) => {
    e.preventDefault();
    if (anulando || !lecturaAAnular || !tanqueHistorial) return;
    setAnulando(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/lecturas/${lecturaAAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivoAnulacion }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo anular la lectura.");
        return;
      }

      setLecturaAAnular(null);
      setMotivoAnulacion("");
      // Se recargan las DOS cosas: el historial (para ver la fila tachada) y
      // la tabla de tanques -- anular puede hacer retroceder el nivel, así
      // que la fila de afuera queda desactualizada si no se refresca.
      await cargarLecturas(tanqueHistorial.id);
      await cargarTanques();
    } finally {
      setAnulando(false);
    }
  };

  // --- Registrar lectura ---

  const abrirModalLectura = (t: Tanque) => {
    setTanqueLectura(t);
    setNivel("");
    setLeidoEn(ahoraParaInputLocal());
    setHoraEditadaAMano(false);
    // Limpia el aviso de la operación anterior: si no, quien abre el modal
    // ve todavía el "Lectura registrada" de hace un rato y no sabe si
    // corresponde a lo que está por hacer ahora.
    setMensajeExito(null);
    // Se regenera en cada apertura -- ver el motivo en el comentario
    // original de este archivo (se perdería una lectura legítima si no).
    setClienteUuid(crypto.randomUUID());
  };

  const handleRegistrarLectura = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviandoLectura || !tanqueLectura) return;

    const nivelNuevo = Number(nivel);
    const capacidad = Number(tanqueLectura.capacidad_total);

    // Bloqueo duro: un tanque no puede contener más de lo que le entra. Se
    // avisa acá además de en el servidor (que igual lo rechaza con 400) solo
    // para no hacer viajar un dato que ya se sabe imposible y poder decirlo
    // con la capacidad concreta a la vista.
    if (nivelNuevo > capacidad) {
      alert(
        `El nivel no puede superar la capacidad del tanque ` +
          `(${capacidad.toLocaleString("es-PE")} ${tanqueLectura.unidad}).`
      );
      return;
    }

    // Confirmación solo si el salto es sospechoso -- ver
    // motivoParaConfirmarLectura.
    const aviso = motivoParaConfirmarLectura(
      nivelNuevo,
      Number(tanqueLectura.nivel_actual),
      capacidad,
      tanqueLectura.unidad
    );
    if (aviso && !window.confirm(aviso)) return;

    setEnviandoLectura(true);
    try {
      const res = await apiFetch("/api/erp/combustible/lecturas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cliente_uuid: clienteUuid,
          combustible_id: tanqueLectura.id,
          nivel: Number(nivel),
          leido_en: horaEditadaAMano ? new Date(leidoEn).toISOString() : new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Error al registrar la lectura.");
        return;
      }

      const nombreDelTanque = tanqueLectura.tanque_nombre;
      const unidadDelTanque = tanqueLectura.unidad;
      setTanqueLectura(null);

      // 202 = no había red y quedó en la cola del dispositivo (ver
      // apiFetch). No se recarga: sin señal el GET también falla.
      if (res.status === 202) {
        setMensajeExito(
          `Sin conexión: la lectura de ${nivelNuevo.toLocaleString("es-PE")} ${unidadDelTanque} ` +
            `quedó guardada en este equipo y se enviará sola cuando vuelva la señal.`
        );
        return;
      }

      // Confirmación explícita: hasta acá el modal se cerraba en silencio y
      // quien registraba no tenía forma de saber si se había guardado --
      // la duda típica lleva a cargar la lectura dos veces, que es peor.
      //
      // El nivel del mensaje sale de la RESPUESTA DEL SERVIDOR, no del
      // número que se tipeó: si la lectura quedó fechada antes que otra ya
      // registrada, el tanque conserva la más reciente y el nivel resultante
      // NO es el recién cargado. Anunciar el valor tipeado ahí contradiría a
      // la tabla en la misma pantalla.
      const body = await res.json().catch(() => null);
      const nivelResultante = body?.tanque?.nivel_actual;
      setMensajeExito(
        nivelResultante != null && Number(nivelResultante) !== nivelNuevo
          ? `Lectura registrada. ${nombreDelTanque} sigue mostrando ` +
              `${Number(nivelResultante).toLocaleString("es-PE")} ${unidadDelTanque}: ` +
              `hay una lectura posterior a la que acabás de cargar.`
          : `Lectura registrada: ${nombreDelTanque} quedó en ` +
              `${nivelNuevo.toLocaleString("es-PE")} ${unidadDelTanque}.`
      );
      await cargarTanques();
    } finally {
      setEnviandoLectura(false);
    }
  };

  if (loading) {
    return <div className="p-10">Cargando combustible...</div>;
  }

  return (
    <div className="p-4 lg:p-8 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 mb-10">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Control de Combustible</h1>
          <p className="text-slate-500">Tanques y puntos de abastecimiento</p>
        </div>
        <div className="flex items-center gap-3">
          <label
            className={`px-4 py-2.5 border rounded-xl flex items-center gap-2 transition-all ${
              importando
                ? "bg-emerald-100 text-emerald-400 border-emerald-200 cursor-wait"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 cursor-pointer"
            }`}
          >
            <span>📊 {importando ? "Importando..." : "Importar Excel"}</span>
            <input
              type="file"
              accept=".xlsx, .xls"
              className="hidden"
              disabled={importando}
              onChange={handleExcelUpload}
            />
          </label>
          <button
            onClick={abrirModalNuevo}
            className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl transition-all"
          >
            + Nuevo Tanque
          </button>
        </div>
      </div>
      {errorImportacion && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-red-900 font-light flex-1">{errorImportacion}</p>
          <button
            className="text-red-400 hover:text-red-600 text-sm shrink-0"
            onClick={() => setErrorImportacion(null)}
            aria-label="Cerrar aviso de error"
          >
            ✕
          </button>
        </div>
      )}
      {mensajeExito && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <p className="text-sm text-green-900 font-light flex-1">{mensajeExito}</p>
          <button
            className="text-green-500 hover:text-green-700 text-sm shrink-0"
            onClick={() => setMensajeExito(null)}
            aria-label="Cerrar aviso de importación"
          >
            ✕
          </button>
        </div>
      )}
      {/**AGREGAR MAS COLUMNAS  */}{" "}
      {tanques.length === 0 ? (
        <div className="bg-slate-50 border border-slate-200 border-dashed rounded-xl p-10 text-center text-slate-500">
          No hay tanques registrados todavía.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Código
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Nombre
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Tipo
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Punto
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Humbral minimo
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Nivel
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Estado
                </th>
                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tanques.map((t) => {
                // Sin lecturas vigentes el nivel es desconocido: no se pinta
                // ni de rojo ni de verde, porque las dos afirmarían algo que
                // nadie midió.
                const sinNivel = t.nivel_actual === null;
                // Una sola fuente de verdad para el color: el umbral y el
                // nivel tienen que pintarse SIEMPRE igual -- si viven
                // separados, un cambio futuro en la regla los deja
                // contradiciéndose en la misma fila.
                const bajoUmbral = Number(t.nivel_actual) <= Number(t.nivel_minimo);
                const colorNivel = sinNivel
                  ? "text-slate-400"
                  : bajoUmbral
                    ? "text-red-500"
                    : "text-emerald-600";
                return (
                  <tr key={t.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-4 font-mono text-sm text-slate-500">{t.codigo}</td>
                    <td className="p-4 text-sm font-semibold text-slate-800">
                      {t.tanque_nombre}
                      {t.ubicacion && <p className="text-xs text-slate-400">{t.ubicacion}</p>}
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      {ETIQUETA_TIPO_COMBUSTIBLE[t.tipo_combustible]}
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      {ETIQUETA_TIPO_PUNTO[t.tipo_punto]}
                    </td>
                    <td className="p-4 text-sm">
                      <span className={`font-medium ${colorNivel}`}>
                        {Number(t.nivel_minimo).toLocaleString("es-PE")} {t.unidad}
                      </span>
                    </td>
                    <td className="p-4 text-sm">
                      {sinNivel ? (
                        <>
                          <span className="text-slate-400 italic">Sin lecturas</span>
                          <p className="text-xs text-slate-400">
                            Capacidad: {Number(t.capacidad_total).toLocaleString("es-PE")}{" "}
                            {t.unidad}
                          </p>
                        </>
                      ) : (
                        <>
                          <span className={`font-bold ${colorNivel}`}>
                            {Number(t.nivel_actual).toLocaleString("es-PE")}
                          </span>
                          <span className="text-slate-400">
                            {" "}
                            / {Number(t.capacidad_total).toLocaleString("es-PE")} {t.unidad} (
                            {t.porcentaje}%)
                          </span>
                          <p className="text-xs text-slate-400">
                            Última lectura: {formatearFecha(t.fecha_actualizacion!)}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="p-4 text-sm">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          t.activo
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {t.activo ? "Activo" : "Desactivado"}
                      </span>
                    </td>
                    <td className="p-4 text-right space-x-2">
                      <button
                        onClick={() => abrirModalHistorial(t)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Ver historial de lecturas"
                      >
                        📋
                      </button>
                      <button
                        onClick={() => abrirModalLectura(t)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Registrar lectura"
                      >
                        ⛽
                      </button>
                      <button
                        onClick={() => abrirModalEditar(t)}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Editar"
                      >
                        ✏️
                      </button>
                      {t.activo && (
                        <button
                          onClick={() => handleDesactivar(t)}
                          className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Desactivar"
                        >
                          🗑️
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* Modal: alta / edición de tanque */}
      {modalTanqueAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">{editandoId ? "Editar Tanque" : "Nuevo Tanque"}</h3>
              <button
                onClick={() => setModalTanqueAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleGuardarTanque} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-codigo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Código
                  </label>
                  <input
                    id="tanque-codigo"
                    type="text"
                    placeholder="Ej: TQ-01"
                    required
                    maxLength={50}
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.codigo}
                    onChange={(e) => setFormData({ ...formData, codigo: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-nombre"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Nombre
                  </label>
                  <input
                    id="tanque-nombre"
                    type="text"
                    required
                    maxLength={100}
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.tanque_nombre}
                    onChange={(e) => setFormData({ ...formData, tanque_nombre: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-tipo-combustible"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Combustible
                  </label>
                  <select
                    id="tanque-tipo-combustible"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.tipo_combustible}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        tipo_combustible: e.target.value as Tanque["tipo_combustible"],
                      })
                    }
                  >
                    {Object.entries(ETIQUETA_TIPO_COMBUSTIBLE).map(([valor, etiqueta]) => (
                      <option key={valor} value={valor}>
                        {etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-unidad"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Unidad
                  </label>
                  <select
                    id="tanque-unidad"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.unidad}
                    onChange={(e) =>
                      setFormData({ ...formData, unidad: e.target.value as Tanque["unidad"] })
                    }
                  >
                    <option value="gal">Galones</option>
                    <option value="L">Litros</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-tipo-punto"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Punto
                  </label>
                  <select
                    id="tanque-tipo-punto"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={formData.tipo_punto}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        tipo_punto: e.target.value as Tanque["tipo_punto"],
                      })
                    }
                  >
                    {Object.entries(ETIQUETA_TIPO_PUNTO).map(([valor, etiqueta]) => (
                      <option key={valor} value={valor}>
                        {etiqueta}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="tanque-ubicacion"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Ubicación (opcional)
                </label>
                <input
                  id="tanque-ubicacion"
                  type="text"
                  maxLength={200}
                  placeholder="Ej: Grifo Cantera"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={formData.ubicacion}
                  onChange={(e) => setFormData({ ...formData, ubicacion: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-capacidad"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Capacidad total
                  </label>
                  <input
                    id="tanque-capacidad"
                    type="number"
                    min={0.01}
                    step="0.01"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.capacidad_total}
                    onChange={(e) => setFormData({ ...formData, capacidad_total: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-nivel-minimo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Nivel mínimo (alerta)
                  </label>
                  <input
                    id="tanque-nivel-minimo"
                    type="number"
                    min={0}
                    step="0.01"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.nivel_minimo}
                    onChange={(e) => setFormData({ ...formData, nivel_minimo: e.target.value })}
                  />
                </div>
              </div>

              {/* nivel_actual solo se pide al CREAR -- editar un tanque
                  existente no es el camino para corregir su nivel, eso pasa
                  por "Registrar lectura" (ver el comentario en el schema). */}
              {editandoId === null && (
                <div className="space-y-1">
                  <label
                    htmlFor="tanque-nivel-actual"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Nivel inicial
                  </label>
                  <input
                    id="tanque-nivel-actual"
                    type="number"
                    min={0}
                    step="0.01"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                    value={formData.nivel_actual}
                    onChange={(e) => setFormData({ ...formData, nivel_actual: e.target.value })}
                  />
                </div>
              )}
              {editandoId !== null && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={formData.activo}
                    onChange={(e) => setFormData({ ...formData, activo: e.target.checked })}
                  />
                  Tanque activo
                </label>
              )}

              <button
                type="submit"
                disabled={guardando}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {guardando ? "Guardando..." : editandoId ? "Guardar Cambios" : "Crear Tanque"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: historial de lecturas (solo lectura) */}
      {tanqueHistorial && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-xl font-bold">Historial — {tanqueHistorial.tanque_nombre}</h3>
                <p className="text-sm text-slate-500">
                  Lecturas registradas, de la más reciente a la más antigua
                </p>
              </div>
              <button
                onClick={() => setTanqueHistorial(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {cargandoLecturas ? (
                <p className="text-center text-slate-500 py-8">Cargando historial...</p>
              ) : lecturas.length === 0 ? (
                <p className="text-center text-slate-500 py-8">
                  Este tanque todavía no tiene lecturas registradas.
                </p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Fecha de la lectura
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Nivel
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Variación
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Acciones
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lecturas.map((l) => {
                      const anulada = l.anulada_en !== null;
                      const variacion = variacionPorLectura.get(l.id) ?? null;
                      return (
                        <tr key={l.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="p-3 text-sm text-slate-600">
                            <span className={anulada ? "line-through text-slate-400" : ""}>
                              {formatearFecha(l.leido_en)}
                            </span>
                            {l.origen !== "manual" && (
                              <span className="ml-2 text-xs text-slate-400">({l.origen})</span>
                            )}
                            {/* Quién tomó la medición. Va SIEMPRE visible,
                                incluso en las anuladas: si una lectura
                                resultó estar mal, quién la cargó es parte
                                de lo que hay que poder ver. */}
                            <p className="text-xs text-slate-500 mt-0.5">
                              {l.registrada_por_nombre
                                ? `Registró: ${l.registrada_por_nombre}`
                                : "Registró: —"}
                            </p>
                            {anulada && (
                              <p className="text-xs text-amber-700 mt-0.5">
                                Anulada: {l.motivo_anulacion}
                                {l.anulada_por_nombre && ` — ${l.anulada_por_nombre}`}
                              </p>
                            )}
                          </td>
                          <td
                            className={`p-3 text-sm font-semibold text-right ${
                              anulada ? "line-through text-slate-400" : "text-slate-800"
                            }`}
                          >
                            {Number(l.nivel).toLocaleString("es-PE")} {tanqueHistorial.unidad}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {variacion === null ? (
                              <span className="text-slate-300">—</span>
                            ) : (
                              <span
                                className={
                                  variacion < 0
                                    ? "text-red-500 font-medium"
                                    : variacion > 0
                                      ? "text-emerald-600 font-medium"
                                      : "text-slate-400"
                                }
                              >
                                {variacion > 0 ? "+" : ""}
                                {variacion.toLocaleString("es-PE")} {tanqueHistorial.unidad}
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-sm text-right">
                            {!anulada && (
                              <button
                                onClick={() => {
                                  setLecturaAAnular(l);
                                  setMotivoAnulacion("");
                                }}
                                className="px-2 py-1 text-xs text-slate-400 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-all"
                                title="Anular esta lectura"
                              >
                                Anular
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: anular lectura (motivo obligatorio) -- se monta por encima
          del historial, que queda abierto detrás. */}
      {lecturaAAnular && tanqueHistorial && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Anular lectura</h3>
              <button
                onClick={() => setLecturaAAnular(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleAnularLectura} className="p-6 space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
                <p>
                  Vas a anular la lectura de{" "}
                  <span className="font-bold">
                    {Number(lecturaAAnular.nivel).toLocaleString("es-PE")} {tanqueHistorial.unidad}
                  </span>{" "}
                  del {formatearFecha(lecturaAAnular.leido_en)}.
                </p>
                <p className="mt-2 text-xs">
                  La lectura no se borra: queda en el historial marcada como anulada, con este
                  motivo y tu nombre. Si era la última, el nivel del tanque vuelve a la lectura
                  anterior.
                </p>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="motivo-anulacion"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo (obligatorio)
                </label>
                <textarea
                  id="motivo-anulacion"
                  required
                  rows={3}
                  maxLength={500}
                  placeholder="Ej: error de tipeo, se registró 500 en vez de 19.000"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={motivoAnulacion}
                  onChange={(e) => setMotivoAnulacion(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={anulando || motivoAnulacion.trim() === ""}
                className="w-full bg-amber-700 text-white font-bold py-4 rounded-2xl hover:bg-amber-800 transition-all mt-4 disabled:opacity-50"
              >
                {anulando ? "Anulando..." : "Anular lectura"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: registrar lectura - ícono de tanque*/}
      {tanqueLectura && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Lectura — {tanqueLectura.tanque_nombre}</h3>
              <button
                onClick={() => setTanqueLectura(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleRegistrarLectura} className="p-6 space-y-4">
              {/* Referencia a la vista mientras se escribe. Sin esto la
                  persona mide con la varilla y tipea a ciegas: no ve contra
                  qué valor viene, así que un dígito de más pasa
                  desapercibido justo en el momento en que era más fácil
                  notarlo. */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Último registro</span>
                  <span className="font-bold text-slate-900">
                    {tanqueLectura.nivel_actual === null
                      ? "sin lecturas"
                      : `${Number(tanqueLectura.nivel_actual).toLocaleString("es-PE")} ${tanqueLectura.unidad}`}
                  </span>
                </div>
                {tanqueLectura.fecha_actualizacion && (
                  <p className="text-xs text-slate-400 text-right">
                    {formatearFecha(tanqueLectura.fecha_actualizacion)}
                  </p>
                )}
                <div className="flex justify-between mt-2 pt-2 border-t border-slate-200">
                  <span className="text-slate-500">Capacidad</span>
                  <span className="text-slate-600">
                    {Number(tanqueLectura.capacidad_total).toLocaleString("es-PE")}{" "}
                    {tanqueLectura.unidad}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Umbral de alerta</span>
                  <span className="text-slate-600">
                    {Number(tanqueLectura.nivel_minimo).toLocaleString("es-PE")}{" "}
                    {tanqueLectura.unidad}
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="combustible-nivel"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Nivel medido ahora ({tanqueLectura.unidad})
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
                  onChange={(e) => {
                    setLeidoEn(e.target.value);
                    setHoraEditadaAMano(true);
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={enviandoLectura}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {enviandoLectura ? "Registrando..." : "Registrar lectura"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
