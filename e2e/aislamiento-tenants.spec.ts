/** e2e/aislamiento-tenants.spec.ts
 *
 * El test de seguridad más importante de un ERP multi-tenant: que un usuario
 * autenticado de un tenant no pueda ver ni tocar datos de otro. Corre contra
 * el sistema completo (Express + build real de React + Postgres con RLS), sin
 * mocks, porque justamente lo que se quiere probar es la cadena entera —
 * cookie de sesión → tenantMiddleware → withTenant() → policy de Postgres.
 * Cualquier eslabón mockeado invalidaría la prueba.
 *
 * Necesita DOS tenants sembrados (ver el job e2e-tests de ci.yml): el tenant
 * A es el del build (VITE_DEFAULT_TENANT_SLUG) y entra por la UI real; el
 * tenant B solo existe para tener datos ajenos que intentar alcanzar, así que
 * se maneja por API.
 *
 * El escenario en sí (crear una fila con B, atacarla desde A, verificar tanto
 * lo que A ve como lo que pasó de verdad en la base) vive en
 * fixtures/aislamiento.ts, parametrizado por módulo — se corre una vez por
 * cada módulo con tablas propias que ya tiene una ruta REST completa.
 * Por qué el ataque es realista y no un escenario de laboratorio: el `id` de
 * cada fila es un `serial` (ver el registry de módulos), o sea un entero
 * secuencial y adivinable. Un usuario del tenant A no necesita filtrar nada
 * para conocer un id del tenant B: le basta probar 1, 2, 3. "No lo puede
 * adivinar" no es una defensa acá — la única defensa es que la fila esté
 * fuera de su alcance, que es exactamente lo que este spec verifica.
 */
import { test } from "@playwright/test";
import { probarAislamientoDeModulo, type ConfigAislamientoModulo } from "./fixtures/aislamiento";

function leerEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(
      `Falta ${nombre} -- este spec necesita DOS tenants sembrados con 'npm run tenant:create' antes de levantar el server (ver el job e2e-tests de ci.yml)`
    );
  }
  return valor;
}

// Tenant A: el del build. Entra por la UI porque es el único cuyo slug quedó
// horneado en el bundle — y de paso, la sesión que ataca es una cookie real
// puesta por el navegador, no una fabricada por el test.
const tenantA = {
  email: leerEnv("E2E_ADMIN_EMAIL"),
  password: leerEnv("E2E_ADMIN_PASSWORD"),
};

// Tenant B: la víctima. Nunca se loguea en el navegador.
const tenantB = {
  slug: leerEnv("E2E_TENANT_B_SLUG"),
  email: leerEnv("E2E_ADMIN_B_EMAIL"),
  password: leerEnv("E2E_ADMIN_B_PASSWORD"),
};

const MODULOS: ConfigAislamientoModulo[] = [
  {
    modulo: "repuestos",
    campoMarca: "codigo",
    armarPayload: async (_requestB, marca) => ({
      codigo: marca,
      nombre: "Filtro secreto del tenant B",
      categoria: "General",
      stock: 42,
      stock_minimo: 5,
      stock_maximo: 100,
      precio: 1234.56,
    }),
    payloadModificacion: {
      codigo: "PWNED-000",
      nombre: "PWNED",
      categoria: "General",
      stock: 0,
      stock_minimo: 5,
      stock_maximo: 100,
      precio: 0,
    },
  },
  {
    modulo: "equipos",
    campoMarca: "placa_codigo",
    armarPayload: async (_requestB, marca) => ({
      placa_codigo: marca,
      tipo: "Camión minero",
      marca: "Volvo",
      modelo: "FH16",
    }),
    payloadModificacion: {
      placa_codigo: "PWNED-000",
      tipo: "Hackeado",
    },
  },
  {
    // Sin payloadModificacion a propósito: checklists no tiene PUT (ver
    // checklists.routes.ts) -- solo crear, listar y borrar.
    modulo: "checklists",
    campoMarca: "observaciones_generales",
    armarPayload: async (requestB, marca) => {
      // Checklists necesita un equipo y una plantilla propios de B antes de
      // poder crear el checklist en sí (FK equipo_id/plantilla_id) -- a
      // diferencia de repuestos/equipos, no alcanza con un solo POST.
      const equipo = await requestB.post("/api/erp/equipos", {
        data: { placa_codigo: `EQ-${marca}`, tipo: "Camión minero" },
      });
      const equipoId = (await equipo.json()).id;

      const plantilla = await requestB.post("/api/erp/checklists/plantillas", {
        data: { nombre: `Plantilla ${marca}`, items: [{ descripcion: "Frenos" }] },
      });
      const plantillaId = (await plantilla.json()).id;

      return {
        equipo_id: equipoId,
        plantilla_id: plantillaId,
        observaciones_generales: marca,
        items: [{ descripcion: "Frenos", estado: "bien" }],
      };
    },
  },
];

for (const config of MODULOS) {
  test(`un usuario de un tenant no puede leer ni modificar datos de otro tenant (${config.modulo})`, async ({
    page,
    request,
  }) => {
    await probarAislamientoDeModulo({ page, request }, tenantA, tenantB, config);
  });
}
