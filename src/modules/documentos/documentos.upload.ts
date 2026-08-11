/** src/modules/documentos/documentos.upload.ts
 *
 * Middleware de subida para el archivo adjunto de un documento (PDF/imagen
 * de una licencia, certificado, etc). Memoria, no disco temporal: el
 * tamaño máximo (10 MB) es chico a propósito para que tenerlo un instante
 * en un Buffer no sea un problema, y así ni el driver local ni el s3
 * necesitan lidiar con un archivo temporal que limpiar.
 *
 * Traduce los rechazos de multer (tipo no permitido, tamaño excedido) a
 * AppError con mensaje claro -- sin esto, un archivo de 11 MB terminaría
 * como un 500 genérico en vez de un 400 explicando el límite.
 */
import multer, { MulterError } from "multer";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../server/shared/middlewares/error.middleware";

export const MIME_TYPES_PERMITIDOS = new Set(["application/pdf", "image/jpeg", "image/png"]);
export const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANO_MAXIMO_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!MIME_TYPES_PERMITIDOS.has(file.mimetype)) {
      cb(
        new AppError(
          400,
          `Tipo de archivo no permitido (${file.mimetype}). Solo se acepta PDF, JPG o PNG.`
        )
      );
      return;
    }
    cb(null, true);
  },
}).single("archivo");

export function subirArchivoDocumento(req: Request, res: Response, next: NextFunction) {
  upload(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new AppError(400, `El archivo supera el máximo permitido de 10 MB`));
        return;
      }
      next(new AppError(400, `Error al subir el archivo: ${err.message}`));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    if (!req.file) {
      next(new AppError(400, "No se recibió ningún archivo (campo esperado: 'archivo')"));
      return;
    }
    next();
  });
}
