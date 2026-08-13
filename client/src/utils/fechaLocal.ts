/** client/src/utils/fechaLocal.ts
 *
 * Formato que espera un <input type="datetime-local">: sin zona horaria,
 * con la hora LOCAL del dispositivo (no UTC) -- así "ahora" en el input
 * coincide con el reloj real del operario en campo. Compartido entre
 * cualquier formulario que registre un evento con fecha/hora editable
 * (Combustible, Repuestos) -- antes vivía duplicado en CombustiblePanel.tsx.
 */
export function ahoraParaInputLocal(): string {
  const ahora = new Date();
  ahora.setMinutes(ahora.getMinutes() - ahora.getTimezoneOffset());
  return ahora.toISOString().slice(0, 16);
}
