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

/** Fase B (migrations/0062) -- solo los campos que el formulario de
 *  despacho necesita, no el shape completo de GET /equipos. */
interface Equipo {
  id: number;
  placa_codigo: string;
  tipo: string;
  tipo_medidor: "horometro" | "odometro" | null;
}

type OrigenDespacho = "tanque_propio" | "compra_externa";
type TipoDestinoDespacho = "equipo" | "planta" | "reserva_cubeta";

const ETIQUETA_TIPO_DESTINO: Record<TipoDestinoDespacho, string> = {
  equipo: "Unidad",
  planta: "Planta (sin placa)",
  reserva_cubeta: "Reserva en cubeta",
};

/** Catálogo de grifos externos (migrations/0063) -- reemplaza el texto
 *  libre `grifo_externo` de Fase B: cada grifo franquiciado cobra un
 *  precio distinto, así que hace falta engancharlo a algo más estable
 *  que un string tipeado a mano. */
interface Grifo {
  id: number;
  nombre: string;
  activo: boolean;
}

/** Historial de precios (migrations/0063) -- se apila, nunca se pisa. Un
 *  precio mal cargado se anula (anulada_en no-null), no se borra. */
interface Precio {
  id: number;
  tipo_combustible: Tanque["tipo_combustible"];
  combustible_id: number | null;
  grifo_id: number | null;
  precio_unitario: string;
  vigente_desde: string;
  tanque_nombre: string | null;
  grifo_nombre: string | null;
  registrado_por_nombre: string | null;
  anulada_en: string | null;
  motivo_anulacion: string | null;
  anulado_por_nombre: string | null;
}

/** Una fila del historial de despachos (GET /despachos). Trae los ids
 *  crudos (combustible_id/grifo_id/equipo_id) -- el nombre se resuelve
 *  del lado del cliente contra `tanques`/`grifos`/`equipos`, que el panel
 *  ya tiene cargados; no hace falta pedirle al backend que haga los JOIN
 *  para esta tabla de solo lectura. */
interface DespachoHistorial {
  id: number;
  origen: OrigenDespacho;
  combustible_id: number | null;
  grifo_id: number | null;
  equipo_id: number | null;
  tipo_combustible: Tanque["tipo_combustible"];
  serie_talonario: string;
  n_vale: number;
  cantidad: string;
  costo_unitario: string;
  costo_total: string;
  observaciones: string | null;
  despachado_en: string;
}

const ETIQUETA_ORIGEN_DESPACHO: Record<OrigenDespacho, string> = {
  tanque_propio: "Tanque propio",
  compra_externa: "Compra externa",
};

