/** tests/advisory-lock.test.ts
 *
 * runSiPrimero() (src/server/shared/utils/advisoryLock.ts) coordina los
 * workers periódicos entre instancias — ver el comentario del archivo
 * sobre por qué es pg_try_advisory_XACT_lock (transaccional, compatible
 * con PgBouncer en modo transacción) y no un lock de sesión.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, closeDatabase } from "../src/server/config/database";
import { runSiPrimero } from "../src/server/shared/utils/advisoryLock";

afterAll(async () => {
  await closeDatabase();
});

const LOCK_ID_TEST = 999001;

/** Intenta tomar el lock en su propia transacción efímera, para verificar
 *  si quedó libre después de una corrida de runSiPrimero() — un lock
 *  transaccional no se puede "consultar" sin, de hecho, tomarlo. */
async function estaLibre(lockId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ tomado: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS tomado",
      [lockId]
    );
    await client.query("ROLLBACK"); // libera lo que haya tomado, sin dejar rastro
    return rows[0].tomado;
  } finally {
    client.release();
  }
}

describe("runSiPrimero", () => {
  it("corre la función y libera el lock al terminar (queda libre para otra sesión)", async () => {
    const resultado = await runSiPrimero(LOCK_ID_TEST, async () => "hecho");
    expect(resultado).toBe("hecho");
    expect(await estaLibre(LOCK_ID_TEST)).toBe(true);
  });

  it("no corre la función si otra sesión ya tiene el lock, y lo deja intacto", async () => {
    const otraSesion = await pool.connect();
    try {
      await otraSesion.query("BEGIN");
      // Versión bloqueante: a diferencia del try, ésta espera hasta
      // tomarlo — como nadie más lo tiene todavía, es inmediata.
      await otraSesion.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID_TEST]);

      let corrio = false;
      const resultado = await runSiPrimero(LOCK_ID_TEST, async (_client) => {
        corrio = true;
        return "no debería llegar acá";
      });

      expect(corrio).toBe(false);
      expect(resultado).toBeUndefined();

      // otraSesion todavía no hizo COMMIT/ROLLBACK, así que sigue teniendo
      // el lock — verificarlo desde OTRA conexión tiene que dar false.
      expect(await estaLibre(LOCK_ID_TEST)).toBe(false);
    } finally {
      await otraSesion.query("ROLLBACK");
      otraSesion.release();
    }
  });

  it("libera el lock aunque la función tire un error (ROLLBACK, no queda colgado)", async () => {
    await expect(
      runSiPrimero(LOCK_ID_TEST, async () => {
        throw new Error("falla adentro");
      })
    ).rejects.toThrow("falla adentro");

    expect(await estaLibre(LOCK_ID_TEST)).toBe(true);
  });

  it("fn corre sobre el mismo client que sostiene el lock, dentro de la transacción", async () => {
    const resultado = await runSiPrimero(LOCK_ID_TEST, async (client) => {
      const { rows } = await client.query("SELECT 1 AS uno");
      return rows[0].uno;
    });
    expect(resultado).toBe(1);
  });
});
