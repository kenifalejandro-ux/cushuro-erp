import { z } from "zod";

// El email es único por tenant, no global (ver migrations/0001_tenants_usuarios.sql),
// así que el login necesita saber a qué tenant pertenece el usuario antes de
// buscarlo por correo — de lo contrario, dos tenants con un usuario de mismo
// email serían indistinguibles.
const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Ingresa el identificador de tu empresa")
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Identificador de empresa inválido");

export const loginSchema = z.object({
  tenantSlug: tenantSlugSchema,
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const googleLoginSchema = z.object({
  tenantSlug: tenantSlugSchema,
  credential: z.string({ required_error: "El credential de Google es obligatorio" }).min(1),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const forgotPasswordSchema = z.object({
  tenantSlug: tenantSlugSchema,
  email: z.string().trim().toLowerCase().email("Correo inválido").max(150),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token requerido"),
  newPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
