/** src/modules/repuestos/repuestos.repository.ts */

import type { PoolClient } from "pg";
import type { Paginacion } from "../../server/shared/utils/pagination";

// Sin schema de validación (req.body pasa directo desde el controller) --
// documenta la forma asumida por las queries de abajo, no valida en runtime.
export type RepuestoPayload = {
  codigo: string;
  nombre: string;
  categoria?: string;
  stock?: number;
  stock_minimo?: number;
  stock_maximo?: number;
  precio?: number;
};

export const RepuestosRepository = {
  // =========================================================
  // 📥 LISTAR REPUESTOS (del tenant activo, paginado)
  // =========================================================
  async findAll(client: PoolClient, tenantId: string, { pageSize, offset }: Paginacion) {
    const result = await client.query(
      `
      SELECT
        id,
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        fecha_creacion AS fecha,
        COUNT(*) OVER() AS total_count
      FROM repuestos
      WHERE tenant_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `,
      [tenantId, pageSize, offset]
    );

    return result.rows;
  },

  // =========================================================
  // ➕ CREAR REPUESTO
  // =========================================================
  async create(client: PoolClient, tenantId: string, data: RepuestoPayload) {
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;

    const result = await client.query(
      `
      INSERT INTO repuestos (
        tenant_id,
        codigo,
        nombre,
        categoria,
        stock,
        stock_minimo,
        stock_maximo,
        precio,
        fecha_creacion
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,NOW()
      )
      RETURNING *
      `,
      [tenantId, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio]
    );

    return result.rows[0];
  },

  // =========================================================
  // ✏️ ACTUALIZAR REPUESTO (solo si pertenece al tenant activo)
  // =========================================================
  async update(client: PoolClient, tenantId: string, id: number, data: RepuestoPayload) {
    const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;

    const result = await client.query(
      `
      UPDATE repuestos SET
        codigo = $1,
        nombre = $2,
        categoria = $3,
        stock = $4,
        stock_minimo = $5,
        stock_maximo = $6,
        precio = $7
      WHERE id = $8 AND tenant_id = $9
      RETURNING *
      `,
      [codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, id, tenantId]
    );

    return result.rows[0] ?? null;
  },

  // =========================================================
  // 🗑 ELIMINAR REPUESTO (solo si pertenece al tenant activo)
  // =========================================================
  async delete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(`DELETE FROM repuestos WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  // =========================================================
  // 📦 INSERCIÓN MASIVA
  // =========================================================
  async createBulk(client: PoolClient, tenantId: string, rows: RepuestoPayload[]) {
    const results = [];
    for (const data of rows) {
      const { codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio } = data;
      const result = await client.query(
        `INSERT INTO repuestos (tenant_id, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, fecha_creacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (tenant_id, codigo) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           categoria = EXCLUDED.categoria,
           stock = EXCLUDED.stock,
           stock_minimo = EXCLUDED.stock_minimo,
           stock_maximo = EXCLUDED.stock_maximo,
           precio = EXCLUDED.precio
         RETURNING *`,
        [
          tenantId,
          codigo,
          nombre,
          categoria ?? "General",
          stock ?? 0,
          stock_minimo ?? 5,
          stock_maximo ?? 30,
          precio ?? 0,
        ]
      );
      results.push(result.rows[0]);
    }
    return results;
  },

  // =========================================================
  // 📦 REGISTRAR MOVIMIENTO DE STOCK (entrada/salida)
  // =========================================================
  /** Aplica el delta a `stock` con un UPDATE atómico -- sin comparar contra
   *  ningún timestamp: a diferencia de una lectura absoluta (ver
   *  CombustibleRepository.registrarLectura), un delta es conmutativo, así
   *  que da igual en qué orden sincronicen dos movimientos offline (ver
   *  migrations/0046_repuestos_movimientos.sql). SOLO si el UPDATE tiene
   *  éxito se inserta el movimiento en el histórico -- un rechazo no debe
   *  dejar una fila de algo que nunca se aplicó.
   *
   *  Una `salida` lleva la guarda `stock >= cantidad`: se RECHAZA si
   *  dejaría el stock negativo (el `rowCount = 0` resultante distingue
   *  "no había stock" de "no existe", que ya se descartó arriba). Una
   *  `entrada` nunca se rechaza, no lleva guarda.
   *
   *  Lanza si `repuestoId` no existe en este tenant, o si una `salida` no
   *  tiene stock suficiente -- mismo patrón de "throw con mensaje
   *  reconocible" que `CombustibleRepository.registrarLectura` /
   *  `IpercController.crear`; el controller distingue cada mensaje para
   *  responder 400 vs. 409. */
  async registrarMovimiento(
    client: PoolClient,
    tenantId: string,
    data: {
      repuestoId: number;
      tipo: "entrada" | "salida";
      cantidad: number;
      motivo: string | null;
      registradoEn: string;
      usuarioId: string | null;
      metadata: Record<string, unknown>;
    }
  ) {
    const repuestoExiste = await client.query<{ id: number }>(
      `SELECT id FROM repuestos WHERE id = $1 AND tenant_id = $2`,
      [data.repuestoId, tenantId]
    );
    if (repuestoExiste.rows.length === 0) {
      throw new Error(`repuesto_id ${data.repuestoId} no existe en este tenant`);
    }

    const delta = data.tipo === "entrada" ? data.cantidad : -data.cantidad;
    const repuesto = await client.query(
      data.tipo === "salida"
        ? `UPDATE repuestos SET stock = stock + $1
           WHERE id = $2 AND tenant_id = $3 AND stock >= $4
           RETURNING *`
        : `UPDATE repuestos SET stock = stock + $1
           WHERE id = $2 AND tenant_id = $3
           RETURNING *`,
      data.tipo === "salida"
        ? [delta, data.repuestoId, tenantId, data.cantidad]
        : [delta, data.repuestoId, tenantId]
    );

    if (repuesto.rows.length === 0) {
      throw new Error(`stock insuficiente para repuesto_id ${data.repuestoId}`);
    }

    const movimiento = await client.query(
      `
      INSERT INTO repuestos_movimientos
        (tenant_id, repuesto_id, tipo, cantidad, motivo, registrado_en, usuario_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, repuesto_id, tipo, cantidad, motivo, registrado_en, usuario_id, origen, metadata, creado_en
      `,
      [
        tenantId,
        data.repuestoId,
        data.tipo,
        data.cantidad,
        data.motivo,
        data.registradoEn,
        data.usuarioId,
        JSON.stringify(data.metadata),
      ]
    );

    return { movimiento: movimiento.rows[0], repuesto: repuesto.rows[0] };
  },

  /** Para el reintento de un movimiento ya creado (mismo cliente_uuid) --
   *  responde igual que la primera vez, sin volver a tocar `stock`. */
  async findMovimientoConRepuesto(client: PoolClient, tenantId: string, movimientoId: number) {
    const movimiento = await client.query(
      `SELECT id, repuesto_id, tipo, cantidad, motivo, registrado_en, usuario_id, origen, metadata, creado_en
       FROM repuestos_movimientos
       WHERE id = $1 AND tenant_id = $2`,
      [movimientoId, tenantId]
    );
    if (movimiento.rows.length === 0) return null;

    const repuesto = await client.query(
      `SELECT * FROM repuestos WHERE id = $1 AND tenant_id = $2`,
      [movimiento.rows[0].repuesto_id, tenantId]
    );

    return { movimiento: movimiento.rows[0], repuesto: repuesto.rows[0] ?? null };
  },

  // =========================================================
  // 📊 KPIs DASHBOARD
  // =========================================================
  async getDashboardKPIs(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `
    SELECT
      (SELECT COUNT(*) FROM repuestos WHERE tenant_id = $1) AS total_repuestos,

      -- 🔴 Bajo mínimo
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock <= stock_minimo) AS stock_bajo,

      -- 🟣 Sobre máximo
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock >= stock_maximo) AS stock_sobre,

      -- 🟢 En rango saludable
      (SELECT COUNT(*)
       FROM repuestos
       WHERE tenant_id = $1 AND stock > stock_minimo
       AND stock < stock_maximo) AS stock_saludable,

      -- 💰 Valor inventario
      (SELECT COALESCE(ROUND(SUM(stock * precio),2),0)
       FROM repuestos WHERE tenant_id = $1) AS valor_inventario
  `,
      [tenantId]
    );

    return result.rows[0];
  },
};