const DESPACHO_FORM_INICIAL = {
  origen: "tanque_propio" as OrigenDespacho,
  combustible_id: "",
  grifo_id: "",
  tipo_combustible: "diesel_b5" as Tanque["tipo_combustible"],
  tipo_destino: "equipo" as TipoDestinoDespacho,
  equipo_id: "",
  serie_talonario: "",
  n_vale: "",
  cantidad: "",
  lectura_contometro: "",
  lectura_horometro: "",
  lectura_odometro: "",
  horas_abastecidas: "",
  costo_unitario: "",
  observaciones: "",
};

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

  // --- Registrar despacho (Fase B, offline-capaz) ---
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [modalDespachoAbierto, setModalDespachoAbierto] = useState(false);
  const [despachoForm, setDespachoForm] = useState(DESPACHO_FORM_INICIAL);
  const [despachadoEn, setDespachadoEn] = useState(ahoraParaInputLocal());
  // Mismo motivo que horaEditadaAMano de la lectura: si nadie toca el
  // campo, se manda el momento real del submit (con segundos), no el
  // valor con el que se abrió el modal.
  const [horaDespachoEditadaAMano, setHoraDespachoEditadaAMano] = useState(false);
  const [enviandoDespacho, setEnviandoDespacho] = useState(false);
  const [clienteUuidDespacho, setClienteUuidDespacho] = useState("");
  // El costo se autocompleta al elegir tanque/grifo -- pero si el operador
  // YA lo tocó a mano, no lo pisamos con un nuevo autocompletado (ej. si
  // cambia el tipo de combustible después de corregir el precio).
  const [costoEditadoAMano, setCostoEditadoAMano] = useState(false);

  // --- Grifos externos (migrations/0063) ---
  const [grifos, setGrifos] = useState<Grifo[]>([]);
  const [modalGrifosAbierto, setModalGrifosAbierto] = useState(false);
  const [nombreGrifoNuevo, setNombreGrifoNuevo] = useState("");
  const [guardandoGrifo, setGuardandoGrifo] = useState(false);

  // --- Precios de combustible (migrations/0063) ---
  const [precios, setPrecios] = useState<Precio[]>([]);
  const [modalPreciosAbierto, setModalPreciosAbierto] = useState(false);
  const [precioForm, setPrecioForm] = useState({
    tipo_combustible: "diesel_b5" as Tanque["tipo_combustible"],
    aplicaA: "tanque" as "tanque" | "grifo",
    combustible_id: "",
    grifo_id: "",
    precio_unitario: "",
  });
  const [vigenteDesde, setVigenteDesde] = useState(ahoraParaInputLocal());
  const [guardandoPrecio, setGuardandoPrecio] = useState(false);
  const [precioAAnular, setPrecioAAnular] = useState<Precio | null>(null);
  const [motivoAnulacionPrecio, setMotivoAnulacionPrecio] = useState("");
  const [anulandoPrecio, setAnulandoPrecio] = useState(false);

  // --- Historial de despachos (solo lectura, GET /despachos) ---
  const [modalHistorialDespachosAbierto, setModalHistorialDespachosAbierto] = useState(false);
  const [historialDespachos, setHistorialDespachos] = useState<DespachoHistorial[]>([]);
  const [cargandoHistorialDespachos, setCargandoHistorialDespachos] = useState(false);

  const cargarTanques = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible");
    const data = await res.json();
    setTanques(Array.isArray(data) ? data : []);
  }, []);

  // pageSize=200 (el máximo, ver pagination.ts) alcanza para el <select> de
  // este formulario -- un buscador de equipos aparte es más de lo que Fase
  // B necesita ("solo lo indispensable para que el grifero pueda cargar
  // vales").
  const cargarEquipos = useCallback(async () => {
    const res = await apiFetch("/api/erp/equipos?pageSize=200");
    const body = await res.json().catch(() => null);
    setEquipos(Array.isArray(body?.data) ? body.data : []);
  }, []);

  const cargarGrifos = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/grifos");
    const data = await res.json().catch(() => null);
    setGrifos(Array.isArray(data) ? data : []);
  }, []);

  const cargarPrecios = useCallback(async () => {
    const res = await apiFetch("/api/erp/combustible/precios");
    const data = await res.json().catch(() => null);
    setPrecios(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    // Patrón estándar de carga al montar -- ver IpercView.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([cargarTanques(), cargarEquipos(), cargarGrifos()]).finally(() =>
      setLoading(false)
    );
  }, [cargarTanques, cargarEquipos, cargarGrifos]);

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

  // --- Registrar despacho (Fase B) ---

  const abrirModalDespacho = () => {
    setDespachoForm(DESPACHO_FORM_INICIAL);
    setDespachadoEn(ahoraParaInputLocal());
    setHoraDespachoEditadaAMano(false);
    setCostoEditadoAMano(false);
    setMensajeExito(null);
    setClienteUuidDespacho(crypto.randomUUID());
    setModalDespachoAbierto(true);
  };

  const equipoSeleccionado = equipos.find((eq) => eq.id === Number(despachoForm.equipo_id));

  const costoTotalCalculado =
    despachoForm.cantidad !== "" && despachoForm.costo_unitario !== ""
      ? Number(despachoForm.cantidad) * Number(despachoForm.costo_unitario)
      : null;

  // Autocompletado del C.U (migrations/0063): apenas hay tanque/grifo +
  // tipo de combustible elegidos, pide el precio vigente A LA FECHA DEL
  // DESPACHO (no "ahora") -- importante para un vale offline que se carga
  // en cancha y sincroniza horas después. Nunca pisa un valor que el
  // operador ya haya tocado a mano.
  useEffect(() => {
    if (!modalDespachoAbierto || costoEditadoAMano) return;
    const destinoId =
      despachoForm.origen === "tanque_propio" ? despachoForm.combustible_id : despachoForm.grifo_id;
    if (!destinoId) return;

    const fecha = horaDespachoEditadaAMano
      ? new Date(despachadoEn).toISOString()
      : new Date().toISOString();
    const params = new URLSearchParams({
      tipo_combustible: despachoForm.tipo_combustible,
      fecha,
      ...(despachoForm.origen === "tanque_propio"
        ? { combustible_id: destinoId }
        : { grifo_id: destinoId }),
    });

    let cancelado = false;
    apiFetch(`/api/erp/combustible/precios/vigente?${params.toString()}`)
      .then((res) => res.json())
      .then((body) => {
        if (cancelado || !body?.precio) return;

        setDespachoForm((prev) => ({
          ...prev,
          costo_unitario: String(body.precio.precio_unitario),
        }));
      })
      .catch(() => {
        // Sin precio cargado (o sin red): el campo queda como estaba, el
        // operador lo tipea a mano -- no es un error que merezca alerta.
      });
    return () => {
      cancelado = true;
    };
  }, [
    modalDespachoAbierto,
    costoEditadoAMano,
    despachoForm.origen,
    despachoForm.combustible_id,
    despachoForm.grifo_id,
    despachoForm.tipo_combustible,
    despachadoEn,
    horaDespachoEditadaAMano,
  ]);

  const handleRegistrarDespacho = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enviandoDespacho) return;

    const despachadoEnIso = horaDespachoEditadaAMano
      ? new Date(despachadoEn).toISOString()
      : new Date().toISOString();

    // Solo se manda lo que aplica al origen elegido -- el resto queda fuera
    // del body en vez de ir como "" o 0, que el schema del servidor
    // rechazaría igual (ver crearDespachoCombustibleSchema.superRefine).
    const body =
      despachoForm.origen === "tanque_propio"
        ? {
            cliente_uuid: clienteUuidDespacho,
            origen: "tanque_propio",
            combustible_id: Number(despachoForm.combustible_id),
            tipo_combustible: despachoForm.tipo_combustible,
            tipo_destino: despachoForm.tipo_destino,
            equipo_id:
              despachoForm.tipo_destino === "equipo" ? Number(despachoForm.equipo_id) : undefined,
            serie_talonario: despachoForm.serie_talonario,
            n_vale: Number(despachoForm.n_vale),
            cantidad: Number(despachoForm.cantidad),
            lectura_contometro: Number(despachoForm.lectura_contometro),
            costo_unitario: Number(despachoForm.costo_unitario),
            observaciones: despachoForm.observaciones || undefined,
            despachado_en: despachadoEnIso,
          }
        : {
            cliente_uuid: clienteUuidDespacho,
            origen: "compra_externa",
            grifo_id: Number(despachoForm.grifo_id),
            tipo_combustible: despachoForm.tipo_combustible,
            tipo_destino: "equipo",
            equipo_id: Number(despachoForm.equipo_id),
            serie_talonario: despachoForm.serie_talonario,
            n_vale: Number(despachoForm.n_vale),
            cantidad: Number(despachoForm.cantidad),
            lectura_horometro:
              equipoSeleccionado?.tipo_medidor === "horometro"
                ? Number(despachoForm.lectura_horometro)
                : undefined,
            lectura_odometro:
              equipoSeleccionado?.tipo_medidor === "odometro"
                ? Number(despachoForm.lectura_odometro)
                : undefined,
            horas_abastecidas: Number(despachoForm.horas_abastecidas),
            costo_unitario: Number(despachoForm.costo_unitario),
            observaciones: despachoForm.observaciones || undefined,
            despachado_en: despachadoEnIso,
          };

    setEnviandoDespacho(true);
    try {
      const res = await apiFetch("/api/erp/combustible/despachos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        alert(errBody.error || errBody.errors?.[0]?.message || "Error al registrar el despacho.");
        return;
      }

      setModalDespachoAbierto(false);

      // 202 = sin red, quedó en la cola del dispositivo -- mismo criterio
      // que registrar una lectura.
      if (res.status === 202) {
        setMensajeExito(
          `Sin conexión: el vale ${despachoForm.n_vale} de la serie ${despachoForm.serie_talonario} ` +
            `quedó guardado en este equipo y se enviará solo cuando vuelva la señal.`
        );
        return;
      }

      setMensajeExito(
        `Despacho registrado: vale ${despachoForm.n_vale} de la serie ${despachoForm.serie_talonario}.`
      );
    } finally {
      setEnviandoDespacho(false);
    }
  };

  // --- Grifos externos (migrations/0063) ---

  const abrirModalGrifos = () => {
    setNombreGrifoNuevo("");
    setModalGrifosAbierto(true);
    cargarGrifos();
  };

  const handleCrearGrifo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardandoGrifo || !nombreGrifoNuevo.trim()) return;
    setGuardandoGrifo(true);
    try {
      const res = await apiFetch("/api/erp/combustible/grifos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombreGrifoNuevo.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo crear el grifo.");
        return;
      }
      setNombreGrifoNuevo("");
      await cargarGrifos();
    } finally {
      setGuardandoGrifo(false);
    }
  };

  const handleCambiarActivoGrifo = async (grifo: Grifo) => {
    const res = await apiFetch(`/api/erp/combustible/grifos/${grifo.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre: grifo.nombre, activo: !grifo.activo }),
    });
    if (!res.ok) {
      alert("No se pudo actualizar el grifo.");
      return;
    }
    await cargarGrifos();
  };

  // --- Precios de combustible (migrations/0063) ---

  const abrirModalPrecios = () => {
    setPrecioForm({
      tipo_combustible: "diesel_b5",
      aplicaA: "tanque",
      combustible_id: "",
      grifo_id: "",
      precio_unitario: "",
    });
    setVigenteDesde(ahoraParaInputLocal());
    setModalPreciosAbierto(true);
    cargarPrecios();
  };

  const handleCrearPrecio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guardandoPrecio) return;
    setGuardandoPrecio(true);
    try {
      const res = await apiFetch("/api/erp/combustible/precios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo_combustible: precioForm.tipo_combustible,
          combustible_id:
            precioForm.aplicaA === "tanque" ? Number(precioForm.combustible_id) : undefined,
          grifo_id: precioForm.aplicaA === "grifo" ? Number(precioForm.grifo_id) : undefined,
          precio_unitario: Number(precioForm.precio_unitario),
          vigente_desde: new Date(vigenteDesde).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || body.errors?.[0]?.message || "No se pudo cargar el precio.");
        return;
      }
      setPrecioForm({ ...precioForm, precio_unitario: "" });
      await cargarPrecios();
    } finally {
      setGuardandoPrecio(false);
    }
  };

  const handleAnularPrecio = async () => {
    if (anulandoPrecio || !precioAAnular || !motivoAnulacionPrecio.trim()) return;
    setAnulandoPrecio(true);
    try {
      const res = await apiFetch(`/api/erp/combustible/precios/${precioAAnular.id}/anular`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: motivoAnulacionPrecio }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "No se pudo anular el precio.");
        return;
      }
      setPrecioAAnular(null);
      setMotivoAnulacionPrecio("");
      await cargarPrecios();
    } finally {
      setAnulandoPrecio(false);
    }
  };

  // --- Historial de despachos (solo lectura) ---

  const abrirModalHistorialDespachos = async () => {
    setModalHistorialDespachosAbierto(true);
    setCargandoHistorialDespachos(true);
    try {
      // pageSize=100, mismo techo que el historial de lecturas -- ver
      // pending_calidad_e2e_a11y (filtro por fecha queda para después).
      const res = await apiFetch("/api/erp/combustible/despachos?pageSize=100");
      const body = await res.json().catch(() => null);
      setHistorialDespachos(Array.isArray(body?.data) ? body.data : []);
    } finally {
      setCargandoHistorialDespachos(false);
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
            onClick={abrirModalHistorialDespachos}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            📋 Historial de despachos
          </button>
          <button
            onClick={abrirModalGrifos}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            Grifos
          </button>
          <button
            onClick={abrirModalPrecios}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium rounded-xl transition-all"
          >
            Precios
          </button>
          <button
            onClick={abrirModalDespacho}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-xl transition-all"
          >
            ⛽ Registrar despacho
          </button>
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
      {/* Modal: registrar despacho (Fase B) */}
      {modalDespachoAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Registrar despacho</h3>
              <button
                onClick={() => setModalDespachoAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleRegistrarDespacho} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-origen"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Origen
                  </label>
                  <select
                    id="despacho-origen"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={despachoForm.origen}
                    onChange={(e) =>
                      setDespachoForm({
                        ...DESPACHO_FORM_INICIAL,
                        origen: e.target.value as OrigenDespacho,
                      })
                    }
                  >
                    <option value="tanque_propio">Tanque propio</option>
                    <option value="compra_externa">Compra externa (ruta)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-tipo-combustible"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Combustible
                  </label>
                  <select
                    id="despacho-tipo-combustible"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={despachoForm.tipo_combustible}
                    onChange={(e) =>
                      setDespachoForm({
                        ...despachoForm,
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
              </div>

              {despachoForm.origen === "tanque_propio" ? (
                <>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-tanque"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Tanque
                    </label>
                    <select
                      id="despacho-tanque"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.combustible_id}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, combustible_id: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Elegir tanque
                      </option>
                      {tanques
                        .filter((t) => t.activo)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.tanque_nombre}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-cantidad"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Cantidad despachada
                      </label>
                      <input
                        id="despacho-cantidad"
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                        value={despachoForm.cantidad}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, cantidad: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-contometro"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Lectura del contómetro
                      </label>
                      <input
                        id="despacho-contometro"
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                        value={despachoForm.lectura_contometro}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, lectura_contometro: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-400">
                    El contómetro resetea a 0 en cada despacho: tiene que coincidir con la cantidad,
                    o el servidor lo rechaza.
                  </p>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-tipo-destino"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Destino
                    </label>
                    <select
                      id="despacho-tipo-destino"
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.tipo_destino}
                      onChange={(e) =>
                        setDespachoForm({
                          ...despachoForm,
                          tipo_destino: e.target.value as TipoDestinoDespacho,
                          equipo_id: "",
                        })
                      }
                    >
                      {Object.entries(ETIQUETA_TIPO_DESTINO).map(([valor, etiqueta]) => (
                        <option key={valor} value={valor}>
                          {etiqueta}
                        </option>
                      ))}
                    </select>
                  </div>
                  {despachoForm.tipo_destino === "equipo" && (
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-equipo"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Unidad
                      </label>
                      <select
                        id="despacho-equipo"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                        value={despachoForm.equipo_id}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, equipo_id: e.target.value })
                        }
                      >
                        <option value="" disabled>
                          Elegir unidad
                        </option>
                        {equipos.map((eq) => (
                          <option key={eq.id} value={eq.id}>
                            {eq.placa_codigo} — {eq.tipo}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-grifo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Grifo
                    </label>
                    <select
                      id="despacho-grifo"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.grifo_id}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, grifo_id: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Elegir grifo
                      </option>
                      {grifos
                        .filter((g) => g.activo)
                        .map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.nombre}
                          </option>
                        ))}
                    </select>
                    {grifos.length === 0 && (
                      <p className="text-xs text-red-600">
                        No hay grifos cargados todavía -- agregalos desde "Grifos" en la barra
                        superior.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-equipo-externo"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Unidad
                    </label>
                    <select
                      id="despacho-equipo-externo"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                      value={despachoForm.equipo_id}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, equipo_id: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Elegir unidad
                      </option>
                      {equipos.map((eq) => (
                        <option key={eq.id} value={eq.id}>
                          {eq.placa_codigo} — {eq.tipo}
                        </option>
                      ))}
                    </select>
                  </div>
                  {despachoForm.equipo_id !== "" && !equipoSeleccionado?.tipo_medidor && (
                    <p className="text-xs text-red-600">
                      Este equipo no tiene tipo de medidor configurado (horómetro/odómetro).
                      Configuralo en Equipos antes de continuar.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label
                        htmlFor="despacho-cantidad-externa"
                        className="text-xs font-bold text-slate-500 uppercase"
                      >
                        Cantidad despachada
                      </label>
                      <input
                        id="despacho-cantidad-externa"
                        type="number"
                        min={0}
                        step="0.01"
                        required
                        className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                        value={despachoForm.cantidad}
                        onChange={(e) =>
                          setDespachoForm({ ...despachoForm, cantidad: e.target.value })
                        }
                      />
                    </div>
                    {equipoSeleccionado?.tipo_medidor === "odometro" ? (
                      <div className="space-y-1">
                        <label
                          htmlFor="despacho-odometro"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Lectura odómetro
                        </label>
                        <input
                          id="despacho-odometro"
                          type="number"
                          min={0}
                          step="0.01"
                          required
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                          value={despachoForm.lectura_odometro}
                          onChange={(e) =>
                            setDespachoForm({ ...despachoForm, lectura_odometro: e.target.value })
                          }
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <label
                          htmlFor="despacho-horometro"
                          className="text-xs font-bold text-slate-500 uppercase"
                        >
                          Lectura horómetro
                        </label>
                        <input
                          id="despacho-horometro"
                          type="number"
                          min={0}
                          step="0.01"
                          required
                          disabled={!equipoSeleccionado?.tipo_medidor}
                          className="w-full border border-slate-200 rounded-xl p-3 outline-none disabled:bg-slate-50"
                          value={despachoForm.lectura_horometro}
                          onChange={(e) =>
                            setDespachoForm({ ...despachoForm, lectura_horometro: e.target.value })
                          }
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="despacho-horas-abastecidas"
                      className="text-xs font-bold text-slate-500 uppercase"
                    >
                      Horas abastecidas (desde la carga anterior)
                    </label>
                    <input
                      id="despacho-horas-abastecidas"
                      type="number"
                      min={0}
                      step="0.01"
                      required
                      className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                      value={despachoForm.horas_abastecidas}
                      onChange={(e) =>
                        setDespachoForm({ ...despachoForm, horas_abastecidas: e.target.value })
                      }
                    />
                  </div>
                </>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-costo-unitario"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    C.U (costo por galón)
                  </label>
                  <input
                    id="despacho-costo-unitario"
                    type="number"
                    min={0}
                    step="0.0001"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={despachoForm.costo_unitario}
                    onChange={(e) => {
                      setCostoEditadoAMano(true);
                      setDespachoForm({ ...despachoForm, costo_unitario: e.target.value });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-xs font-bold text-slate-500 uppercase">C.TOTAL</span>
                  <div className="w-full border border-slate-200 bg-slate-50 rounded-xl p-3 text-slate-600">
                    {costoTotalCalculado === null
                      ? "—"
                      : costoTotalCalculado.toLocaleString("es-PE", {
                          style: "currency",
                          currency: "PEN",
                        })}
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                El costo se autocompleta con el precio vigente a la fecha del despacho -- podés
                corregirlo si ese día pagaste distinto. C.TOTAL sale solo, no se guarda aparte.
              </p>

              <div className="space-y-1">
                <label
                  htmlFor="despacho-observaciones"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Observaciones (opcional)
                </label>
                <textarea
                  id="despacho-observaciones"
                  rows={2}
                  maxLength={500}
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={despachoForm.observaciones}
                  onChange={(e) =>
                    setDespachoForm({ ...despachoForm, observaciones: e.target.value })
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-serie"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Serie del talonario
                  </label>
                  <input
                    id="despacho-serie"
                    type="text"
                    required
                    maxLength={20}
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={despachoForm.serie_talonario}
                    onChange={(e) =>
                      setDespachoForm({ ...despachoForm, serie_talonario: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="despacho-n-vale"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    N° de vale
                  </label>
                  <input
                    id="despacho-n-vale"
                    type="number"
                    min={1}
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={despachoForm.n_vale}
                    onChange={(e) => setDespachoForm({ ...despachoForm, n_vale: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="despacho-fecha"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Fecha y hora del despacho
                </label>
                <input
                  id="despacho-fecha"
                  type="datetime-local"
                  required
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                  value={despachadoEn}
                  onChange={(e) => {
                    setDespachadoEn(e.target.value);
                    setHoraDespachoEditadaAMano(true);
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={enviandoDespacho}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all mt-4 disabled:opacity-50"
              >
                {enviandoDespacho ? "Registrando..." : "Registrar despacho"}
              </button>
            </form>
          </div>
        </div>
      )}
      {/* Modal: historial de despachos (solo lectura) */}
      {modalHistorialDespachosAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="p-6 border-b flex justify-between items-center shrink-0">
              <div>
                <h3 className="text-xl font-bold">Historial de despachos</h3>
                <p className="text-sm text-slate-500">
                  Últimos 100 vales registrados, del más reciente al más antiguo
                </p>
              </div>
              <button
                onClick={() => setModalHistorialDespachosAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="p-6 overflow-y-auto overflow-x-auto">
              {cargandoHistorialDespachos ? (
                <p className="text-center text-slate-500 py-8">Cargando historial...</p>
              ) : historialDespachos.length === 0 ? (
                <p className="text-center text-slate-500 py-8">
                  Todavía no hay despachos registrados.
                </p>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Vale
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Fecha
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Origen
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Tanque / Grifo
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        Unidad
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        Cantidad
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        C.U
                      </th>
                      <th className="p-3 text-xs font-bold text-slate-400 uppercase tracking-widest text-right">
                        C.TOTAL
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {historialDespachos.map((d) => {
                      const tanque = tanques.find((t) => t.id === d.combustible_id);
                      const grifo = grifos.find((g) => g.id === d.grifo_id);
                      const equipo = equipos.find((eq) => eq.id === d.equipo_id);
                      return (
                        <tr key={d.id} className="hover:bg-slate-50/50 transition-colors align-top">
                          <td className="p-3 text-sm text-slate-800 font-mono">
                            {d.serie_talonario}-{d.n_vale}
                          </td>
                          <td className="p-3 text-sm text-slate-600 whitespace-nowrap">
                            {formatearFecha(d.despachado_en)}
                          </td>
                          <td className="p-3 text-sm text-slate-600">
                            {ETIQUETA_ORIGEN_DESPACHO[d.origen]}
                          </td>
                          <td className="p-3 text-sm text-slate-600">
                            {tanque?.tanque_nombre ?? grifo?.nombre ?? "—"}
                          </td>
                          <td className="p-3 text-sm text-slate-600">
                            {equipo ? `${equipo.placa_codigo} — ${equipo.tipo}` : "—"}
                            {d.observaciones && (
                              <p className="text-xs text-slate-400 mt-0.5">{d.observaciones}</p>
                            )}
                          </td>
                          <td className="p-3 text-sm text-right text-slate-800 font-semibold whitespace-nowrap">
                            {Number(d.cantidad).toLocaleString("es-PE")}{" "}
                            {ETIQUETA_TIPO_COMBUSTIBLE[d.tipo_combustible]}
                          </td>
                          <td className="p-3 text-sm text-right text-slate-600 whitespace-nowrap">
                            S/ {Number(d.costo_unitario).toLocaleString("es-PE")}
                          </td>
                          <td className="p-3 text-sm text-right text-slate-800 font-semibold whitespace-nowrap">
                            S/ {Number(d.costo_total).toLocaleString("es-PE")}
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
      {/* Modal: Grifos externos (migrations/0063) */}
      {modalGrifosAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Grifos</h3>
              <button
                onClick={() => setModalGrifosAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearGrifo} className="p-6 space-y-3 border-b">
              <label
                htmlFor="grifo-nombre-nuevo"
                className="text-xs font-bold text-slate-500 uppercase"
              >
                Nuevo grifo
              </label>
              <div className="flex gap-2">
                <input
                  id="grifo-nombre-nuevo"
                  type="text"
                  placeholder="Ej. PRIMAX Bambamarca"
                  maxLength={150}
                  className="flex-1 border border-slate-200 rounded-xl p-3 outline-none"
                  value={nombreGrifoNuevo}
                  onChange={(e) => setNombreGrifoNuevo(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={guardandoGrifo || !nombreGrifoNuevo.trim()}
                  className="px-5 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all disabled:opacity-50"
                >
                  +
                </button>
              </div>
            </form>
            <div className="p-6 space-y-2">
              {grifos.length === 0 ? (
                <p className="text-sm text-slate-400 text-center">
                  Todavía no hay grifos cargados.
                </p>
              ) : (
                grifos.map((g) => (
                  <div
                    key={g.id}
                    className="flex items-center justify-between p-3 rounded-xl border border-slate-100"
                  >
                    <span className={g.activo ? "text-slate-800" : "text-slate-400 line-through"}>
                      {g.nombre}
                    </span>
                    <button
                      onClick={() => handleCambiarActivoGrifo(g)}
                      className={`text-xs font-bold px-3 py-1 rounded-full ${
                        g.activo
                          ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                      }`}
                    >
                      {g.activo ? "Activo" : "Desactivado"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: Precios de combustible (migrations/0063) */}
      {modalPreciosAbierto && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Precio de combustible</h3>
              <button
                onClick={() => setModalPreciosAbierto(false)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleCrearPrecio} className="p-6 space-y-4 border-b">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="precio-tipo-combustible"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Combustible
                  </label>
                  <select
                    id="precio-tipo-combustible"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.tipo_combustible}
                    onChange={(e) =>
                      setPrecioForm({
                        ...precioForm,
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
                    htmlFor="precio-aplica-a"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Aplica a
                  </label>
                  <select
                    id="precio-aplica-a"
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.aplicaA}
                    onChange={(e) =>
                      setPrecioForm({
                        ...precioForm,
                        aplicaA: e.target.value as "tanque" | "grifo",
                        combustible_id: "",
                        grifo_id: "",
                      })
                    }
                  >
                    <option value="tanque">Tanque propio</option>
                    <option value="grifo">Grifo externo</option>
                  </select>
                </div>
              </div>

              {precioForm.aplicaA === "tanque" ? (
                <div className="space-y-1">
                  <label
                    htmlFor="precio-tanque"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Tanque
                  </label>
                  <select
                    id="precio-tanque"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.combustible_id}
                    onChange={(e) =>
                      setPrecioForm({ ...precioForm, combustible_id: e.target.value })
                    }
                  >
                    <option value="" disabled>
                      Elegir tanque
                    </option>
                    {tanques.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.tanque_nombre}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-1">
                  <label
                    htmlFor="precio-grifo"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Grifo
                  </label>
                  <select
                    id="precio-grifo"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none bg-white focus:ring-2 focus:ring-slate-900"
                    value={precioForm.grifo_id}
                    onChange={(e) => setPrecioForm({ ...precioForm, grifo_id: e.target.value })}
                  >
                    <option value="" disabled>
                      Elegir grifo
                    </option>
                    {grifos.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label
                    htmlFor="precio-valor"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Precio por galón
                  </label>
                  <input
                    id="precio-valor"
                    type="number"
                    min={0}
                    step="0.0001"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={precioForm.precio_unitario}
                    onChange={(e) =>
                      setPrecioForm({ ...precioForm, precio_unitario: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="precio-vigente-desde"
                    className="text-xs font-bold text-slate-500 uppercase"
                  >
                    Vigente desde
                  </label>
                  <input
                    id="precio-vigente-desde"
                    type="datetime-local"
                    required
                    className="w-full border border-slate-200 rounded-xl p-3 outline-none"
                    value={vigenteDesde}
                    onChange={(e) => setVigenteDesde(e.target.value)}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={guardandoPrecio}
                className="w-full bg-slate-900 text-white font-bold py-3 rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-50"
              >
                {guardandoPrecio ? "Guardando..." : "Cargar precio"}
              </button>
            </form>

            <div className="p-6 space-y-2">
              <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">Historial</h4>
              {precios.length === 0 ? (
                <p className="text-sm text-slate-400 text-center">
                  Todavía no hay precios cargados.
                </p>
              ) : (
                precios.map((p) => (
                  <div
                    key={p.id}
                    className={`p-3 rounded-xl border text-sm ${
                      p.anulada_en ? "border-red-100 bg-red-50 text-slate-400" : "border-slate-100"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={p.anulada_en ? "line-through" : "font-medium text-slate-800"}
                      >
                        {ETIQUETA_TIPO_COMBUSTIBLE[p.tipo_combustible]} —{" "}
                        {p.tanque_nombre ?? p.grifo_nombre} — S/{" "}
                        {Number(p.precio_unitario).toLocaleString("es-PE")}
                      </span>
                      {!p.anulada_en && (
                        <button
                          onClick={() => setPrecioAAnular(p)}
                          className="text-xs font-bold text-red-600 hover:text-red-800"
                        >
                          Anular
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Vigente desde {formatearFecha(p.vigente_desde)}
                      {p.registrado_por_nombre ? ` · cargado por ${p.registrado_por_nombre}` : ""}
                    </p>
                    {p.anulada_en && (
                      <p className="text-xs text-red-500 mt-1">
                        Anulado{p.anulado_por_nombre ? ` por ${p.anulado_por_nombre}` : ""}: "
                        {p.motivo_anulacion}"
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Modal: anular precio (motivo obligatorio) -- se monta por encima
          del historial, que queda abierto detrás. */}
      {precioAAnular && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
          <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h3 className="text-xl font-bold">Anular precio</h3>
              <button
                onClick={() => setPrecioAAnular(null)}
                className="text-slate-400 hover:text-slate-900 text-2xl"
              >
                ×
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
                <p>
                  Vas a anular el precio de{" "}
                  <span className="font-bold">
                    S/ {Number(precioAAnular.precio_unitario).toLocaleString("es-PE")}
                  </span>
                  . No se borra: queda en el historial marcado como anulado, y el precio "vigente"
                  cae al anterior válido.
                </p>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="motivo-anulacion-precio"
                  className="text-xs font-bold text-slate-500 uppercase"
                >
                  Motivo (obligatorio)
                </label>
                <textarea
                  id="motivo-anulacion-precio"
                  required
                  rows={3}
                  maxLength={500}
                  placeholder="Ej: se tipeó 999 en vez de 17.9"
                  className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-slate-900"
                  value={motivoAnulacionPrecio}
                  onChange={(e) => setMotivoAnulacionPrecio(e.target.value)}
                />
              </div>
              <button
                onClick={handleAnularPrecio}
                disabled={anulandoPrecio || motivoAnulacionPrecio.trim() === ""}
                className="w-full bg-amber-700 text-white font-bold py-4 rounded-2xl hover:bg-amber-800 transition-all disabled:opacity-50"
              >
                {anulandoPrecio ? "Anulando..." : "Anular precio"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
