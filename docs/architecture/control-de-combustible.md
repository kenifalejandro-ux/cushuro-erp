# Control de combustible y anti-fuga de capital

- **Estado**: diseño aceptado — Fase A (fundación de tanques) en implementación. Fases B, C y D pendientes, ver hoja de ruta al final.
- **Relacionado**: [ADR-0002](../adr/0002-contrato-de-modulo.md) (Combustible ya es un módulo con contrato; §8 documenta la cola offline de la que depende todo el punto 1).

---

## Por qué existe este documento

El análisis que sigue se armó en una sesión de chat, no en código. Ya se perdió una vez. Las fases B, C y D se van a construir semanas después de esta decisión, sobre supuestos que hoy solo viven acá — si este documento se pierde de nuevo, cualquiera (yo incluido, en otra sesión) va a reinventar peor lo que ya está resuelto.

El módulo resuelve un problema concreto: un grifero despacha combustible en campo, a veces sin señal, con papel (vale) como respaldo físico. El sistema tiene que detectar fuga de capital (combustible que sale sin quedar registrado, o que se registra distinto de lo que salió) sin generar tantas falsas alarmas que el control se vuelva ruido y nadie lo mire.

## Caso de referencia

Surtidor "Grifo Cantera", grifero Juan, equipos EX-04 (excavadora), VQ-12 (volquete), CG-02 (cargador). El contómetro del surtidor cerró el lunes en 12.400,0 gal. Juan tiene el block de vales serie A, numerados 00021 a 00050.

| Vale | Equipo | Contómetro | Cantidad |
|---|---|---|---|
| 00021 | EX-04 | 12.400,0 → 12.435,0 | 35 gal |
| 00022 | VQ-12 | 12.435,0 → 12.463,0 | 28 gal |
| 00023 | CG-02 | 12.463,0 → 12.498,0 | 35 gal |
| 00024 | VQ-12 | 12.498,0 → 12.520,0 | 22 gal |

Los cinco puntos de abajo se explican todos sobre este mismo caso.

---

## 1. Hueco de talonario y salto de contómetro son el mismo problema

Martes 08:15: Juan despacha 35 gal a EX-04 (vale 00021). La tablet está sin señal → el vale queda en cola en el dispositivo, todavía no llegó al servidor.

Martes 10:30: despacha 28 gal a VQ-12 (vale 00022). Acá sí hay señal → sincroniza al instante.

A las 11:00 el servidor solo tiene el vale 00022, y dispara dos alarmas:

```
⚠ Hueco de talonario:  falta el vale 00021
⚠ Salto de contómetro: el último cierre conocido es 12.400,0
                       pero el vale 00022 abre en 12.435,0
                       → 35 gal salieron sin vale
```

Las dos son falsas, y las dos tienen la misma causa: falta un registro que sí existe, pero todavía está en la tablet de Juan. A las 18:00, cuando vuelve la señal y el 00021 sincroniza, las dos alarmas desaparecen solas.

**Implicación de diseño**: son un solo chequeo, no dos. Verificar continuidad de talonario y verificar continuidad de contómetro son la misma operación (¿la secuencia de vales de este punto de abastecimiento está completa?) aplicada a dos columnas distintas. Un solo motor de conciliación, no dos validadores independientes que puedan divergir.

## 2. El contómetro es el número de secuencia, no el reloj

Para verificar continuidad hay que ordenar los vales — y el reloj del dispositivo no es confiable (se resetea, cambia de zona horaria, nadie lo nota). Ejemplo: la tablet de Juan tiene el reloj 4 horas adelantado.

| Vale | Hora real | Hora que graba la tablet | Contómetro |
|---|---|---|---|
| 00023 | 10:00 | 14:00 ❌ | 12.463,0 → 12.498,0 |
| 00024 | 12:00 | 12:00 ✓ | 12.498,0 → 12.520,0 |

Si se ordena por hora de despacho: 00024 (12:00) antes que 00023 (14:00) → el contómetro retrocedió 57 galones entre un vale y el siguiente. Imposible físicamente, el sistema gritaría fraude sobre un reloj mal puesto.

Si se ordena por `totalizador_inicio`: 00023 (12.463,0) antes que 00024 (12.498,0) → 00023 cierra en 12.498,0, 00024 abre en 12.498,0, perfecto.

**Regla**: el contómetro (un contador físico que solo sube) ordena los vales, nunca el timestamp del dispositivo. Es dato de campo, no depende del reloj de nadie ni del orden de sincronización.

**Consecuencia gratis**: si ordenar por contómetro y ordenar por timestamp dan resultados distintos, eso en sí mismo es señal de un reloj mal puesto o una fecha falseada — un control que no hubo que diseñar aparte, sale de comparar los dos órdenes.

## 3. Talonarios: hace falta una válvula de escape

Miércoles: a Juan se le vuelca diesel encima del vale 00025 y queda ilegible. Lo arranca, lo tira, usa el 00026.

