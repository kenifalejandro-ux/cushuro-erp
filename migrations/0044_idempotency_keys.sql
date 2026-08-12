-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: claves de idempotencia para escrituras que pueden reintentarse
--
-- Escenario que resuelve (offline-first, ver docs/adr/0003-offline-first.md):
-- un operario llena un checklist en campo, el POST llega al servidor, se
-- commitea bien... y la respuesta se pierde en el camino de vuelta porque la
-- señal se cortó justo ahí. El dispositivo nunca se enteró de que se guardó,
-- así que su cola local sigue viendo ese envío como pendiente y lo reintenta
-- cuando vuelve la señal. Sin esta tabla, ese reintento crea un SEGUNDO
-- checklist para la misma inspección.
--
-- ── Por qué una tabla aparte y no UNIQUE (tenant_id, cliente_uuid) ────────
--
-- El diseño obvio sería una columna `cliente_uuid` en `checklists` con un
-- UNIQUE encima. No se puede: `checklists` e `ipercs` son tablas
-- PARTICIONADAS por RANGE(creado_en) desde la migración 0037, y Postgres
-- exige que todo índice único sobre una tabla particionada incluya la
-- columna de partición. `UNIQUE (tenant_id, cliente_uuid)` a secas ni
-- siquiera se puede crear.
--
-- Y la variante que sí compila —`UNIQUE (tenant_id, cliente_uuid,
-- creado_en)`— es PEOR que no tener nada: `creado_en` es DEFAULT now(), así
-- que el reintento (que llega minutos u horas después) trae un `creado_en`
-- distinto, no colisiona con nada, y el ON CONFLICT nunca dispara. El
-- duplicado se crea igual, pero ahora con un constraint que da la falsa
-- impresión de estar protegiendo algo.
--
-- Una tabla aparte, sin particionar, deja la clave de idempotencia
-- desacoplada del layout físico de la tabla de negocio — y sirve igual para
-- `checklists` (particionada), `ipercs` (particionada) y lo que venga
-- después, sin depender de que el cliente mande un timestamp confiable.
--
-- ── Por qué NO hay columna `status` ('processing'/'completed'/'failed') ───
--
-- Ese patrón sí existe en platformIdempotency.service.ts, porque allá
-- protege una operación multi-paso (crear tenant + admin) que no es atómica
-- y necesita Redis para el gate de concurrencia. Acá no hace falta: la
-- reserva de la clave, el INSERT del checklist y el de sus items corren
-- TODOS dentro de la misma transacción de withTenant(). Eso da las dos
-- garantías que un `status` tendría que dar a mano:
--
--   * Contra la carrera: dos requests concurrentes con el mismo
--     cliente_uuid se serializan solos en el índice único de la PK — el
--     segundo INSERT queda bloqueado hasta que el primero confirme o
--     revierta. Postgres ya hace de gate, no hace falta un estado
--     intermedio que lo simule.
--   * Contra el crash a mitad de camino: si el proceso muere antes del
--     COMMIT, la fila de esta tabla se revierte JUNTO con el checklist. No
--     puede quedar una clave huérfana en 'processing' que después haya que
--     limpiar, porque nunca llegó a existir para nadie más.
--
-- Un 'failed' tampoco aporta: si la creación falla, la transacción entera
-- revierte y la clave desaparece — que es justo lo que se quiere, para que
-- un reintento legítimo del mismo cliente_uuid pueda volver a intentarlo.
--
-- EJECUTAR (después de 0043):
--   psql -d mincoreerp -f migrations/0044_idempotency_keys.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- El mismo enum que gobierna qué módulos existen (migración 0008), no un
  -- CHECK nuevo: un CHECK sería una segunda lista de módulos a sincronizar
  -- a mano con el registry, justo lo que el Contrato de Módulo (ADR-0002)
  -- vino a eliminar. Acá se hereda gratis, y tests/module-registry.test.ts
  -- ya vigila que el enum y src/modules/registry.ts no diverjan.
  modulo      modulo_erp NOT NULL,
  -- Lo genera el DISPOSITIVO con crypto.randomUUID() en el momento en que
  -- el operario aprieta "Registrar" — no el servidor, y no la cola offline.
  -- Se genera SIEMPRE, esté o no offline en ese instante: el caso que esta
  -- tabla protege (respuesta perdida después de un guardado exitoso) puede
  -- pasar con señal perfecta al momento de apretar el botón.
  cliente_uuid UUID NOT NULL,
  -- A qué fila de negocio corresponde esta clave. Sin FK a propósito, por
  -- dos motivos independientes: (1) es polimórfica —apunta a `checklists`,
  -- `ipercs` o lo que se sume después—, y (2) `checklists` tiene PK
  -- COMPUESTA (id, creado_en) desde el particionado, así que una FK contra
  -- `id` solo no es ni siquiera declarable.
  --
  -- NULL solo es un estado TRANSITORIO dentro de la transacción que reserva
  -- la clave (ver idempotentInsert.ts): se inserta la reserva, se crea la
  -- fila, y se actualiza este valor antes del COMMIT. Nadie fuera de esa
  -- transacción llega a ver el NULL. Si aun así apareciera una fila
  -- commiteada con fila_id NULL, el helper la trata como "ya procesada pero
  -- irrecuperable" y no vuelve a crear nada — nunca duplica.
  fila_id     BIGINT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 72 horas: la ventana que hay que cubrir NO es "cuánto puede estar el
  -- equipo sin señal" (eso es ilimitado y no lo gobierna esta tabla — la
  -- cola vive en IndexedDB del dispositivo, sin vencimiento). Es la ventana
  -- mucho más corta entre "el servidor ya guardó la fila" y "llega el
  -- reintento porque la respuesta se perdió". Ese reloj arranca con el
  -- dispositivo teniendo señal, así que 72h da margen de sobra incluso para
  -- una zona muerta larga en Huamachuco/Cajamarca.
  --
  -- Deliberadamente NO son los 90 días de la retención de backups: ese
  -- número cubre otra cosa (darse cuenta tarde de un borrado por error o
  -- de una config rota). Copiarlo acá solo haría crecer la tabla 30 veces
  -- sin proteger ni un caso más.
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
  PRIMARY KEY (tenant_id, modulo, cliente_uuid)
);

