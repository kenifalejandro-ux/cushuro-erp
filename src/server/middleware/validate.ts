import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny } from "zod";

export const validate =
  (schema: ZodTypeAny) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedData = await schema.parseAsync(req.body);
      req.validatedBody = parsedData;
      next();
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));

        if (req.log) {
          req.log.warn({ errors }, "Datos invalidos en formulario");
        } else {
          console.warn("Datos invalidos en formulario", { errors });
        }

        return res.status(400).json({ errors });
      }

      if (req.log) {
        req.log.error({ err: error }, "Error inesperado validando formulario");
      } else {
        console.error("Error inesperado validando formulario", error);
      }

      return res.status(500).json({ message: "Error interno validando formulario" });
    }
  };
