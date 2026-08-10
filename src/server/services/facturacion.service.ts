/** src/server/services/facturacion.service.ts
 *
 * Comprobantes que el TENANT descarga desde su propio panel (migración
 * 0041). Hoy solo `comprobante_pago` tiene generación real: es un
 * documento interno, NO un comprobante tributario -- "Factura" y "Boleta"
 * son términos reservados por SUNAT que solo puede emitir quien tiene RUC
 * de empresa registrado para eso, y todavía no lo hay. El Recibo por
 * Honorarios que sustenta el pago ante SUNAT es un trámite aparte, mío,
 * por fuera de este sistema -- no vive acá.
 *
 * Sin RLS (`facturas`/`cobros` están en el ALLOWLIST_SIN_RLS de
 * rls-coverage.test.ts): se filtra por tenant_id a mano en cada query,
 * igual que el resto de las tablas de plataforma.
 */
import PDFDocument from "pdfkit";
import { pool } from "../config/database";
import { AppError } from "../shared/middlewares/error.middleware";

export interface ComprobantePago {
  id: string;
  numero: string | null;
  concepto: string;
  monto: string;
  moneda: string;
  emitidoEn: string | null;
  creadoEn: string;
}

function conceptoDeCobro(tipoCobro: string, descripcion: string | null): string {
  if (descripcion) return descripcion;
  return tipoCobro === "implementacion" ? "Implementación" : "Suscripción de plan";
}

export async function listarComprobantesTenantService(
  tenantId: string
): Promise<ComprobantePago[]> {
  const { rows } = await pool.query<{
    id: string;
    comprobante_numero: string | null;
    comprobante_emitido_en: Date | null;
    cobro_tipo: string;
    descripcion: string | null;
    monto: string;
    moneda: string;
    cobro_creado_en: Date;
  }>(
    `SELECT f.id, f.comprobante_numero, f.comprobante_emitido_en,
            c.tipo AS cobro_tipo, c.descripcion, c.monto, c.moneda, c.creado_en AS cobro_creado_en
     FROM facturas f
     JOIN cobros c ON c.id = f.cobro_id
     -- Se lista toda fila de facturas del tenant, tenga o no
     -- comprobante_tipo asignado todavía (se asigna recién al descargar por primera vez,
     -- ver generarComprobantePagoPdfService) -- hoy el único tipo posible
     -- es 'comprobante_pago', así que no hace falta filtrar por tipo acá.
     WHERE f.tenant_id = $1
     ORDER BY c.creado_en DESC`,
    [tenantId]
  );

  return rows.map((fila) => ({
    id: fila.id,
    numero: fila.comprobante_numero,
    concepto: conceptoDeCobro(fila.cobro_tipo, fila.descripcion),
    monto: fila.monto,
    moneda: fila.moneda,
    emitidoEn: fila.comprobante_emitido_en?.toISOString() ?? null,
    creadoEn: fila.cobro_creado_en.toISOString(),
  }));
}

interface DatosPdfComprobante {
  tenantNombre: string;
  numero: string;
  concepto: string;
  monto: string;
  moneda: string;
  fecha: Date;
}

function construirPdfComprobante(datos: DatosPdfComprobante): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text("Comprobante de pago", { align: "center" });
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("#666")
      .text("Documento interno de MinCoreERP. No es un comprobante tributario (factura/boleta).", {
        align: "center",
      });
    doc.moveDown(2);

    doc.fillColor("#000").fontSize(11);
    doc.text(`Número: ${datos.numero}`);
    doc.text(`Cliente: ${datos.tenantNombre}`);
    doc.text(`Fecha: ${datos.fecha.toLocaleDateString("es-PE")}`);
    doc.text(`Concepto: ${datos.concepto}`);
    doc.text(`Monto: ${datos.monto} ${datos.moneda}`);

    doc.end();
  });
}

/** Asigna número y fecha de emisión la primera vez que se pide este
 *  comprobante (lazy) -- en las siguientes descargas reusa el mismo
 *  número, no genera uno nuevo cada vez. */
export async function generarComprobantePagoPdfService(
  tenantId: string,
  facturaId: string
): Promise<Buffer> {
  const { rows } = await pool.query<{
    id: string;
    comprobante_numero: string | null;
    comprobante_tipo: string | null;
    cobro_tipo: string;
    descripcion: string | null;
    monto: string;
    moneda: string;
    cobro_creado_en: Date;
    tenant_nombre: string;
  }>(
    `SELECT f.id, f.comprobante_numero, f.comprobante_tipo,
            c.tipo AS cobro_tipo, c.descripcion, c.monto, c.moneda, c.creado_en AS cobro_creado_en,
            t.nombre AS tenant_nombre
     FROM facturas f
     JOIN cobros c ON c.id = f.cobro_id
     JOIN tenants t ON t.id = f.tenant_id
     WHERE f.id = $1 AND f.tenant_id = $2`,
    [facturaId, tenantId]
  );

  const fila = rows[0];
  if (!fila) throw new AppError(404, "Comprobante no encontrado");
  if (fila.comprobante_tipo && fila.comprobante_tipo !== "comprobante_pago") {
    throw new AppError(409, "Este tipo de comprobante todavía no está disponible para descarga");
  }

  const numero =
    fila.comprobante_numero ??
    `CP-${fila.cobro_creado_en.getFullYear()}-${fila.id.slice(0, 8).toUpperCase()}`;
  if (!fila.comprobante_numero) {
    await pool.query(
      `UPDATE facturas
       SET comprobante_tipo = 'comprobante_pago', comprobante_numero = $1, comprobante_emitido_en = now()
       WHERE id = $2`,
      [numero, fila.id]
    );
  }

  return construirPdfComprobante({
    tenantNombre: fila.tenant_nombre,
    numero,
    concepto: conceptoDeCobro(fila.cobro_tipo, fila.descripcion),
    monto: fila.monto,
    moneda: fila.moneda,
    fecha: fila.cobro_creado_en,
  });
}
