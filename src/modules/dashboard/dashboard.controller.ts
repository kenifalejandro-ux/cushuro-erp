/** src/modules/dashboard/dashboard.controller.ts */

import { Request, Response } from "express";
import { DashboardService } from "./dashboard.service";

export const DashboardController = {
  
 async getFullDashboard(req: Request, res: Response) {
    try {
      const data = await DashboardService.getFullDashboardData();
      res.json(data);
    } catch (error) {
      console.error("Error en getFullDashboard:", error);
      res.status(500).json({ error: "Error al cargar los datos integrados del dashboard" });
    }
  },
  // ============================================================
  // 📊 KPIs PRINCIPALES
  // ============================================================
  async getKPIs(req: Request, res: Response) {
    try {
      const data = await DashboardService.getKPIs();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error KPIs dashboard" });
    }
  },

  // ============================================================
  // 📊 CHART 1 - REPUESTOS POR CATEGORÍA
  // ============================================================
  async repuestosPorCategoria(req: Request, res: Response) {
    try {
      const data = await DashboardService.repuestosPorCategoria();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error chart repuestos" });
    }
  },

  // ============================================================
  // 📊 CHART 2 - VALOR INVENTARIO
  // ============================================================
  async valorPorCategoria(req: Request, res: Response) {
    try {
      const data = await DashboardService.valorPorCategoria();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error chart valor" });
    }
  },

  // ============================================================
  // 📊 CHART 3 - DOCUMENTOS
  // ============================================================
  async estadoDocumentos(req: Request, res: Response) {
    try {
      const data = await DashboardService.estadoDocumentos();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error chart documentos" });
    }
  },

    // ============================================================
  // 📊 CHART 4 - NIVEL DE STOCK VS MINIMO
  // ============================================================
  async nivelstock(req: Request, res: Response) {
    try {
      const data = await DashboardService.nivelstock();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Error chart nivelstock" });
    }
  }

};