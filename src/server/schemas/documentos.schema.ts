import { z } from "zod";

export const crearDocumentoSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al guardar, online u
  // offline (ver client/src/offline/). Opcional a propósito: sin él, la
  // creación se comporta igual que siempre. Con él, un reintento del mismo
  // envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  nombre_documento: z.string().trim().min(1).max(200),
  responsable: z.string().trim().max(150).optional(),
  fecha_vencimiento: z.string().min(1),
});

export type CrearDocumentoInput = z.infer<typeof crearDocumentoSchema>;

// Multer ya dejó el archivo en req.file y este campo de texto en req.body
// cuando este schema corre (ver documentos.routes.ts: subirArchivoDocumento
// va ANTES que validate() en la cadena de middlewares).
export const subirVersionDocumentoSchema = z.object({
  cliente_uuid: z.string().uuid().optional(),
});

export type SubirVersionDocumentoInput = z.infer<typeof subirVersionDocumentoSchema>;
