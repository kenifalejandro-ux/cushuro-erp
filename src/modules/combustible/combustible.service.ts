/**src/modules/combutible/combustible.service.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";
import type {
  RegistrarLecturaCombustibleInput,
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
} from "../../server/schemas/combustible.schema";
import { idempotentInsert } from "../../server/shared/utils/idempotentInsert";
import { CombustibleRepository } from "./combustible.repository";

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
}
