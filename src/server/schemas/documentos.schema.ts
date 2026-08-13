import { z } from "zod";

export const crearDocumentoSchema = z.object({
  // Lo genera el dispositivo con crypto.randomUUID() al guardar, online u
  // offline (ver client/src/offline/). Opcional a propósito: sin él, la
  // creación se comporta igual que siempre. Con él, un reintento del mismo
  // envío no duplica (ver idempotentInsert.ts).
  cliente_uuid: z.string().uuid().optional(),
  nombre_documento: z.string().trim().min(1).max(200),
  responsable: z.string().trim().max(150).optional(),
  fecha_vencimiento: z.string().min(1),
});

export type CrearDocumentoInput = z.infer<typeof crearDocumentoSchema>;

// PUT reemplaza la fila entera, así que los campos obligatorios lo son
// igual que al crear -- omitir `nombre_documento` en un PUT no significa
// "dejalo como está", significa "ponelo en NULL" (ver el UPDATE en
// documentos.repository.ts, que setea las cuatro columnas siempre).
//
// `estado` existe solo acá y no en el schema de creación: se llena al
// editar (el POST no lo recibe). Ojo que NO es `estado_alerta`, que es
// calculado en el SELECT (VENCIDO/POR VENCER/VIGENTE) y nunca se escribe.
//
// Sin `.strict()` a propósito: el formulario de edición del cliente hace
// `setForm(doc)` con la fila entera, así que el PUT llega con `id`,
// `estado_alerta` y `total_count` de yapa. Zod los descarta en silencio,
// que es lo que queremos -- con `.strict()` habría que ensuciar el
// frontend para que limpie el objeto antes de mandarlo.
export const actualizarDocumentoSchema = z.object({
  nombre_documento: z.string().trim().min(1).max(200),
  responsable: z.string().trim().max(150).optional(),
  fecha_vencimiento: z.string().min(1),
  estado: z.string().trim().max(50).optional(),
});

export type ActualizarDocumentoInput = z.infer<typeof actualizarDocumentoSchema>;

/** Tope de filas por importación. No es un número mágico: acota el trabajo
 *  que un solo request puede imponerle a la base (y con ella, al resto de
 *  los tenants que comparten el pool de conexiones). Un Excel real de
 *  documentos legales tiene decenas o cientos de filas, no miles; quien
 *  necesite más parte el archivo, que es preferible a que una importación
 *  monopolice una conexión.
 *
 *  Va de la mano de BULK_BODY_LIMIT (ver server/config/env.ts): este topa
 *  la CANTIDAD de filas y aquel el TAMAÑO del cuerpo. Hacen falta los dos,
 *  porque 5.000 filas cortas y 50 filas con campos larguísimos son
 *  problemas distintos. */
export const MAX_FILAS_CARGA_MASIVA = 5000;

// El body de /bulk es un ARRAY crudo (no un objeto que lo envuelva) --
// así lo mandan el cliente y el middleware de cuota, que cuenta
// `req.body.length` para saber cuántas filas se van a crear.
export const cargaMasivaDocumentosSchema = z
  .array(
    z.object({
      nombre_documento: z.string().trim().min(1).max(200),
      responsable: z.string().trim().max(150).optional(),
      fecha_vencimiento: z.string().min(1),
    })
  )
  .min(1, "La importación no puede estar vacía")
  .max(
    MAX_FILAS_CARGA_MASIVA,
    `No se pueden importar más de ${MAX_FILAS_CARGA_MASIVA} filas de una vez`
  );

export type CargaMasivaDocumentosInput = z.infer<typeof cargaMasivaDocumentosSchema>;

// Multer ya dejó el archivo en req.file y este campo de texto en req.body
// cuando este schema corre (ver documentos.routes.ts: subirArchivoDocumento
// va ANTES que validate() en la cadena de middlewares).
export const subirVersionDocumentoSchema = z.object({
  cliente_uuid: z.string().uuid().optional(),
});

export type SubirVersionDocumentoInput = z.infer<typeof subirVersionDocumentoSchema>;
