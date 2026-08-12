/** tests/helpers-esperar.test.ts
 *
 * esperarHasta() es el reemplazo de los `setTimeout` fijos con los que
 * tenant-health.test.ts y observability.test.ts esperaban una escritura
 * asíncrona (ver el comentario en helpers.ts). O sea: de acá en adelante,
 * varios tests dependen de que este helper funcione.
 *
 * Un helper de espera roto es peor que el sleep que reemplaza — si
 * devolviera antes de tiempo, los tests que lo usan pasarían "por
 * casualidad" y volveríamos a tener un flaky, pero ahora escondido detrás
 * de algo que parece robusto. De ahí que tenga test propio.
 */
import { describe, it, expect } from "vitest";
import { esperarHasta } from "./helpers";

describe("esperarHasta", () => {
  it("devuelve sin esperar si la condición ya se cumple", async () => {
    let llamadas = 0;
    const valor = await esperarHasta(
      async () => {
        llamadas++;
        return 42;
      },
      (v) => v === 42,
      "un valor que ya está listo"
    );

    expect(valor).toBe(42);
    // Exactamente una: si consultara de más, en los tests reales estaría
    // pegándole a la base sin necesidad en el camino feliz, que es el 99%.
    expect(llamadas).toBe(1);
  });

  it("reintenta hasta que la condición se cumple y devuelve el último valor", async () => {
    let llamadas = 0;
    const valor = await esperarHasta(
      async () => ++llamadas,
      (v) => v >= 3,
      "un valor que tarda unos intentos",
      { intervaloMs: 1 }
    );

    expect(valor).toBe(3);
    expect(llamadas).toBe(3);
  });

  it("tira al agotar el timeout, diciendo QUÉ esperaba y QUÉ vio", async () => {
    // Lo que se verifica acá no es solo que tire: es que el mensaje sirva.
    // El flaky original ("expected 0 to be greater than 0") costó
    // diagnosticar justamente porque no decía ni qué se esperaba ni cuál
    // era el último valor real.
    await expect(
      esperarHasta(
        async () => ({ total: 0 }),
        (v) => v.total > 0,
        "que el contador suba",
        { timeoutMs: 30, intervaloMs: 5 }
      )
    ).rejects.toThrow(/que el contador suba.*\{"total":0\}/s);
  });

  it("no se cuelga para siempre si la condición nunca se cumple", async () => {
    const inicio = Date.now();
    await expect(
      esperarHasta(
        async () => false,
        (v) => v === true,
        "algo imposible",
        {
          timeoutMs: 50,
          intervaloMs: 5,
        }
      )
    ).rejects.toThrow(/Timeout de 50ms/);

    // Con margen amplio: lo que importa es que respete el timeout, no la
    // precisión del reloj en una máquina cargada.
    expect(Date.now() - inicio).toBeLessThan(3000);
  });
});
