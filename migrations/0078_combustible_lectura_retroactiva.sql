-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alerta de lectura de varilla insertada hacia atrás
--
-- Salió de la simulación de robo contra el módulo ya endurecido: `leido_en`
-- viaja en el body y NO se validaba nada -- ni futuro, ni orden. Se aceptó
-- una varilla fechada 90 días adelante y otra fechada ENTRE dos ya
-- registradas.
--
-- La fecha futura se arregla en el schema Zod, igual que se hizo con
-- `despachado_en` en 0077. Esta migración es para el otro caso.
--
-- ── Por qué una lectura hacia atrás importa ─────────────────────────────
--
-- El ciclo (0076) se mide desde la PRIMERA lectura posterior a la última
-- recepción. Insertar una lectura justo después de una carga la convierte en
-- el nuevo arranque del ciclo, y con un nivel inventado más bajo el
-- "esperado" baja con ella: un faltante real pasa a leerse como sobrante.
-- Es reescribir el punto de partida de la cuenta.
--
-- ── Por qué ALERTA y no BLOQUEA ─────────────────────────────────────────
--
-- Porque el caso legítimo es común y es el que el módulo fue diseñado para
-- soportar: la cola offline. Una varilla tomada a las 8 en un tanque sin
-- señal sincroniza a las 18, y para entonces puede haber otras lecturas
-- registradas después. Bloquearla haría perder mediciones reales de cancha,
-- que es peor que la manipulación que evita.
--
-- ── Por qué solo dentro del ciclo en curso ──────────────────────────────
--
-- Una lectura insertada en un ciclo YA CERRADO no puede cambiar ningún
-- cálculo futuro: el balance del tramo mira la lectura inmediata anterior y
-- el del ciclo arranca en la última recepción. Alertar por esas sería ruido,
-- y un control ruidoso se ignora -- la lección que ya dejó "marcar todas
-- leídas". Solo se alerta cuando la lectura cae DENTRO del ciclo vivo, que
-- es donde efectivamente puede mover la cuenta.
--
-- No se congela como anomalía: es una señal sobre CÓMO se cargó un dato, no
-- un faltante de combustible. Se revisa a mano y se cierra con motivo.
--
-- EJECUTAR (después de 0077):
--   psql -d mincoreerp -f migrations/0078_combustible_lectura_retroactiva.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN (
    'hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio',
    'diferencia_recepcion', 'nivel_bajo', 'medidor_inconsistente',
    'descuadre_inventario', 'descuadre_ciclo', 'tanque_sin_medir',
    'vale_fuera_de_orden', 'lectura_retroactiva'
  ));
