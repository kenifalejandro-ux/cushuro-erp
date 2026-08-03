/** src/modules/types.ts
 *
 * Tipos que respalda el Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md).
 */
import type { Router } from "express";

/** Metadata de una tabla de negocio propia de un módulo, para
 *  backup/restore self-service (ver platformBackup.service.ts). Mismo
 *  shape que ya usaba TABLAS_TENANT antes de este cambio — ahora vive
 *  junto a la definición del módulo en vez de mantenerse a mano en un
 *  archivo aparte que nadie se acuerda de actualizar. */
export interface TablaBackupMeta {
  nombre: string;
  pk: "serial" | "uuid";
  /** Columnas GENERATED ALWAYS AS (...) STORED — Postgres rechaza un
   *  INSERT que las mencione explícitamente al restaurar. */
  columnasExcluidasAlRestaurar?: string[];
  /** FK hacia otra tabla de ESTE MISMO backup (de cualquier módulo, no
   *  solo el propio) — solo hace falta cuando se restaura con remapeo de
   *  ids (clonar a otro tenant): { columnaFK: tablaReferenciada }. */
  fks?: Record<string, string>;
}

export interface ModuloDefinicion {
  /** Debe coincidir con un valor del enum `modulo_erp` (migrations/0008 en
   *  adelante) — ver tests/module-registry.test.ts, que falla si diverge. */
  id: string;
  label: string;
  icono: string;
  /** Puramente informativo hoy (ver tenant_modulos.version, migrations/0021)
   *  — ningún consumidor de modulosPermitidos lo lee todavía. */
  version: string;
  router: Router;
  /** Tablas propias de este módulo, en orden seguro de INSERT (padres
   *  antes que hijos) — así se restaura un backup respetando las FK. Un
   *  módulo sin tablas propias (ej. dashboard, que solo agrega datos de
   *  otros módulos) declara un array vacío. */
  tablas: TablaBackupMeta[];
  /** Subconjunto de `tablas` (mismos nombres) que necesita un DELETE
   *  explícito al vaciar/restaurar un tenant — las que NO están acá se
   *  asume que tienen ON DELETE CASCADE desde alguna de las declaradas
   *  aquí. Mismo orden que `tablas` (padres antes que hijos); el wipe se
   *  ejecuta en el orden inverso automáticamente. */
  raices: string[];
}
