/**src/modules/combutible/combustible.service.ts */

import type { PoolClient } from "pg";
import { CombustibleRepository } from "./combustible.repository";

export class CombustibleService {
  private repository = new CombustibleRepository();

  async getAll(client: PoolClient, tenantId: string) {
    return this.repository.findAll(client, tenantId);
  }

  async getById(client: PoolClient, tenantId: string, id: number) {
    return this.repository.findById(client, tenantId, id);
  }

  async updateNivel(client: PoolClient, tenantId: string, id: number, nivel_actual: number) {
    return this.repository.updateNivel(client, tenantId, id, nivel_actual);
  }
}
