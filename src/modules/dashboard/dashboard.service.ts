/** src/modules/dashboard/dashboard.service.ts */
import { DashboardRepository } from "./dashboard.repository";

export const DashboardService = {
  /**
   * Ejecuta todas las consultas en paralelo y retorna un objeto único 
   * con el formato que el Dashboard.tsx espera.
   */
  async getFullDashboardData() {
    // Promise.all permite que las 4 consultas corran al mismo tiempo
    const [kpis, inventario, valor, documentos, stockdata] = await Promise.all([
      DashboardRepository.getKPIs(),
      DashboardRepository.repuestosPorCategoria(),
      DashboardRepository.valorPorCategoria(),
      DashboardRepository.estadoDocumentos(),
      DashboardRepository.nivelstock(),
    ]);

return {
      ...kpis,
      inventario_categoria: inventario,
      valor_categoria: valor,
      documentos_estado: documentos,
      stock_vs_minimo: stockdata, 
    };
  }, // <--- ESTA COMA ES VITAL

  getKPIs() {
    return DashboardRepository.getKPIs();
  },

  repuestosPorCategoria() {
    return DashboardRepository.repuestosPorCategoria();
  },

  valorPorCategoria() {
    return DashboardRepository.valorPorCategoria();
  },

  estadoDocumentos() {
    return DashboardRepository.estadoDocumentos();
  },

  // No olvides agregar la función individual también
  nivelstock() {
    return DashboardRepository.nivelstock();
  }
};
