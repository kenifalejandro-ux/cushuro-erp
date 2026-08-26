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

/** Anular una lectura mal cargada (ej. se tipeó 500 en vez de 19.000). La
 *  fila NUNCA se borra ni se edita -- ver migrations/0058 y el punto 3 de
 *  docs/architecture/control-de-combustible.md.
 *
 *  `motivo` es OBLIGATORIO, a diferencia del `motivo` opcional del panel de
 *  plataforma: es lo único que distingue "me equivoqué al tipear" de
 *  "estoy tapando un número que no me conviene". Sin él la válvula de
 *  escape no sirve como respaldo de nada. */
export const anularLecturaCombustibleSchema = z.object({
  motivo: z.string().trim().min(1, "El motivo de la anulación es obligatorio").max(500),
});

export type AnularLecturaCombustibleInput = z.infer<typeof anularLecturaCombustibleSchema>;

// Wrapper legacy de PUT /:id/nivel -- mismo shape de body que siempre tuvo
// (nivel_actual), ahora validado con Zod como el resto de los módulos.
export const actualizarNivelCombustibleSchema = z.object({
  nivel_actual: z.number().nonnegative(),
});

export type ActualizarNivelCombustibleInput = z.infer<typeof actualizarNivelCombustibleSchema>;

// ── Despachos (Fase B, ver docs/architecture/control-de-combustible.md
// puntos 1, 2 y 5, y migrations/0062) ───────────────────────────────────

const ORIGENES_DESPACHO = ["tanque_propio", "compra_externa"] as const;
const TIPOS_DESTINO_DESPACHO = ["equipo", "planta", "reserva_cubeta"] as const;

/** Reglas cruzadas que Zod no expresa "limpio" solo con tipos -- por eso
 *  van en `.superRefine()` en vez de intentar dos schemas con `.and()`/
 *  discriminated union por dos campos a la vez (origen Y tipo_destino son
 *  independientes entre sí). Espejo de los CHECK de la migración 0062:
 *  esta es la validación que da un 400 legible ANTES de tocar la base: el
 *  CHECK sigue estando, como red de seguridad, para cualquier insert que
 *  no pase por acá. */
export const crearDespachoCombustibleSchema = z
  .object({
    // Mismo mecanismo que registrarLecturaCombustibleSchema -- lo genera
    // el dispositivo, online u offline. Opcional: sin él, siempre crea.
    cliente_uuid: z.string().uuid().optional(),

    origen: z.enum(ORIGENES_DESPACHO),
    // Solo tanque_propio.
    combustible_id: z.number().int().positive().optional(),
    // Solo compra_externa. Texto libre -- ver el comentario de la columna
    // en 0062.
    grifo_externo: z.string().trim().min(1).max(150).optional(),

    // Mismo enum que combustible.tipo_combustible (Fase A) -- se reusa a
    // propósito, ver hallazgo 2 de la memoria de columnas reales.
    tipo_combustible: z.enum(TIPOS_COMBUSTIBLE),

    tipo_destino: z.enum(TIPOS_DESTINO_DESPACHO),
    // Solo cuando tipo_destino = 'equipo'.
    equipo_id: z.number().int().positive().optional(),

    // El talonario -- reinicia por serie/mes, ver hallazgo 6.
    serie_talonario: z.string().trim().min(1, "La serie del talonario es obligatoria").max(20),
    n_vale: z.number().int().positive(),

    cantidad: z.number().positive(),

    // Solo tanque_propio -- chequeo intra-vale del punto 5.
    lectura_contometro: z.number().nonnegative().optional(),

    // Solo compra_externa -- exactamente uno de los dos, según
    // equipos.tipo_medidor (hallazgo 9). horas_abastecidas siempre junto.
    lectura_horometro: z.number().nonnegative().optional(),
    lectura_odometro: z.number().nonnegative().optional(),
    horas_abastecidas: z.number().nonnegative().optional(),

    // Cuándo se hizo el despacho en cancha -- opcional, mismo criterio que
    // `leido_en` de una lectura: sin dato, el service usa now().
    despachado_en: z.string().datetime().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.tipo_destino === "equipo" && data.equipo_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equipo_id"],
        message: "equipo_id es obligatorio cuando tipo_destino es 'equipo'",
      });
    }
    if (data.tipo_destino !== "equipo" && data.equipo_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["equipo_id"],
        message: "equipo_id solo aplica cuando tipo_destino es 'equipo'",
      });
    }

    if (data.origen === "tanque_propio") {
      if (data.combustible_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["combustible_id"],
          message: "combustible_id es obligatorio cuando origen es 'tanque_propio'",
        });
      }
      if (data.lectura_contometro === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_contometro"],
          message: "lectura_contometro es obligatoria cuando origen es 'tanque_propio'",
        });
      }
      if (data.grifo_externo !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grifo_externo"],
          message: "grifo_externo no aplica a 'tanque_propio'",
        });
      }
      if (
        data.lectura_horometro !== undefined ||
        data.lectura_odometro !== undefined ||
        data.horas_abastecidas !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["origen"],
          message: "horómetro/odómetro/horas_abastecidas no aplican a 'tanque_propio'",
        });
      }
    } else {
      // compra_externa
      // El horómetro/odómetro es una lectura del EQUIPO (hallazgo 9) --
      // sin equipo_id (destino planta/reserva_cubeta) esa lectura no
      // correspondería a ningún medidor real. No estaba en el prompt
      // cerrado palabra por palabra, pero se deduce directo de esa misma
      // decisión: no tiene sentido pedir horómetro/odómetro sin equipo.
      if (data.tipo_destino !== "equipo") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tipo_destino"],
          message:
            "'compra_externa' exige tipo_destino='equipo' -- el horómetro/odómetro es una lectura del equipo, no tiene sentido sin uno",
        });
      }
      if (data.combustible_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["combustible_id"],
          message: "combustible_id no aplica a 'compra_externa'",
        });
      }
      if (data.lectura_contometro !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_contometro"],
          message: "lectura_contometro no aplica a 'compra_externa' (el grifo ajeno no la incluye)",
        });
      }
      if (data.horas_abastecidas === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["horas_abastecidas"],
          message: "horas_abastecidas es obligatoria cuando origen es 'compra_externa'",
        });
      }
      const tieneHorometro = data.lectura_horometro !== undefined;
      const tieneOdometro = data.lectura_odometro !== undefined;
      if (tieneHorometro === tieneOdometro) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lectura_horometro"],
          message:
            "'compra_externa' exige exactamente uno de lectura_horometro/lectura_odometro, nunca los dos ni ninguno",
        });
      }
    }
  });

export type CrearDespachoCombustibleInput = z.infer<typeof crearDespachoCombustibleSchema>;
