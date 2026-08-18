import { z } from "zod";

// ── Tanques / puntos de abastecimiento (Fase A, ver
// docs/architecture/control-de-combustible.md) ─────────────────────────────

const TIPOS_COMBUSTIBLE = ["diesel_b5", "gasolina_90", "glp"] as const;
const UNIDADES_COMBUSTIBLE = ["gal", "L"] as const;
const TIPOS_PUNTO_COMBUSTIBLE = ["fijo", "cisterna", "surtidor"] as const;

// `nivel_actual` NO está acá a propósito: se gestiona exclusivamente por
// POST /lecturas (ver combustible.repository.ts, registrarLectura) para que
// el historial de combustible_lecturas nunca quede desincronizado del valor
// vigente -- mismo motivo por el que existe 0045_combustible_lecturas.sql.
// `totalizador_actual` tampoco: nace en 0 en esta fase, lo mueve la Fase B
// (despachos). `costo_promedio` tampoco: lo calcula la Fase C.
export const crearTanqueCombustibleSchema = z.object({
  codigo: z.string().trim().min(1).max(50),
  tanque_nombre: z.string().trim().min(1).max(100),
  tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),
  unidad: z.enum(UNIDADES_COMBUSTIBLE),
  tipo_punto: z.enum(TIPOS_PUNTO_COMBUSTIBLE),
  ubicacion: z.string().trim().max(200).optional(),
  capacidad_total: z.number().positive(),
  nivel_actual: z.number().nonnegative().default(0),
  nivel_minimo: z.number().nonnegative().default(0),
  moneda: z.string().trim().length(3).default("PEN"),
});

export type CrearTanqueCombustibleInput = z.infer<typeof crearTanqueCombustibleSchema>;

// PUT reemplaza la fila entera (mismo criterio que actualizarRepuestoSchema):
// omitir un campo no significa "dejalo como está", así que ninguno tiene
// `.default()`. `nivel_actual` sigue sin estar acá -- editar el tanque no es
// el camino para corregir su nivel, eso participa de la cola offline
// (POST /lecturas) y de ese historial no se sale por acá.
export const actualizarTanqueCombustibleSchema = z.object({
  codigo: z.string().trim().min(1).max(50),
  tanque_nombre: z.string().trim().min(1).max(100),
  tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),
  unidad: z.enum(UNIDADES_COMBUSTIBLE),
  tipo_punto: z.enum(TIPOS_PUNTO_COMBUSTIBLE),
  ubicacion: z.string().trim().max(200).optional(),
  capacidad_total: z.number().positive(),
  nivel_minimo: z.number().nonnegative(),
  moneda: z.string().trim().length(3),
  activo: z.boolean(),
});

export type ActualizarTanqueCombustibleInput = z.infer<typeof actualizarTanqueCombustibleSchema>;

/** Mismo valor y mismo motivo que MAX_FILAS_CARGA_MASIVA en
 *  repuestos.schema.ts -- pero los tanques son configuración (unos pocos
 *  por tenant, ver el comentario de `cuota` en modules/registry.ts), así
 *  que en la práctica nunca se va a acercar a este techo; existe para
 *  acotar el trabajo de un request, no porque se espere un uso real cerca
 *  del límite. */
export const MAX_FILAS_CARGA_MASIVA_TANQUES = 5000;

export const cargaMasivaTanquesCombustibleSchema = z
  .array(crearTanqueCombustibleSchema)
  .min(1, "La importación no puede estar vacía")
  .max(
    MAX_FILAS_CARGA_MASIVA_TANQUES,
    `No se pueden importar más de ${MAX_FILAS_CARGA_MASIVA_TANQUES} filas de una vez`
  );

export type CargaMasivaTanquesCombustibleInput = z.infer<
  typeof cargaMasivaTanquesCombustibleSchema
>;

// ── Lecturas (ya existía) ───────────────────────────────────────────────

export const registrarLecturaCombustibleSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al apretar "Registrar
  // lectura", online u offline (ver client/src/offline/). Opcional a
  // propósito: sin él, la creación se comporta igual que siempre. Con él,
  // un reintento del mismo envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  combustible_id: z.number().int().positive(),
  nivel: z.number().nonnegative(),
  // Cuándo se TOMÓ la lectura, no cuándo llegó al servidor -- decide si
  // actualiza nivel_actual (ver combustible.repository.ts). Opcional:
  // sin dato, el service usa now() (siempre "la más reciente" en ese caso).
  leido_en: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RegistrarLecturaCombustibleInput = z.infer<typeof registrarLecturaCombustibleSchema>;

// Wrapper legacy de PUT /:id/nivel -- mismo shape de body que siempre tuvo
// (nivel_actual), ahora validado con Zod como el resto de los módulos.
export const actualizarNivelCombustibleSchema = z.object({
  nivel_actual: z.number().nonnegative(),
});

export type ActualizarNivelCombustibleInput = z.infer<typeof actualizarNivelCombustibleSchema>;
