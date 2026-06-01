/** client/src/components/dashboard/charts/DocumentosEstado.tsx */

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface Props {
  data: {
    estado: string;
    total: number;
  }[];
}

// Colores ERP más profesionales
const COLORS = {
  VIGENTE: "#16a34a",     // verde moderno
  "POR VENCER": "#f59e0b", // ámbar elegante
  VENCIDO: "#dc2626",     // rojo sobrio
};

export default function DocumentosEstado({ data }: Props) {

  const totalGeneral = data.reduce((acc, item) => acc + item.total, 0);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 hover:shadow-sm transition-all duration-300">

      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
          Estado de Documentos
        </h3>

        <span className="text-xs text-slate-400">
          Total: {totalGeneral}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <PieChart>

          <Pie
            data={data}
            dataKey="total"
            nameKey="estado"
            innerRadius={70}       // 👈 Donut moderno
            outerRadius={100}
            paddingAngle={4}
            stroke="none"
          >
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={
                  COLORS[entry.estado as keyof typeof COLORS] ||
                  "#94a3b8"
                }
              />
            ))}
          </Pie>

          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              fontSize: "12px",
            }}
          />

          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="circle"
          />

        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}