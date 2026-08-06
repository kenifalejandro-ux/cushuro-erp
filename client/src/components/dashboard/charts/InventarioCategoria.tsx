/** client/src/components/dashboard/charts/InventarioCategoria.tsx */

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface Props {
  data: {
    categoria: string;
    total: number;
  }[];
}

export default function InventarioCategoria({ data }: Props) {
  const totalGeneral = data.reduce((acc, item) => acc + item.total, 0);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 hover:shadow-sm transition-all duration-300">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
          Inventario por Categoría
        </h3>

        <span className="text-xs text-slate-400">Total: {totalGeneral}</span>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          {/* Grid suave estilo ERP */}
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />

          <XAxis
            dataKey="categoria"
            tick={{ fontSize: 12, fill: "#64748b" }}
            axisLine={false}
            tickLine={false}
          />

          <YAxis tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />

          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              fontSize: "12px",
            }}
            cursor={{ fill: "rgba(148,163,184,0.08)" }}
          />

          <Bar
            dataKey="total"
            radius={[8, 8, 0, 0]}
            fill="#ff0000" // slate-700 corporativo
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
