// client/src/components/combustible/useAlertasCombustibleStream.ts
//
// Primer consumidor real del stream SSE del tenant del lado del cliente
// (GET /api/eventos/stream) -- hasta ahora esa infraestructura solo existía
// en el backend. El servidor manda el tipo del evento como `event:` SSE,
// no dentro de `data` (ver enviarEventoSSE en src/server/shared/utils/sse.ts),
// así que hace falta addEventListener por tipo, no el onmessage genérico.
//
// Solo se conecta si `activo` es true -- el llamador decide eso según rol
// (admin) y módulo habilitado, para no abrir el stream de nada para
// operador/lectura.

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../services/apiClient";

export interface AlertaCombustible {
  id: number;
  tipo: "hueco_detectado" | "vale_anulado";
  serie_talonario: string;
  n_vale: number;
  despacho_id: number | null;
  detalle: Record<string, unknown>;
  creado_en: string;
  leida_en: string | null;
  resuelta_en: string | null;
  resuelta_por: string | null;
}

interface RespuestaAlertas {
  data: AlertaCombustible[];
  pagination: { total: number };
}

export function useAlertasCombustibleStream(activo: boolean) {
  const [alertas, setAlertas] = useState<AlertaCombustible[]>([]);
  const [noLeidas, setNoLeidas] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await apiFetch("/api/erp/combustible/alertas?solo_no_leidas=true&pageSize=10");
      if (!res.ok) return;
      const body: RespuestaAlertas = await res.json();
      setAlertas(body.data);
      setNoLeidas(body.pagination.total);
    } catch {
      // Sin red o el endpoint falló -- la campanita simplemente se queda
      // con el último valor conocido, no rompe nada mostrar un número viejo.
    }
  }, []);

  useEffect(() => {
    if (!activo) return;

    // Patrón estándar de carga al montar -- ver IpercView.tsx / CombustiblePanel.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();

    const es = new EventSource("/api/eventos/stream", { withCredentials: true });
    eventSourceRef.current = es;
    es.addEventListener("combustible.alerta_creada", () => {
      cargar();
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [activo, cargar]);

  const marcarTodasLeidas = useCallback(async () => {
    await apiFetch("/api/erp/combustible/alertas/leidas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await cargar();
  }, [cargar]);

  return { alertas, noLeidas, marcarTodasLeidas, recargar: cargar };
}
