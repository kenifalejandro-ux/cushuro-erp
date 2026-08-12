import { z } from "zod";

// ── Línea Base ─────────────────────────────────────────────────────────
export const crearLineaBaseSchema = z.object({
  proceso_actividad: z.string().trim().min(1, "Proceso/actividad requerido").max(200),
  area_frente: z.string().trim().max(200).optional(),
  items: z
    .array(
      z.object({
        etapa_actividad: z.string().trim().min(1).max(300),
        peligro: z.string().trim().min(1).max(300),
        riesgo: z.string().trim().min(1).max(300),
        probabilidad: z.number().int().min(1).max(4),
        severidad: z.number().int().min(1).max(4),
        medidas_control: z.string().trim().min(1).max(2000),
      })
    )
    .min(1, "La línea base necesita al menos un ítem"),
});

export type CrearLineaBaseInput = z.infer<typeof crearLineaBaseSchema>;

// ── Continuo / Específico (comparten estructura, ver tipo) ──────────────
// Cada ítem: o referencia un ítem ya aprobado de la línea base, o trae
// todos los campos manuales completos — no una mezcla a medias.
const itemIpercSchema = z
  .object({
    linea_base_item_id: z.number().int().positive().optional(),
    etapa_actividad: z.string().trim().min(1).max(300).optional(),
    peligro: z.string().trim().min(1).max(300).optional(),
    riesgo: z.string().trim().min(1).max(300).optional(),
    probabilidad: z.number().int().min(1).max(4).optional(),
    severidad: z.number().int().min(1).max(4).optional(),
    medidas_control: z.string().trim().min(1).max(2000).optional(),
  })
  .refine(
    (item) =>
      item.linea_base_item_id !== undefined ||
      (!!item.etapa_actividad &&
        !!item.peligro &&
        !!item.riesgo &&
        item.probabilidad !== undefined &&
        item.severidad !== undefined &&
        !!item.medidas_control),
    { message: "Cada ítem necesita linea_base_item_id o todos los campos manuales completos" }
  );

export const crearIpercSchema = z
  .object({
    // Lo genera el dispositivo con crypto.randomUUID() al apretar
    // "Registrar IPERC", online u offline (ver client/src/offline/).
    // Opcional a propósito: sin él, la creación se comporta exactamente
    // como siempre. Con él, un reintento del mismo envío no duplica (ver
    // idempotentInsert.ts).
    cliente_uuid: z.string().uuid().optional(),
    tipo: z.enum(["continuo", "especifico"]).default("continuo"),
    area_frente: z.string().trim().min(1, "Área/frente requerido").max(200),
    turno: z.string().trim().max(20).optional(),
    equipo_id: z.number().int().positive().optional(),
    linea_base_id: z.number().int().positive().optional(),
    tarea_especifica: z.string().trim().max(300).optional(),
    items: z.array(itemIpercSchema).min(1, "El IPERC necesita al menos una línea"),
  })
  .refine((data) => data.tipo !== "especifico" || !!data.tarea_especifica, {
    message: "tarea_especifica es requerida cuando tipo es 'especifico'",
    path: ["tarea_especifica"],
  });

export type CrearIpercInput = z.infer<typeof crearIpercSchema>;

export const cambiarEstadoIpercSchema = z.object({
  estado: z.enum(["aprobado", "rechazado"]),
});

export type CambiarEstadoIpercInput = z.infer<typeof cambiarEstadoIpercSchema>;
