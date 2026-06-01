/**src/modules/combutible/combustible.service.ts */

import { CombustibleRepository } from "./combustible.repository";

export class CombustibleService {
  private repository = new CombustibleRepository();

  async getAll() {
    return this.repository.findAll();
  }

  async getById(id: number) {
    return this.repository.findById(id);
  }

  async updateNivel(id: number, nivel_actual: number) {
    return this.repository.updateNivel(id, nivel_actual);
  }
}