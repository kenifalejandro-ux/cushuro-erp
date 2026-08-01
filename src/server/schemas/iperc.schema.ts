import { z } from "zod";

export const crearIpercSchema = z.object({
  area_frente: z.string().trim().min(1, "Área/frente requerido").max(200),
  turno: z.string().trim().max(20).optional(),
  equipo_id: z.number().int().positive().optional(),
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
    .min(1, "El IPERC necesita al menos una línea"),
});

export type CrearIpercInput = z.infer<typeof crearIpercSchema>;

export const cambiarEstadoIpercSchema = z.object({
  estado: z.enum(["aprobado", "rechazado"]),
});

export type CambiarEstadoIpercInput = z.infer<typeof cambiarEstadoIpercSchema>;
