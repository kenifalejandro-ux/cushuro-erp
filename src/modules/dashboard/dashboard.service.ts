/** src/modules/dashboard/dashboard.service.ts */
import type { PoolClient } from "pg";
import { DashboardRepository } from "./dashboard.repository";

export const DashboardService = {
  /**
   * Ejecuta todas las consultas y retorna un objeto único con el formato
   * que el Dashboard.tsx espera. Comparten un mismo client (ver
   * withTenant en database.ts) para que RLS vea el mismo tenant en las 5 —
   * por eso corren en secuencia y no con Promise.all: un PoolClient de
   * node-postgres no soporta queries concurrentes sobre la misma conexión.
   */
  async getFullDashboardData(client: PoolClient, tenantId: string) {
    const kpis = await DashboardRepository.getKPIs(client, tenantId);
    const inventario = await DashboardRepository.repuestosPorCategoria(client, tenantId);
    const valor = await DashboardRepository.valorPorCategoria(client, tenantId);
    const documentos = await DashboardRepository.estadoDocumentos(client, tenantId);
    const stockdata = await DashboardRepository.nivelstock(client, tenantId);

    return {
      ...kpis,
      inventario_categoria: inventario,
      valor_categoria: valor,
      documentos_estado: documentos,
      stock_vs_minimo: stockdata,
    };
  },

  getKPIs(client: PoolClient, tenantId: string) {
    return DashboardRepository.getKPIs(client, tenantId);
  },

  repuestosPorCategoria(client: PoolClient, tenantId: string) {
    return DashboardRepository.repuestosPorCategoria(client, tenantId);
  },

  valorPorCategoria(client: PoolClient, tenantId: string) {
    return DashboardRepository.valorPorCategoria(client, tenantId);
  },

  estadoDocumentos(client: PoolClient, tenantId: string) {
    return DashboardRepository.estadoDocumentos(client, tenantId);
  },

  nivelstock(client: PoolClient, tenantId: string) {
    return DashboardRepository.nivelstock(client, tenantId);
  },
};
