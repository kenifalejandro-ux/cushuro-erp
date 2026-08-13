/** src/modules/documentos/documentos.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { sanearNombreArchivo } from "../../server/services/documentStorage";
import { leerClaveIdempotencia } from "../../server/shared/utils/idempotencyKey";
import type {
  CrearDocumentoInput,
  ActualizarDocumentoInput,
  CargaMasivaDocumentosInput,
  SubirVersionDocumentoInput,
} from "../../server/schemas/documentos.schema";
import { DocumentosService } from "./documentos.service";

export const DocumentosController = {
  // 📄 LISTAR DOCUMENTOS (paginado)
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        DocumentosService.getAll(client, tenantId, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al obtener documentos" });
    }
  },

  // 🔍 VERIFICAR DUPLICADO (aviso, no bloqueo -- ver createDoc() en el
  // cliente). Solo se llama en el camino interactivo online: sin red, el
  // cliente ni siquiera intenta esta consulta y deja que la creación se
  // encole como siempre, sin advertir nada.
  async verificarDuplicado(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const nombre = typeof req.query.nombre === "string" ? req.query.nombre : "";
      const fecha = typeof req.query.fecha === "string" ? req.query.fecha : "";

      if (!nombre.trim() || !fecha.trim()) {
        res.json({ duplicado: false });
        return;
      }

      const existente = await withTenant(tenantId, (client) =>
        DocumentosService.verificarDuplicado(client, tenantId, nombre, fecha)
      );

      res.json({ duplicado: existente !== null, documento: existente ?? undefined });
    } catch {
      // Best-effort: si esto falla, el cliente sigue con la creación normal
      // en vez de bloquear a alguien por un problema en el chequeo.
      res.json({ duplicado: false });
    }
  },

  // ➕ CREAR DOCUMENTO (manual, con soporte de cliente_uuid para offline)
  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearDocumentoInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        DocumentosService.create(client, tenantId, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Este documento ya se había registrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.creado", { documentoId: fila!.id });
      res.status(201).json(fila);
    } catch {
      res.status(500).json({ error: "Error al crear documento" });
    }
  },

  // ✏️ EDITAR DOCUMENTO
  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const cambios = req.validatedBody as ActualizarDocumentoInput;
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.update(client, tenantId, Number(req.params.id), cambios)
      );

      if (!data) {
        res.status(404).json({ error: "Documento no encontrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.actualizado", { documentoId: data.id });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al actualizar documento" });
    }
  },

  // 🗑️ ELIMINAR DOCUMENTO
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      // Sin withTenant() acá: el service abre su propia transacción corta y
      // después borra los archivos del storage, que es trabajo de red que no
      // debe correr con una conexión de Postgres tomada.
      const eliminado = await DocumentosService.delete(tenantId, id);

      if (!eliminado) {
        res.status(404).json({ error: "Documento no encontrado" });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.eliminado", { documentoId: id });
      res.json({ message: "Eliminado correctamente" });
    } catch {
      res.status(500).json({ error: "Error al eliminar" });
    }
  },

  // 📊 CARGA MASIVA EXCEL (JSON)
  async bulkCreate(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const filas = req.validatedBody as CargaMasivaDocumentosInput;

      // El cliente lo deriva del contenido del archivo, así que reelegir la
      // misma planilla tras un corte de red se reconoce como reintento en
      // vez de duplicar. Si viene con formato inválido se ignora en vez de
      // rechazar: la importación es lo que el usuario pidió, y perderla por
      // un header mal armado sería peor que procesarla sin idempotencia.
      const claveIdempotencia = leerClaveIdempotencia(req);

      const { yaProcesado, resultado } = await withTenant(tenantId, (client) =>
        DocumentosService.bulkCreate(client, tenantId, filas, claveIdempotencia)
      );

      if (yaProcesado) {
        // 200 y no 201: esta llamada no creó nada. Igual es un éxito para
        // quien reintenta -- su importación está hecha.
        res.status(200).json({ yaImportado: true, insertadas: 0 });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.carga_masiva", {
        cantidad: resultado,
      });
      // Se devuelve el conteo y no las filas: una importación de miles de
      // registros no tiene por qué volver entera al cliente, que igual
      // recarga la lista paginada después.
      res.status(201).json({ insertadas: resultado });
    } catch {
      res.status(500).json({ error: "Error en carga masiva" });
    }
  },

  // 📊 KPIs DASHBOARD
  async kpis(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.getKPIs(client, tenantId)
      );
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error en KPIs" });
    }
  },

  // 📎 SUBIR ARCHIVO (nueva versión) -- req.file lo deja documentos.upload.ts
  async subirVersion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const documentoId = Number(req.params.id);
      const archivo = req.file!;
      const { cliente_uuid } = req.validatedBody as SubirVersionDocumentoInput;

      const resultado = await DocumentosService.subirVersion(
        tenantId,
        documentoId,
        {
          buffer: archivo.buffer,
          mimeType: archivo.mimetype,
          nombreOriginal: archivo.originalname,
        },
        req.usuario!.id,
        cliente_uuid
      );

      if (!resultado) {
        res.status(404).json({ error: "Documento no encontrado" });
        return;
      }

      const { fila, creado } = resultado;

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta versión ya se había subido" });
        return;
      }

      await publicarEventoTenant(tenantId, "documentos.version_subida", {
        documentoId,
        versionId: fila!.id,
      });
      res.status(201).json(fila);
    } catch {
      res.status(500).json({ error: "Error al subir el archivo" });
    }
  },

  // 📎 LISTAR VERSIONES
  async listarVersiones(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const documentoId = Number(req.params.id);
      const data = await withTenant(tenantId, (client) =>
        DocumentosService.listarVersiones(client, tenantId, documentoId)
      );

      if (!data) {
        res.status(404).json({ error: "Documento no encontrado" });
        return;
      }

      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al listar versiones" });
    }
  },

  // 📎 DESCARGAR VERSIÓN -- redirect (driver s3) o stream directo (driver local)
  async descargarVersion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const documentoId = Number(req.params.id);
      const versionId = Number(req.params.versionId);

      const resultado = await withTenant(tenantId, (client) =>
        DocumentosService.obtenerDescargaVersion(client, tenantId, documentoId, versionId)
      );

      if (!resultado) {
        res.status(404).json({ error: "Versión no encontrada" });
        return;
      }

      const { descarga, nombreOriginal, mimeType } = resultado;
      if (descarga.tipo === "redirect") {
        res.redirect(302, descarga.url);
        return;
      }

      res.setHeader("Content-Type", mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${sanearNombreArchivo(nombreOriginal)}"`
      );
      res.send(descarga.contenido);
    } catch {
      res.status(500).json({ error: "Error al descargar el archivo" });
    }
  },
};
