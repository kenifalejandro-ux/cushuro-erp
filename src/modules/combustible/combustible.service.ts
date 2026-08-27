/**src/modules/combutible/combustible.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  RegistrarLecturaCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
  CrearDespachoCombustibleInput,
  CrearPrecioCombustibleInput,
} from "../../server/schemas/combustible.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { CombustibleRepository } from "./combustible.repository";
import { EquiposRepository } from "../equipos/equipos.repository";

export class CombustibleService {
  private repository = new CombustibleRepository();

  async getAll(client: PoolClient, tenantId: string) {
    return this.repository.findAll(client, tenantId);
  }

  async getById(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findById(client, tenantId, id);
  }

  async create(client: PoolClient, tenantId: string, data: CrearTanqueCombustibleInput) {
    return this.repository.create(client, tenantId, data);
  }

  async update(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarTanqueCombustibleInput
  ) {
    return this.repository.update(client, tenantId, id, data);
  }

  async softDelete(client: PoolClient, tenantId: string, id: number) {
    return this.repository.softDelete(client, tenantId, id);
  }

  async createBulk(client: PoolClient, tenantId: string, items: CrearTanqueCombustibleInput[]) {
    return this.repository.createBulk(client, tenantId, items);
  }

  /** Devuelve null si la lectura no existe en este tenant o si ya estaba
   *  anulada -- el controller distingue los dos casos con
   *  `findLecturaPorId` para responder 404 o 409. */
  async anularLectura(
    client: PoolClient,
    tenantId: string,
    lecturaId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularLectura(client, tenantId, lecturaId, usuarioId, motivo);
  }

  async getLecturaPorId(client: PoolClient, tenantId: string, lecturaId: number) {
    return this.repository.findLecturaPorId(client, tenantId, lecturaId);
  }

  async getLecturas(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    paginacion: Paginacion
  ) {
    return this.repository.findLecturas(client, tenantId, combustibleId, paginacion);
  }

  /** Devuelve `creado: false` cuando esta lectura ya se había registrado con
   *  el mismo `cliente_uuid` -- el reintento de un envío cuya respuesta se
   *  perdió. El controller usa ese flag para no publicar el evento de nuevo.
   *  Sin `cliente_uuid` en el body, se comporta igual que antes: siempre
   *  crea (ver PUT /:id/nivel legacy más abajo). */
  registrarLectura(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: RegistrarLecturaCombustibleInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "combustible",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        const fila = await this.repository.registrarLectura(client, tenantId, {
          combustibleId: data.combustible_id,
          nivel: data.nivel,
          leidoEn: data.leido_en ?? new Date().toISOString(),
          usuarioId,
          metadata: data.metadata ?? {},
        });
        return { id: Number(fila.lectura.id), fila };
      },
      recuperar: (filaId) => this.repository.findLecturaConTanque(client, tenantId, filaId),
    });
  }

  /** PUT /:id/nivel de siempre, mantenido como wrapper mientras existan
   *  consumidores -- pero ya NUNCA sobreescribe nivel_actual directo: pasa
   *  por el mismo camino que una lectura nueva (leido_en = now(), sin
   *  cliente_uuid, así que siempre crea). El historial queda completo
   *  también para las lecturas cargadas por esta vía. */
  async actualizarNivelLegacy(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    id: number,
    nivelActual: number
  ) {
    const { tanque } = await this.repository.registrarLectura(client, tenantId, {
      combustibleId: id,
      nivel: nivelActual,
      leidoEn: new Date().toISOString(),
      usuarioId,
      metadata: {},
    });
    return tanque;
  }

  // ── Despachos (Fase B) ───────────────────────────────────────────────

  /** Valida lo que el schema Zod no puede (necesita consultar otras filas)
   *  y crea el despacho envuelto en idempotentInsert -- mismo `modulo:
   *  "combustible"` que registrarLectura(), así un reintento con el mismo
   *  cliente_uuid no duplica sin importar si fue una lectura o un
   *  despacho lo que se reintentó. */
  crearDespacho(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearDespachoCombustibleInput
  ) {
    return idempotentInsert({
      client,
      tenantId,
      modulo: "combustible",
      clienteUuid: data.cliente_uuid,
      insertar: async () => {
        // El duplicado le gana a cualquier otro 400 -- ver el comentario de
        // CombustibleRepository.existeVale. El constraint único de 0062
        // sigue siendo la red de seguridad real contra una carrera entre
        // dos requests simultáneos; esto es solo para dar la señal correcta
        // en el caso común (no concurrente).
        if (await this.repository.existeVale(client, tenantId, data.serie_talonario, data.n_vale)) {
          throw new Error(
            `el vale ${data.n_vale} de la serie ${data.serie_talonario} ya está registrado`
          );
        }

        await this.validarFormaDespacho(client, tenantId, data);

        const fila = await this.repository.crearDespacho(client, tenantId, usuarioId, {
          origen: data.origen,
          combustibleId: data.combustible_id ?? null,
          grifoId: data.grifo_id ?? null,
          tipoCombustible: data.tipo_combustible,
          tipoDestino: data.tipo_destino,
          equipoId: data.equipo_id ?? null,
          serieTalonario: data.serie_talonario,
          nVale: data.n_vale,
          cantidad: data.cantidad,
          lecturaContometro: data.lectura_contometro ?? null,
          lecturaHorometro: data.lectura_horometro ?? null,
          lecturaOdometro: data.lectura_odometro ?? null,
          horasAbastecidas: data.horas_abastecidas ?? null,
          costoUnitario: data.costo_unitario,
          observaciones: data.observaciones ?? null,
          despachadoEn: data.despachado_en ?? new Date().toISOString(),
        });
        return { id: Number(fila.id), fila };
      },
      recuperar: (filaId) => this.repository.findDespachoPorId(client, tenantId, filaId),
    });
  }

  /** Reglas que dependen de OTRA fila, así que Zod (que solo ve el body)
   *  no las puede validar:
   *
   *  - tanque_propio: el contómetro tiene que coincidir con la cantidad
   *    declarada (punto 5, control de calidad de dato -- el aparato
   *    resetea a 0,0 en cada despacho, así que no depende de ningún otro
   *    vale, solo de ESTE). No es anti-fraude: agarra el tipeo, no a
   *    alguien que declara a propósito un número falso -- eso lo detecta
   *    el hueco de talonario (punto 1), no este chequeo.
   *  - compra_externa: el equipo tiene que existir en este tenant, tener
   *    `tipo_medidor` configurado, y el campo que llegó lleno
   *    (horómetro/odómetro) tiene que ser el que corresponde a ESE
   *    equipo -- cruce que ningún CHECK de la migración puede hacer
   *    (0062 solo puede exigir "exactamente uno de los dos", nunca "el
   *    correcto para este equipo", porque eso vive en otra tabla). */
  private async validarFormaDespacho(
    client: PoolClient,
    tenantId: string,
    data: CrearDespachoCombustibleInput
  ) {
    if (data.origen === "tanque_propio") {
      if (Number(data.lectura_contometro) !== Number(data.cantidad)) {
        throw new Error(
          `el contómetro marcó ${data.lectura_contometro} pero se declararon ${data.cantidad} -- revisá el vale`
        );
      }
      return;
    }

    // compra_externa: el schema ya garantiza equipo_id presente (exige
    // tipo_destino='equipo' en este origen).
    const equipoId = data.equipo_id!;
    const equipo = await EquiposRepository.findTipoMedidor(client, tenantId, equipoId);
    if (!equipo) {
      throw new Error(`equipo_id ${equipoId} no existe en este tenant`);
    }
    if (!equipo.tipo_medidor) {
      throw new Error(
        `el equipo ${equipoId} no tiene tipo de medidor configurado -- asignale horómetro u odómetro en Equipos antes de registrar un despacho de compra externa`
      );
    }
    if (equipo.tipo_medidor === "horometro" && data.lectura_horometro === undefined) {
      throw new Error(`el equipo ${equipoId} se mide por horómetro, no por odómetro`);
    }
    if (equipo.tipo_medidor === "odometro" && data.lectura_odometro === undefined) {
      throw new Error(`el equipo ${equipoId} se mide por odómetro, no por horómetro`);
    }
  }

  listarDespachos(
    client: PoolClient,
    tenantId: string,
    filtros: { equipoId?: number; serieTalonario?: string },
    paginacion: Paginacion
  ) {
    return this.repository.findDespachos(client, tenantId, filtros, paginacion);
  }

  /** Punto 1 reescrito: consulta bajo demanda -- ver el comentario de
   *  CombustibleRepository.findHuecosTalonario. */
  detectarHuecos(client: PoolClient, tenantId: string, serieTalonario: string) {
    return this.repository.findHuecosTalonario(client, tenantId, serieTalonario);
  }

  // ── Grifos externos (migrations/0063) ───────────────────────────────

  listarGrifos(client: PoolClient, tenantId: string) {
    return this.repository.findGrifos(client, tenantId);
  }

  crearGrifo(client: PoolClient, tenantId: string, usuarioId: string, nombre: string) {
    return this.repository.crearGrifo(client, tenantId, usuarioId, nombre);
  }

  actualizarGrifo(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: { nombre: string; activo: boolean }
  ) {
    return this.repository.actualizarGrifo(client, tenantId, id, data);
  }

  // ── Precios de combustible (migrations/0063) ─────────────────────────

  listarPrecios(client: PoolClient, tenantId: string) {
    return this.repository.findPrecios(client, tenantId);
  }

  crearPrecio(
    client: PoolClient,
    tenantId: string,
    usuarioId: string,
    data: CrearPrecioCombustibleInput
  ) {
    return this.repository.crearPrecio(client, tenantId, usuarioId, {
      tipoCombustible: data.tipo_combustible,
      combustibleId: data.combustible_id ?? null,
      grifoId: data.grifo_id ?? null,
      precioUnitario: data.precio_unitario,
      vigenteDesde: data.vigente_desde ?? new Date().toISOString(),
    });
  }

  /** Precio vigente a una fecha, para un tanque O un grifo (nunca los
   *  dos) -- el frontend lo consulta para autocompletar el C.U del
   *  despacho antes de mostrar el formulario; ver el comentario en
   *  CombustibleRepository.findPrecioVigente sobre por qué ignora los
   *  anulados. */
  obtenerPrecioVigente(
    client: PoolClient,
    tenantId: string,
    tipoCombustible: string,
    destino: { combustibleId: number | null; grifoId: number | null },
    fecha: string
  ) {
    return this.repository.findPrecioVigente(client, tenantId, tipoCombustible, destino, fecha);
  }

  getPrecioPorId(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findPrecioPorId(client, tenantId, id);
  }

  /** Devuelve null si el precio no existe en este tenant o si ya estaba
   *  anulado -- mismo criterio que anularLectura: el controller distingue
   *  los dos casos con getPrecioPorId para responder 404 o 409. */
  anularPrecio(
    client: PoolClient,
    tenantId: string,
    precioId: number,
    usuarioId: string,
    motivo: string
  ) {
    return this.repository.anularPrecio(client, tenantId, precioId, usuarioId, motivo);
  }
}
