/** client/src/components/dashboard/charts/ValorCategoriaHorizontal.tsx */

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface Props {
  data: {
    categoria: string;
    valor_total: number;
  }[];
}

export default function ValorCategoriaHorizontal({ data }: Props) {
  const totalGeneral = data.reduce((acc, item) => acc + item.valor_total, 0);

  // 🔥 Ordenamos de mayor a menor (más profesional)
  const sortedData = [...data].sort((a, b) => b.valor_total - a.valor_total);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 hover:shadow-sm transition-all duration-300">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-medium text-slate-500 uppercase tracking-wide">
          Valor de Inventario por Categoría
        </h3>

        <span className="text-xs text-slate-400">Total: S/ {totalGeneral.toLocaleString()}</span>
      </div>

      <ResponsiveContainer width="100%" height={350}>
        <BarChart
          data={sortedData}
          layout="vertical"
          margin={{ top: 10, right: 20, left: 20, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />

          <XAxis type="number" tickFormatter={(value) => `S/ ${Number(value).toLocaleString()}`} />

          <YAxis type="category" dataKey="categoria" width={120} />

          <Tooltip
            formatter={(value: any) => {
              const numberValue = Number(value);
              return [`S/ ${numberValue.toLocaleString()}`, "Valor"];
            }}
          />

          <Bar
            dataKey="valor_total"
            radius={[0, 8, 8, 0]}
            fill="#2563eb" // 🔵 Azul
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
