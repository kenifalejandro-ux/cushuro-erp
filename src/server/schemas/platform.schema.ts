import { z } from "zod";

export const crearTenantSchema = z.object({
  tenantNombre: z.string().trim().min(1, "Nombre de tenant requerido").max(200),
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "El slug solo admite minúsculas, números y guiones"),
  adminNombre: z.string().trim().min(1, "Nombre del admin requerido").max(100),
  adminEmail: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  adminPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type CrearTenantInput = z.infer<typeof crearTenantSchema>;
