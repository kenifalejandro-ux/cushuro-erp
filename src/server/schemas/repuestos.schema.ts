import { z } from "zod";

// ── Catálogo (crear / editar / carga masiva) ────────────────────────────
//
// Hasta acá `create`/`update`/`createBulk` (repuestos.repository.ts)
// mandaban `req.body` crudo a la query -- omitir un campo NOT NULL sin
// default (ej. `categoria`) tiraba un 500 de Postgres en vez de un 400
// claro o un default razonable. Mismo patrón que tuvo Documentos antes de
// validarse (PR #81): los defaults de acá son los mismos que ya aplicaba
// `createBulk()` a mano (`categoria ?? "General"`, `stock ?? 0`, etc.) --
// se centralizan como fuente única de verdad, no se inventan nuevos.
export const crearRepuestoSchema = z.object({
  codigo: z.string().trim().min(1).max(50),
  nombre: z.string().trim().min(1).max(200),
  categoria: z.string().trim().max(100).default("General"),
  stock: z.number().int().nonnegative().default(0),
  stock_minimo: z.number().int().nonnegative().default(5),
  stock_maximo: z.number().int().nonnegative().default(30),
  precio: z.number().nonnegative().default(0),
});

export type CrearRepuestoInput = z.infer<typeof crearRepuestoSchema>;

// PUT reemplaza la fila entera (mismo criterio que
// actualizarDocumentoSchema, documentos.schema.ts): omitir un campo en una
// edición no significa "dejalo como está", así que acá NINGUNO tiene
// `.default()` -- todos quedan obligatorios.
export const actualizarRepuestoSchema = z.object({
  codigo: z.string().trim().min(1).max(50),
  nombre: z.string().trim().min(1).max(200),
  categoria: z.string().trim().max(100),
  stock: z.number().int().nonnegative(),
  stock_minimo: z.number().int().nonnegative(),
  stock_maximo: z.number().int().nonnegative(),
  precio: z.number().nonnegative(),
});

export type ActualizarRepuestoInput = z.infer<typeof actualizarRepuestoSchema>;

/** Tope de filas por importación -- mismo valor y mismo motivo que
 *  MAX_FILAS_CARGA_MASIVA en documentos.schema.ts: acota el trabajo que un
 *  solo request le impone a la base compartida por todos los tenants. */
export const MAX_FILAS_CARGA_MASIVA = 5000;

// El body de /bulk es un ARRAY crudo, no un objeto que lo envuelva -- así
// lo manda el cliente y así lo cuenta el middleware de cuota
// (`cantidadACrear()`, cuota.middleware.ts: `req.body.length`).
export const cargaMasivaRepuestosSchema = z
  .array(crearRepuestoSchema)
  .min(1, "La importación no puede estar vacía")
  .max(
    MAX_FILAS_CARGA_MASIVA,
    `No se pueden importar más de ${MAX_FILAS_CARGA_MASIVA} filas de una vez`
  );

export type CargaMasivaRepuestosInput = z.infer<typeof cargaMasivaRepuestosSchema>;

// ── Movimientos de stock (entrada/salida) ───────────────────────────────
export const registrarMovimientoRepuestoSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al abrir el modal,
  // online u offline (ver client/src/offline/). Opcional a propósito: sin
  // él, la creación se comporta igual que siempre. Con él, un reintento del
  // mismo envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  repuesto_id: z.number().int().positive(),
  tipo: z.enum(["entrada", "salida"]),
  cantidad: z.number().int().positive(),
  motivo: z.string().max(200).optional(),
  // Cuándo pasó el movimiento, no cuándo llegó al servidor -- solo para el
  // historial (ver migrations/0046_repuestos_movimientos.sql, a diferencia
  // de Combustible NO decide si el stock se actualiza). Opcional: sin dato,
  // el service usa now().
  registrado_en: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Vínculo opcional a la OT que motivó el movimiento (ver migrations/0050).
  // Sin exigir ningún estado de la OT en este PR -- eso es regla de negocio
  // a evaluar después si hace falta.
  orden_trabajo_id: z.number().int().positive().optional(),
});

export type RegistrarMovimientoRepuestoInput = z.infer<typeof registrarMovimientoRepuestoSchema>;
