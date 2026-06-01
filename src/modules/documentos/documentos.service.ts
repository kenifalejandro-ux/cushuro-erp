/** src/modules/documentos/documentos.service.ts */

import { DocumentosRepository } from "./documentos.repository";

export const DocumentosService = {

  getAll() {
    return DocumentosRepository.findAll();
  },

  create(data: any) {
    return DocumentosRepository.create(data);
  },

  update(id: number, data: any) {
    return DocumentosRepository.update(id, data);
  },

  delete(id: number) {
    return DocumentosRepository.delete(id);
  },

  bulkCreate(data: any[]) {
    return DocumentosRepository.bulkCreate(data);
  },

  getKPIs() {
    return DocumentosRepository.getKPIs();
  }

};