**Sin mecanismo de anulación**, el sistema dispara:

```
⚠ Vale 00025 no registrado — posible despacho no declarado
   Responsable del block: Juan Pérez
```

La primera vez Juan explica que se mojó. La segunda, también. A la tercera su jefe ya lo mira raro. A la cuarta, Juan —que es honesto— carga un vale 00025 inventado (20 gal a un volquete cualquiera) solo para que la secuencia cierre y lo dejen en paz. Resultado: el control diseñado para detectar fraude acaba de fabricar un despacho falso, con la merma de ese volquete mal calculada de ahí en adelante.

**Con mecanismo de anulación**: Juan registra en segundos "vale 00025 anulado — se mojó con diesel, colilla guardada en el block". El número queda rendido, la colilla física es la prueba, no hay alarma.

**Por qué esto no debilita el control**: una vez que existe una salida legítima para un vale roto, un hueco de verdad (sin despacho y sin anulación) ya no tiene excusa. La válvula de escape es lo que le da filo al control — sin ella, el ruido de los vales rotos ahoga las señales reales.

## 4. Preview vivo en período abierto, hallazgo congelado en período cerrado

Mismo martes, tres momentos:

**14:00, período abierto**, el vale 00021 sigue en la tablet. La pantalla muestra el preview del período (hueco de talonario + salto de contómetro), calculado al vuelo. **No se escribe ninguna fila en la base.**

**18:00**, sincroniza el 00021. El preview se recalcula solo, las dos alertas desaparecen. No queda rastro, porque nunca se escribió nada.

**Miércoles 09:00**, el admin cierra el período del martes. Recién ahí lo que siga sin explicación se congela en `combustible_anomalias` como hallazgo permanente, y la conciliación del martes queda inmutable.

**Por qué importa**: si el preview escribiera filas a las 14:00, a fin de mes habría cientos de alertas de las cuales la mayoría se resolvieron solas y nadie las limpió. Al mes siguiente nadie abre esa pantalla — el control muere no por falso, sino por ruidoso. Con esta separación: si hay una fila en `combustible_anomalias`, es real; si el período no cerró, no hay fila.

**Bonus**: si el jueves aparece un vale del martes, no toca la conciliación ya cerrada — entra marcado como `despacho_tardio`. Que alguien "se acuerde" de un vale dos días después es justo lo que se quiere ver, no algo a corregir en silencio.

## 5. Qué bloquea el registro y qué no

**Bloquea — el vale se contradice a sí mismo**, sin necesitar ningún otro dato:

- Vale duplicado: Juan carga el 00022 dos veces sin darse cuenta → `409` — no hubo doble despacho, hubo doble tipeo, y la cola offline lo saca solo. El vale ya cargado se muestra en pantalla.
- Contómetro no coincide con la cantidad declarada: contómetro dice 12.463,0 → 12.498,0 = 35 gal, Juan escribió 53 (transpuso los dígitos) → `400`, se corrige ahí mismo con el papel en la mano — el mejor momento posible, mañana nadie se acuerda.

**No bloquea — la duda depende de otros vales o de otro dato**, se registra igual y se marca:

- Sobredespacho: EX-04 tiene tanque de 40 gal, Juan despacha 48. Sospechoso, pero puede haber llenado también un bidón para la motobomba, o la capacidad cargada en el sistema estar mal → `201 Creado` + anomalía marcada. Si bloqueara, la excavadora se queda sin combustible por una duda de dato — producción parada por algo que probablemente es un error de captura, no de fraude.
- Horómetro que no cierra con el último registro: puede ser adulteración, pero lo más probable es un vale de la mañana llegando tarde (el caso del punto 1) → `201 Creado`, se evalúa recién al conciliar el período.

**La regla en una línea**: el sistema bloquea cuando el vale se contradice a sí mismo. Nunca bloquea cuando la duda depende de otros vales — eso se resuelve al conciliar, no en el momento del despacho.

---

## Hoja de ruta

| Fase | Qué entra |
|---|---|
| **A** | Fundación: tanques/puntos de abastecimiento como entidad completa (ABM real, hoy solo existe `PUT /:id/nivel`). Ver prompt de ejecución en la rama `feat/combustible-tanques-crud`. |
| **B** | `combustible_despachos` + extensión de equipos + contómetro como secuencia + cola offline (puntos 1 y 2 de este documento). El corazón del módulo. |
| **C** | `combustible_recepciones` + costo ponderado (`costo_promedio`, reservado desde la Fase A pero sin lógica hasta acá). |
| **D** | Conciliación de período, `combustible_anomalias`, reportes, y talonarios con anulación (puntos 3, 4 y 5) si se decide que entran. |

Cada fase depende de que la anterior esté en `main` — en particular, B no arranca sin que el ABM de tanques (A) esté completo, porque el contómetro (punto 2) vive en el punto de abastecimiento, no en el despacho.
