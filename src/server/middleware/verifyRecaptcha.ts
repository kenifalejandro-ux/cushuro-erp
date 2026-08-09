import axios from "axios";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { getClientIp, getRequestId } from "../shared/utils/request";
import { asyncHandler } from "../shared/utils/asyncHandler";

export const verifyRecaptcha = asyncHandler(async function verifyRecaptcha(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = getRequestId(req);
  const token =
    typeof req.body?.recaptcha_token === "string" ? req.body.recaptcha_token.trim() : "";

  if (!env.recaptchaSecretKey) {
    if (req.log) {
      req.log.error("RECAPTCHA_SECRET_KEY no esta configurado");
    } else {
      console.error("RECAPTCHA_SECRET_KEY no esta configurado");
    }

    return res
      .status(500)
      .json({ message: "La validacion anti-spam no esta configurada en el servidor." });
  }

  if (!token) {
    return res.status(400).json({
      errors: [{ field: "recaptcha_token", message: "Token de reCAPTCHA faltante" }],
    });
  }

  try {
    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      new URLSearchParams({
        secret: env.recaptchaSecretKey,
        response: token,
        remoteip: getClientIp(req),
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 5000,
        validateStatus: () => true,
      }
    );

    if (response.status !== 200) {
      if (req.log) {
        req.log.error(
          { status: response.status, requestId },
          "Respuesta inesperada del proveedor de reCAPTCHA"
        );
      } else {
        console.error("Respuesta inesperada del proveedor de reCAPTCHA", {
          status: response.status,
          requestId,
        });
      }

      return res.status(502).json({ message: "No se pudo validar la proteccion anti-spam." });
    }

    const result = response.data as {
      success?: boolean;
      score?: number;
      action?: string;
      hostname?: string;
      "error-codes"?: string[];
    };

    const actionMatches =
      !env.recaptchaExpectedAction ||
      !result.action ||
      result.action === env.recaptchaExpectedAction;
    const scoreMatches =
      typeof result.score !== "number" || Number.isNaN(result.score)
        ? true
        : result.score >= env.recaptchaMinScore;

    if (!result.success || !actionMatches || !scoreMatches) {
      if (req.log) {
        req.log.warn(
          {
            requestId,
            score: result.score,
            action: result.action,
            errorCodes: result["error-codes"],
            hostname: result.hostname,
          },
          "reCAPTCHA rechazo el envio del formulario"
        );
      } else {
        console.warn("reCAPTCHA rechazo el envio del formulario", {
          requestId,
          score: result.score,
          action: result.action,
          errorCodes: result["error-codes"],
          hostname: result.hostname,
        });
      }

      return res.status(400).json({
        errors: [
          {
            field: "recaptcha_token",
            message: "Falló la verificacion anti-spam. Intenta nuevamente.",
          },
        ],
      });
    }

    next();
  } catch (error) {
    if (req.log) {
      req.log.error({ err: error, requestId }, "Error verificando reCAPTCHA");
    } else {
      console.error("Error verificando reCAPTCHA", { error, requestId });
    }

    return res.status(502).json({ message: "No se pudo completar la verificacion anti-spam." });
  }
});
