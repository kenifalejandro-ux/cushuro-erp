/** scripts/permisosListar.ts
 *
 * Genera docs/architecture/matriz-permisos.md recorriendo los *.routes.ts
 * de src/modules/registry.ts y extrayendo el requireRole(...) de cada ruta
 * -- hoy la única forma de saber "quién puede hacer qué" es abrir los 7
 * archivos uno por uno (ver el ADR-0002: la granularidad más fina que un
 * módulo completo es el rol por ruta, deliberadamente NO centralizado en el
 * registry). Este script no cambia eso -- es una vista de solo lectura
 * sobre el código real, no una segunda fuente de verdad. requireRole()
 * sigue siendo el único lugar donde el permiso se aplica de verdad.
 *
 * Parser: regex + escaneo balanceado de paréntesis (no un AST completo) --
 * alcanza porque el patrón es siempre el mismo (router.<método>("<ruta>",
 * [middlewares...], handler)) en los 7 archivos reales; un parser más
 * pesado no agregaría nada acá.
 *
 * Uso:
 *   npm run permisos:listar
 */
import fs from "fs";
import path from "path";
import { MODULOS } from "../src/modules/registry";

interface RutaPermiso {
  metodo: string;
  ruta: string;
  roles: string[] | null; // null = sin requireRole -- cualquier rol autenticado
}

const METODOS = ["get", "post", "put", "patch", "delete"] as const;

/** Extrae, para cada `router.<método>(`, el texto completo de sus
 *  argumentos hasta el paréntesis de cierre que le corresponde -- un regex
 *  de una sola línea no alcanza porque los argumentos reales están
 *  repartidos en varias líneas (requireRole, validate, asyncHandler). */
function extraerLlamadasRouter(contenido: string): { metodo: string; args: string }[] {
  const resultado: { metodo: string; args: string }[] = [];
  const regexInicio = new RegExp(`router\\.(${METODOS.join("|")})\\(`, "g");
  let match: RegExpExecArray | null;

  while ((match = regexInicio.exec(contenido))) {
    const metodo = match[1];
    let profundidad = 1;
    let i = match.index + match[0].length;
    for (; i < contenido.length && profundidad > 0; i++) {
      if (contenido[i] === "(") profundidad++;
      else if (contenido[i] === ")") profundidad--;
    }
    resultado.push({ metodo, args: contenido.slice(match.index + match[0].length, i - 1) });
  }
  return resultado;
}

function extraerRuta(args: string): string | null {
  const m = args.match(/^\s*["'`]([^"'`]*)["'`]/);
  return m ? m[1] : null;
}

function extraerRoles(args: string): string[] | null {
  const m = args.match(/requireRole\(([^)]*)\)/);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter(Boolean);
}

function permisosDeModulo(moduloId: string): RutaPermiso[] {
  const archivo = path.resolve(
    import.meta.dirname,
    "..",
    "src",
    "modules",
    moduloId,
    `${moduloId}.routes.ts`
  );
  const contenido = fs.readFileSync(archivo, "utf-8");

  return extraerLlamadasRouter(contenido)
    .map(({ metodo, args }) => {
      const ruta = extraerRuta(args);
      if (ruta === null) return null;
      return { metodo: metodo.toUpperCase(), ruta, roles: extraerRoles(args) };
    })
    .filter((r): r is RutaPermiso => r !== null);
}

function armarMarkdown(): string {
  const fecha = new Date().toISOString().slice(0, 10);
  const lineas: string[] = [
    "# Matriz de permisos por módulo",
    "",
    `Generada automáticamente el ${fecha} por \`npm run permisos:listar\` ` +
      "(`scripts/permisosListar.ts`) — **no editar a mano**, se sobreescribe en " +
      "cada corrida. Recorre los `*.routes.ts` reales y extrae `requireRole(...)`; " +
      "no es una segunda fuente de verdad, es una vista legible sobre el código " +
      "que ya aplica el permiso (ver docs/adr/0002-contrato-de-modulo.md sobre por " +
      "qué el rol vive por ruta y no centralizado en el registry).",
    "",
    "Todas las rutas bajo `/api/erp/*` ya pasan, antes de llegar a esto, por " +
      "`authMiddleware` (JWT válido) + `tenantMiddleware` + `requireModulo(id)` " +
      "(el módulo tiene que estar habilitado para ese tenant/usuario) + " +
      "`requireCuota(id)` en los `POST` que crean recursos con cuota (ver " +
      "`src/modules/registry.ts`). La columna **Roles** de abajo es la capa " +
      'ADICIONAL de `requireRole()` por ruta — **"cualquiera"** significa ' +
      "cualquier rol autenticado (`admin`, `operador` o `lectura`), no ausencia " +
      "de autenticación.",
    "",
  ];

  for (const modulo of MODULOS) {
    const permisos = permisosDeModulo(modulo.id);
    lineas.push(
      `## ${modulo.label} (\`${modulo.id}\`)`,
      "",
      "| Método | Ruta | Roles |",
      "|---|---|---|"
    );
    for (const { metodo, ruta, roles } of permisos) {
      const rutaCompleta = `/api/erp/${modulo.id}${ruta === "/" ? "" : ruta}`;
      lineas.push(`| ${metodo} | ${rutaCompleta} | ${roles ? roles.join(", ") : "cualquiera"} |`);
    }
    lineas.push("");
  }

  lineas.push("## Cómo regenerar", "", "```bash", "npm run permisos:listar", "```", "");

  return lineas.join("\n");
}

function main(): void {
  const destino = path.resolve(
    import.meta.dirname,
    "..",
    "docs",
    "architecture",
    "matriz-permisos.md"
  );
  fs.writeFileSync(destino, armarMarkdown());
  console.log(`Matriz de permisos generada en ${path.relative(process.cwd(), destino)}`);
}

main();
// Solo lee archivos del repo, no toca la BD -- pero importar registry.ts
// importa transitivamente database.ts/redis.ts, que dejan el proceso vivo
// esperando conexiones que este script nunca usa. Salida explícita, mismo
// criterio que el resto de scripts/ (ver restoreDrill.ts).
process.exit(0);
