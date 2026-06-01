/**src/modules/repuestos/repuestos.service.ts */

import { RepuestosRepository } from "./repuestos.repository";

export const RepuestosService = {

  // 📥 traer todo
  getAll() {
    return RepuestosRepository.findAll();
  },

  // ➕ crear
  create(data: any) {
    return RepuestosRepository.create(data);
  },

  // ✏️ actualizar (NUEVO)
  update(id: number, data: any) {
    return RepuestosRepository.update(id, data);
  },

  // 🗑 eliminar
  delete(id: number) {
    return RepuestosRepository.delete(id);
  },

  // 📦 bulk
  createBulk(rows: any[]) {
    return RepuestosRepository.createBulk(rows);
  },

  // 📊 KPIs
  getKPIs() {
    return RepuestosRepository.getDashboardKPIs();
  }
};