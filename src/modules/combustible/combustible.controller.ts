/**src/modules/combutible/combustible.controller.ts */

import { Request, Response } from "express";
import { withTenant } from "../../server/config/database";
import { getTenantId } from "../../server/shared/utils/request";
import { parsePaginacion, armarRespuestaPaginada } from "../../server/shared/utils/pagination";
import { contextoAuditoriaModulo } from "../../server/shared/utils/moduleAudit";
import { registrarAuditoria } from "../../server/services/platformAudit.service";
import { publicarEventoTenant } from "../../server/services/realtimeEvents.service";
import { logger } from "../../server/config/logger";
import { enviarCorreoAlertaHueco, enviarCorreoAlertaAnulacion } from "./combustibleAlertas.mailer";
import type {
  RegistrarLecturaCombustibleInput,
  ActualizarNivelCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
  CargaMasivaTanquesCombustibleInput,
  AnularLecturaCombustibleInput,
  CrearDespachoCombustibleInput,
  CrearGrifoCombustibleInput,
  ActualizarGrifoCombustibleInput,
  CrearPrecioCombustibleInput,
  AnularPrecioCombustibleInput,
  CrearRecepcionCombustibleInput,
  AnularRecepcionCombustibleInput,
  AnularDespachoCombustibleInput,
  MarcarAlertasLeidasCombustibleInput,
} from "../../server/schemas/combustible.schema";
import { CombustibleService } from "./combustible.service";

const service = new CombustibleService();