-- La PK ya cubre el filtro de RLS (tenant_id líder) y el lookup por clave.
-- Este índice cubre la dirección inversa: "¿qué clave creó esta fila?" —
-- necesario para diagnosticar un duplicado sospechado sin escanear la
-- tabla entera, y para la limpieza si alguna vez hay que invalidar las
-- claves de una fila puntual.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_fila
  ON idempotency_keys(tenant_id, modulo, fila_id);

-- El worker de limpieza (idempotencyKeysRetention.worker.ts) barre
-- tenant por tenant —está obligado, por el RLS de abajo— así que su query
-- real es "WHERE tenant_id = $1 AND expires_at < now()". Por eso tenant_id
-- lidera y no expires_at: un índice solo por expires_at lo forzaría a leer
-- las filas vencidas de TODOS los tenants en cada pasada de cada uno.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys(tenant_id, expires_at);

-- Dato de negocio con tenant_id ⇒ RLS forzado, mismo blindaje que
-- checklists/ipercs y mismo bloque que exige tests/rls-coverage.test.ts.
-- No es una tabla de plataforma: nadie la lee "para todos los tenants"
-- desde el panel, y guarda punteros a filas de un tenant concreto. FORCE es
-- imprescindible (ver migración 0005): sin él, el owner de la tabla —que es
-- el rol con el que se conecta la app— queda exento y la policy no se
-- aplicaría a ninguna query real.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'idempotency_keys' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON idempotency_keys
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
