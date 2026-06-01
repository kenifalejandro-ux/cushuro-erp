/** client/src/dashboard/charts/StockMinimoChart.tsx */

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Line,
  Legend,
} from "recharts";

interface Props {
  data: {
    nombre: string;
    stock: number;
    stock_minimo: number;
    stock_maximo: number;
  }[];
}

export default function StockMinimoChart({ data }: Props) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 col-span-1 xl:col-span-3">
      <h3 className="text-sm font-medium text-slate-500 uppercase mb-6">
        Comparativo: Stock vs Rango Permitido
      </h3>

      <ResponsiveContainer width="100%" height={340}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />

          <XAxis dataKey="nombre" hide />
          <YAxis />

          <Tooltip />
          <Legend />

          {/* 🔵 Stock actual */}
          <Bar
            dataKey="stock"
            fill="#2563eb"
            name="Stock Actual"
            radius={[6, 6, 0, 0]}
          />

          {/* 🟠 Stock mínimo */}
          <Line
            type="monotone"
            dataKey="stock_minimo"
            stroke="#f59e0b"
            strokeWidth={2}
            dot={false}
            name="Stock Mínimo"
          />

          {/* 🟣 Stock máximo */}
          <Line
            type="monotone"
            dataKey="stock_maximo"
            stroke="#7c3aed"
            strokeWidth={2}
            dot={false}
            name="Stock Máximo"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}