export class CombustibleController {
  async getAll(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = await withTenant(tenantId, (client) => service.getAll(client, tenantId));
      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));

      if (!data) {
        return res.status(404).json({ error: "No encontrado" });
      }

      res.json(data);
    } catch {
      res.status(500).json({ error: "Error al obtener combustible" });
    }
  }

  async create(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearTanqueCombustibleInput;
      const nuevo = await withTenant(tenantId, (client) => service.create(client, tenantId, data));
      await registrarAuditoria({
        accion: "combustible.tanque_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: nuevo.id, codigo: nuevo.codigo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_creado", {
        combustibleId: nuevo.id,
      });
      res.status(201).json(nuevo);
    } catch {
      res.status(500).json({ error: "Error al crear el tanque" });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarTanqueCombustibleInput;
      const actualizado = await withTenant(tenantId, (client) =>
        service.update(client, tenantId, id, data)
      );

      if (!actualizado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.tanque_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_actualizado", {
        combustibleId: id,
      });
      res.json(actualizado);
    } catch {
      res.status(500).json({ error: "Error al actualizar el tanque" });
    }
  }

  /** Soft-delete exclusivamente -- ver CombustibleRepository.softDelete: un
   *  DELETE real borraría en cascada el historial de combustible_lecturas. */
  async delete(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const desactivado = await withTenant(tenantId, (client) =>
        service.softDelete(client, tenantId, id)
      );

      if (!desactivado) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.tanque_eliminar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanque_eliminado", {
        combustibleId: id,
      });
      res.json({ message: "Tanque desactivado" });
    } catch {
      res.status(500).json({ error: "Error al desactivar el tanque" });
    }
  }

  async bulk(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const rows = req.validatedBody as CargaMasivaTanquesCombustibleInput;
      const result = await withTenant(tenantId, (client) =>
        service.createBulk(client, tenantId, rows)
      );
      // UNA fila de auditoría con el conteo, no una por tanque -- mismo
      // criterio que repuestos.carga_masiva (RepuestosController.bulk).
      await registrarAuditoria({
        accion: "combustible.tanques_carga_masiva",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { cantidad: result.length },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.tanques_carga_masiva", {
        cantidad: result.length,
      });
      res.status(201).json({ insertados: result.length, data: result });
    } catch {
      res.status(500).json({ error: "Error en importación masiva" });
    }
  }

  /** GET /:id/lecturas -- el histórico de aforos del tanque, que hasta acá
   *  era dato muerto (se guardaba en cada lectura pero no había forma de
   *  consultarlo salvo entrar a la base directo). */
  async getLecturas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);

      const tanque = await withTenant(tenantId, (client) => service.getById(client, tenantId, id));
      if (!tanque) {
        return res.status(404).json({ error: "No encontrado" });
      }

      const paginacion = parsePaginacion(req.query);
      const filas = await withTenant(tenantId, (client) =>
        service.getLecturas(client, tenantId, id, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al obtener el histórico de lecturas" });
    }
  }

  /** PATCH /lecturas/:lecturaId/anular -- marca una lectura mal cargada
   *  como anulada (con motivo obligatorio) y recalcula el nivel del tanque.
   *  La fila NUNCA se borra ni se edita: queda como evidencia de que hubo
   *  un error y quién lo corrigió. Ver migrations/0058. */
  async anularLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const lecturaId = Number(req.params.lecturaId);
      const { motivo } = req.validatedBody as AnularLecturaCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulada = await service.anularLectura(
          client,
          tenantId,
          lecturaId,
          req.usuario!.id,
          motivo
        );
        if (anulada) return { estado: "anulada" as const, ...anulada };

        // El UPDATE no afectó nada: o la lectura no existe en este tenant,
        // o ya estaba anulada. Hay que distinguirlo para no responder 404
        // ante algo que sí existe (y viceversa).
        const existente = await service.getLecturaPorId(client, tenantId, lecturaId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        return res.status(404).json({ error: "Lectura no encontrada" });
      }
      if (resultado.estado === "ya_anulada") {
        // 409 y no 400: no es un dato mal formado, es un rechazo por el
        // ESTADO actual del recurso -- mismo criterio que el stock
        // insuficiente de repuestos.
        return res.status(409).json({ error: "Esta lectura ya estaba anulada" });
      }

      await registrarAuditoria({
        accion: "combustible.anular_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        // Solo ids y la referencia, nunca el contenido de negocio -- mismo
        // criterio que el resto de moduleAudit. El motivo SÍ va: es la
        // razón de una acción correctiva, justo lo que la auditoría tiene
        // que poder responder después.
        detalle: {
          lecturaId,
          combustibleId: resultado.lectura.combustible_id,
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_anulada", {
        lecturaId,
        combustibleId: resultado.lectura.combustible_id,
      });

      res.json({ lectura: resultado.lectura, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la lectura" });
    }
  }

  /** Legacy: mismo contrato de siempre (body `{ nivel_actual }`, responde el
   *  tanque). Ya no sobreescribe `nivel_actual` directo por dentro -- ver
   *  `CombustibleService.actualizarNivelLegacy`. */
  async updateNivel(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const { nivel_actual } = req.validatedBody as ActualizarNivelCombustibleInput;

      const updated = await withTenant(tenantId, (client) =>
        service.actualizarNivelLegacy(client, tenantId, req.usuario!.id, id, nivel_actual)
      );

      if (!updated) {
        return res.status(404).json({ error: "No encontrado" });
      }

      await registrarAuditoria({
        accion: "combustible.actualizar_nivel",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { combustibleId: id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.nivel_actualizado", {
        combustibleId: id,
        nivelActual: nivel_actual,
      });
      res.json(updated);
    } catch (err) {
      // El tanque no existe en este tenant -- mismo motivo que el 404 de
      // siempre (`updated` null), solo que acá llega como excepción porque
      // registrarLectura() valida la FK antes de insertar. Se preserva el
      // 404 histórico de este endpoint, NO el 400 del endpoint nuevo (ver
      // registrarLectura más abajo) -- no romper el contrato existente.
      if (err instanceof Error && err.message.includes("no existe en este tenant")) {
        res.status(404).json({ error: "No encontrado" });
        return;
      }
      // Este SÍ es 400 incluso en el endpoint legacy: no es "no encontrado",
      // es un dato imposible para un tanque que sí existe.
      if (err instanceof Error && err.message.includes("supera la capacidad del tanque")) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar nivel" });
    }
  }

  /** POST /combustible/lecturas -- crea una lectura histórica y, si es la
   *  más reciente, actualiza `nivel_actual` (ver
   *  CombustibleRepository.registrarLectura). Único endpoint de Combustible
   *  que participa de la cola offline: `combustible_id` viaja en el body a
   *  propósito, no en la URL -- el motor offline del cliente
   *  (rutasOffline.ts) solo matchea rutas literales, sin parámetros. */
  async registrarLectura(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as RegistrarLecturaCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.registrarLectura(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado (la respuesta
      // original se perdió en la red). No se publica el evento de nuevo --
      // eso ya pasó la primera vez. 200 y no 201 porque esta llamada no
      // creó nada, pero sí es un éxito para la cola offline del dispositivo.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta lectura ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.registrar_lectura",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { lecturaId: fila!.lectura.id, combustibleId: data.combustible_id },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.lectura_registrada", {
        lecturaId: fila!.lectura.id,
        combustibleId: data.combustible_id,
        nivel: data.nivel,
      });
      res.status(201).json(fila);
    } catch (err) {
      // Los dos casos van con 400: son datos que se contradicen a sí mismos
      // (un tanque que no existe, un nivel imposible para ese tanque), no
      // fallas del servidor. El 4xx además hace que la cola offline los
      // descarte sin reintentar y los reporte, en vez de reintentar para
      // siempre algo que nunca va a entrar (ver esErrorPermanente() en
      // client/src/offline/offlineSync.ts).
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("supera la capacidad del tanque"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar lectura de combustible" });
    }
  }

  // ── Despachos (Fase B) ─────────────────────────────────────────────────

  /** POST /despachos -- crea el vale digital. Único endpoint de despachos
   *  que participa de la cola offline (ver registry.ts): equipo_id/
   *  combustible_id viajan en el body a propósito, mismo motivo que
   *  combustible_id en /lecturas (rutasOffline.ts solo matchea rutas
   *  literales, sin parámetros). */
  async crearDespacho(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearDespachoCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearDespacho(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío que ya se había guardado -- mismo criterio
      // que registrarLectura: 200 (no 201, no creó nada) para que la cola
      // offline lo dé por sincronizado sin duplicar auditoría ni evento.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Este despacho ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.despacho_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          despachoId: fila!.id,
          origen: data.origen,
          serieTalonario: data.serie_talonario,
          nVale: data.n_vale,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.despacho_creado", {
        despachoId: fila!.id,
      });
      await this.procesarAlertasDespachoCreado(
        tenantId,
        fila!.id,
        data.serie_talonario,
        data.n_vale
      );
      res.status(201).json(fila);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya está registrado")) {
        // 409: no es un dato mal formado, es el mismo vale tipeado dos
        // veces -- mismo criterio que el vale duplicado del punto 5.
        res.status(409).json({ error: err.message });
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes("el contómetro marcó") ||
          err.message.includes("no existe en este tenant") ||
          err.message.includes("no tiene tipo de medidor configurado") ||
          err.message.includes("se mide por") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como"))
      ) {
        // Todos estos son datos que se contradicen a sí mismos o a una
        // fila que el propio request referenció mal -- 400, corregible ahí
        // mismo con el papel en la mano (ver el punto 5 del documento).
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar el despacho" });
    }
  }

  /** PATCH /despachos/:despachoId/anular -- la válvula de escape del punto 3
   *  del documento de diseño. Mismo mecanismo exacto que anularLectura y
   *  anularPrecio: 404 si no existe en este tenant, 409 si ya estaba anulada
   *  (para no pisar el motivo y el autor de la anulación original, que son la
   *  evidencia de quién corrigió qué). */
  async anularDespacho(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const despachoId = Number(req.params.despachoId);
      const { motivo } = req.validatedBody as AnularDespachoCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularDespacho(
          client,
          tenantId,
          despachoId,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, despacho: anulado };

        const existente = await service.getDespachoPorId(client, tenantId, despachoId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Despacho no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este despacho ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.despacho_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          despachoId,
          serieTalonario: resultado.despacho.serie_talonario,
          nVale: resultado.despacho.n_vale,
          motivo,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.despacho_anulado", { despachoId });
      await this.procesarAlertaAnulacion(
        tenantId,
        despachoId,
        resultado.despacho.serie_talonario,
        resultado.despacho.n_vale,
        motivo
      );
      res.json(resultado.despacho);
    } catch {
      res.status(500).json({ error: "Error al anular el despacho" });
    }
  }

  /** Best-effort, mismo contrato "nunca lanza" que publicarEventoTenant():
   *  corre después de que la transacción de crearDespacho ya confirmó, así
   *  que un fallo acá no puede convertir un 201 real en un 500. */
  private async procesarAlertasDespachoCreado(
    tenantId: string,
    despachoId: number,
    serieTalonario: string,
    nVale: number
  ) {
    try {
      const { huecos, admins } = await withTenant(tenantId, async (client) => {
        // El vale que acaba de llegar puede estar llenando un hueco ya
        // alertado (offline que sincronizó) -- esto corre siempre, sin
        // condicionar, y no hace nada si no había ninguna alerta abierta.
        await service.resolverAlertaHuecoSiExiste(client, tenantId, serieTalonario, nVale);

        const huecos = await service.detectarHuecosRevelados(
          client,
          tenantId,
          serieTalonario,
          despachoId,
          nVale
        );
        if (huecos.length === 0)
          return { huecos, admins: [] as { email: string; nombre: string }[] };

        await service.crearAlertas(
          client,
          tenantId,
          huecos.map((n) => ({
            tipo: "hueco_detectado" as const,
            serieTalonario,
            nVale: n,
            despachoId,
            detalle: { revelado_por_vale: nVale },
          }))
        );
        const admins = await service.findAdminsConCombustibleHabilitado(client, tenantId);
        return { huecos, admins };
      });

      if (huecos.length === 0) return;

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "hueco_detectado",
        serieTalonario,
        valesFaltantes: huecos,
      });
      await enviarCorreoAlertaHueco(admins, {
        serieTalonario,
        valesFaltantes: huecos,
        nValeQueLoRevelo: nVale,
      });
    } catch (err) {
      logger.warn(
        { err, tenantId, despachoId },
        "No se pudo procesar la alerta de hueco de talonario"
      );
    }
  }

  /** Mismo contrato "nunca lanza" que procesarAlertasDespachoCreado(). */
  private async procesarAlertaAnulacion(
    tenantId: string,
    despachoId: number,
    serieTalonario: string,
    nVale: number,
    motivo: string
  ) {
    try {
      const admins = await withTenant(tenantId, async (client) => {
        await service.crearAlertas(client, tenantId, [
          {
            tipo: "vale_anulado",
            serieTalonario,
            nVale,
            despachoId,
            detalle: { motivo },
          },
        ]);
        return service.findAdminsConCombustibleHabilitado(client, tenantId);
      });

      await publicarEventoTenant(tenantId, "combustible.alerta_creada", {
        tipo: "vale_anulado",
        serieTalonario,
        nVale,
      });
      await enviarCorreoAlertaAnulacion(admins, { serieTalonario, nVale, motivo });
    } catch (err) {
      logger.warn({ err, tenantId, despachoId }, "No se pudo procesar la alerta de vale anulado");
    }
  }

  /** GET /despachos -- listado paginado, con filtro opcional por equipo o
   *  serie de talonario. Sin conciliación ni anomalías acá: eso es Fase D. */
  async listarDespachos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const equipoIdRaw = req.query.equipo_id;
      const equipoId =
        typeof equipoIdRaw === "string" && equipoIdRaw.trim() !== ""
          ? Number(equipoIdRaw)
          : undefined;
      const serieTalonario =
        typeof req.query.serie_talonario === "string" ? req.query.serie_talonario : undefined;

      const filas = await withTenant(tenantId, (client) =>
        service.listarDespachos(client, tenantId, { equipoId, serieTalonario }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar despachos" });
    }
  }

  /** GET /despachos/huecos?serie_talonario=XXX -- punto 1 reescrito: una
   *  consulta bajo demanda, sin paginar ni filtrar por fecha (a propósito,
   *  ver el diseño de Fase B). `validate()` solo parsea el body, así que
   *  el query param se valida acá a mano, mismo patrón que el resto del
   *  repo (ver ordenes_trabajo.controller.ts / documentos.controller.ts). */
  async getHuecosTalonario(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const serieTalonario = req.query.serie_talonario;
      if (typeof serieTalonario !== "string" || serieTalonario.trim() === "") {
        res.status(400).json({ error: "El query param serie_talonario es obligatorio" });
        return;
      }

      const resultado = await withTenant(tenantId, (client) =>
        service.detectarHuecos(client, tenantId, serieTalonario)
      );
      res.json(resultado);
    } catch {
      res.status(500).json({ error: "Error al calcular huecos de talonario" });
    }
  }

  // ── Alertas (migrations/0068) ─────────────────────────────────────────

  /** GET /alertas -- pantalla y campanita comparten este mismo listado
   *  (la campanita solo pide ?solo_no_leidas=true). Visibilidad de
   *  gerencia, no del operador (ver combustible.routes.ts). */
  async listarAlertas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const soloNoLeidas = req.query.solo_no_leidas === "true";

      const filas = await withTenant(tenantId, (client) =>
        service.listarAlertas(client, tenantId, { soloNoLeidas }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar alertas" });
    }
  }

  /** PATCH /alertas/leidas -- sin `ids` marca TODAS las no leídas del
   *  tenant (el botón "marcar todas como leídas" de la campanita). Estado
   *  compartido entre admins, no por usuario (ver migrations/0068). */
  async marcarAlertasLeidas(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const { ids } = req.validatedBody as MarcarAlertasLeidasCombustibleInput;
      await withTenant(tenantId, (client) => service.marcarAlertasLeidas(client, tenantId, ids));
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Error al marcar alertas como leídas" });
    }
  }

  /** PATCH /alertas/:alertaId/resolver -- revisión manual, solo aplica a
   *  vale_anulado (un hueco se resuelve solo, ver
   *  resolverAlertaHuecoSiExiste). 404 si no existe o es de otro tipo/ya
   *  estaba resuelta -- el repository no distingue esos casos porque acá
   *  no hace falta: no hay nada más que corregir aparte de reintentar. */
  async resolverAlertaManual(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const alertaId = Number(req.params.alertaId);

      const resuelta = await withTenant(tenantId, (client) =>
        service.resolverAlertaManual(client, tenantId, alertaId, req.usuario!.id)
      );
      if (!resuelta) {
        res
          .status(404)
          .json({ error: "Alerta no encontrada, ya revisada, o no es de tipo revisable" });
        return;
      }
      res.json(resuelta);
    } catch {
      res.status(500).json({ error: "Error al resolver la alerta" });
    }
  }

  // ── Grifos externos (migrations/0063) ─────────────────────────────────

  async listarGrifos(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const grifos = await withTenant(tenantId, (client) => service.listarGrifos(client, tenantId));
      res.json(grifos);
    } catch {
      res.status(500).json({ error: "Error al listar grifos" });
    }
  }

  async crearGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearGrifoCombustibleInput;
      const grifo = await withTenant(tenantId, (client) =>
        service.crearGrifo(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "combustible.grifo_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          grifoId: grifo.id,
          nombre: data.nombre,
          abasteceRuta: data.abastece_ruta,
          abasteceTanque: data.abastece_tanque,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(grifo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya existe un grifo")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el grifo" });
    }
  }

  async actualizarGrifo(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const id = Number(req.params.id);
      const data = req.validatedBody as ActualizarGrifoCombustibleInput;
      const grifo = await withTenant(tenantId, (client) =>
        service.actualizarGrifo(client, tenantId, id, data)
      );
      if (!grifo) {
        res.status(404).json({ error: "Grifo no encontrado" });
        return;
      }
      await registrarAuditoria({
        accion: "combustible.grifo_actualizar",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          grifoId: id,
          abasteceRuta: data.abastece_ruta,
          abasteceTanque: data.abastece_tanque,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(grifo);
    } catch (err) {
      if (err instanceof Error && err.message.includes("ya existe un grifo")) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al actualizar el grifo" });
    }
  }

  // ── Precios de combustible (migrations/0063) ──────────────────────────

  async listarPrecios(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const precios = await withTenant(tenantId, (client) =>
        service.listarPrecios(client, tenantId)
      );
      res.json(precios);
    } catch {
      res.status(500).json({ error: "Error al listar precios" });
    }
  }

  async crearPrecio(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearPrecioCombustibleInput;
      const precio = await withTenant(tenantId, (client) =>
        service.crearPrecio(client, tenantId, req.usuario!.id, data)
      );
      await registrarAuditoria({
        accion: "combustible.precio_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          precioId: precio.id,
          tipoCombustible: data.tipo_combustible,
          precioUnitario: data.precio_unitario,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      res.status(201).json(precio);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("ya existe un grifo"))
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al crear el precio" });
    }
  }

  /** GET /precios/vigente -- el que el frontend llama para autocompletar
   *  el C.U del despacho ANTES de mandar el POST. Devuelve 200 con
   *  `precio: null` si no hay ninguno cargado todavía -- no es un error,
   *  el operador simplemente tipea el costo a mano esta vez. */
  async getPrecioVigente(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const tipoCombustible = req.query.tipo_combustible;
      const combustibleIdRaw = req.query.combustible_id;
      const grifoIdRaw = req.query.grifo_id;
      const fecha = typeof req.query.fecha === "string" ? req.query.fecha : undefined;

      if (typeof tipoCombustible !== "string" || !fecha) {
        res
          .status(400)
          .json({ error: "Los query params tipo_combustible y fecha son obligatorios" });
        return;
      }
      const combustibleId =
        typeof combustibleIdRaw === "string" && combustibleIdRaw !== ""
          ? Number(combustibleIdRaw)
          : null;
      const grifoId =
        typeof grifoIdRaw === "string" && grifoIdRaw !== "" ? Number(grifoIdRaw) : null;
      if ((combustibleId === null) === (grifoId === null)) {
        res
          .status(400)
          .json({ error: "Mandá exactamente uno de combustible_id o grifo_id, nunca los dos" });
        return;
      }

      const precio = await withTenant(tenantId, (client) =>
        service.obtenerPrecioVigente(
          client,
          tenantId,
          tipoCombustible,
          { combustibleId, grifoId },
          fecha
        )
      );
      res.json({ precio });
    } catch {
      res.status(500).json({ error: "Error al buscar el precio vigente" });
    }
  }

  async anularPrecio(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const precioId = Number(req.params.precioId);
      const { motivo } = req.validatedBody as AnularPrecioCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulado = await service.anularPrecio(
          client,
          tenantId,
          precioId,
          req.usuario!.id,
          motivo
        );
        if (anulado) return { estado: "anulada" as const, precio: anulado };

        const existente = await service.getPrecioPorId(client, tenantId, precioId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Precio no encontrado" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Este precio ya estaba anulado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.precio_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { precioId, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      res.json(resultado.precio);
    } catch {
      res.status(500).json({ error: "Error al anular el precio" });
    }
  }

  // ── Recepciones (Fase C, ver migrations/0064) ─────────────────────────

  /** POST /recepciones -- registra cuánto ENTRÓ al tanque propio y a qué
   *  costo. Es lo único que escribe `combustible.costo_promedio` (el
   *  recálculo va adentro del service, en la misma transacción).
   *
   *  NO mueve el nivel del tanque: eso sigue siendo exclusivo de una
   *  lectura de varilla (migración 0059). Ver el encabezado de 0064 sobre
   *  por qué esa independencia es deliberada. */
  async crearRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const data = req.validatedBody as CrearRecepcionCombustibleInput;
      const { fila, creado } = await withTenant(tenantId, (client) =>
        service.crearRecepcion(client, tenantId, req.usuario!.id, data)
      );

      // Reintento de un envío ya guardado (doble clic sobre el mismo
      // formulario) -- 200, no 201: no creó nada, y así el costo promedio
      // no se vuelve a tocar ni se duplica la auditoría.
      if (!creado) {
        res.status(200).json(fila ?? { error: "Esta recepción ya se había registrado" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.recepcion_crear",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: {
          recepcionId: fila!.id,
          combustibleId: data.combustible_id,
          cantidad: data.cantidad,
          costoUnitario: data.costo_unitario,
        },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.recepcion_creada", {
        recepcionId: fila!.id,
        combustibleId: data.combustible_id,
      });
      res.status(201).json(fila);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("no existe en este tenant") ||
          err.message.includes("exige factura o guía") ||
          err.message.includes("no tiene ninguna lectura vigente") ||
          err.message.includes("supera la capacidad del tanque") ||
          // Grifo del rol equivocado (migrations/0065).
          err.message.includes("no está marcado como"))
      ) {
        // Todos son datos que se contradicen a sí mismos o a la
        // configuración del tanque que el propio request referenció -- 400,
        // corregible en el momento (punto 5 del documento de diseño).
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Error al registrar la recepción" });
    }
  }

  /** GET /recepciones -- historial paginado, con filtro opcional por
   *  tanque. Incluye las anuladas (marcadas): son evidencia, no ruido. */
  async listarRecepciones(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const paginacion = parsePaginacion(req.query);
      const combustibleIdRaw = req.query.combustible_id;
      const combustibleId =
        typeof combustibleIdRaw === "string" && combustibleIdRaw.trim() !== ""
          ? Number(combustibleIdRaw)
          : undefined;

      const filas = await withTenant(tenantId, (client) =>
        service.listarRecepciones(client, tenantId, { combustibleId }, paginacion)
      );
      res.json(armarRespuestaPaginada(filas, paginacion));
    } catch {
      res.status(500).json({ error: "Error al listar recepciones" });
    }
  }

  /** PATCH /recepciones/:recepcionId/anular -- mismo mecanismo exacto que
   *  anularLectura/anularPrecio (404 vs 409), con una diferencia: acá el
   *  costo promedio del tanque se recalcula sin la fila anulada, así que la
   *  respuesta devuelve también el tanque con su promedio ya actualizado. */
  async anularRecepcion(req: Request, res: Response) {
    try {
      const tenantId = getTenantId(req);
      const recepcionId = Number(req.params.recepcionId);
      const { motivo } = req.validatedBody as AnularRecepcionCombustibleInput;

      const resultado = await withTenant(tenantId, async (client) => {
        const anulada = await service.anularRecepcion(
          client,
          tenantId,
          recepcionId,
          req.usuario!.id,
          motivo
        );
        if (anulada) return { estado: "anulada" as const, ...anulada };

        const existente = await service.getRecepcionPorId(client, tenantId, recepcionId);
        return existente ? { estado: "ya_anulada" as const } : { estado: "inexistente" as const };
      });

      if (resultado.estado === "inexistente") {
        res.status(404).json({ error: "Recepción no encontrada" });
        return;
      }
      if (resultado.estado === "ya_anulada") {
        res.status(409).json({ error: "Esta recepción ya estaba anulada" });
        return;
      }

      await registrarAuditoria({
        accion: "combustible.recepcion_anular",
        tenantId,
        usuarioId: req.usuario!.id,
        detalle: { recepcionId, motivo },
        contexto: contextoAuditoriaModulo(req),
      });
      await publicarEventoTenant(tenantId, "combustible.recepcion_anulada", {
        recepcionId,
      });
      res.json({ recepcion: resultado.recepcion, tanque: resultado.tanque });
    } catch {
      res.status(500).json({ error: "Error al anular la recepción" });
    }
  }
}
