import { useState, useMemo, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

// ============================================================
// SHARED TYPES
// ============================================================

type Tab = "abs" | "csc";

// ============================================================
// MODULE 1 — ABS / WHEEL LOCK (Table 7 StVZO) + EBD LOGIC
// ============================================================

const VELOCITIES = Array.from({ length: 15 }, (_, i) => 20 + i * 10);
const G = 9.81;

// Константы для EBD (согласованные с модулем CSC)
const EBD_CAR = {
  m: 1500,
  h: 0.5,
  L: 2.7,
  weightDistFront: 0.6,
  brakeDistFront: 0.65, // Фиксированное распределение сил без EBD
};

const TABLE_COLUMNS: Record<
  number,
  { newPoints: [number, number][]; wornPoints: [number, number][] }
> = {
  0.1: {
    newPoints: [[50, 0.1], [90, 0.05], [130, 0.0]],
    wornPoints: [[50, 0.1], [90, 0.05], [130, 0.0]],
  },
  0.5: {
    newPoints: [[50, 0.5], [90, 0.05], [130, 0.0]],
    wornPoints: [[50, 0.25], [90, 0.05], [130, 0.0]],
  },
  0.55: {
    newPoints: [[50, 0.55], [90, 0.3], [130, 0.2]],
    wornPoints: [[50, 0.4], [90, 0.1], [130, 0.1]],
  },
  0.65: {
    newPoints: [[50, 0.65], [90, 0.6], [130, 0.55]],
    wornPoints: [[50, 0.5], [90, 0.2], [130, 0.2]],
  },
  0.85: {
    newPoints: [[50, 0.85], [90, 0.8], [130, 0.75]],
    wornPoints: [[50, 1.0], [90, 0.95], [130, 0.9]],
  },
};

const ABS_COLUMN_KEYS = [0.1, 0.5, 0.55, 0.65, 0.85];

const ABS_PRESETS = [
  { label: "0.85 — Без смазки", value: 0.85 },
  { label: "0.65 — Вода 0.2 мм", value: 0.65 },
  { label: "0.55 — Дождь, 1 мм", value: 0.55 },
  { label: "0.50 — Лужи, 2 мм", value: 0.5 },
  { label: "0.10 — Обледенение", value: 0.1, ice: true },
];

function interpolateInColumn(colKey: number, v: number, isWorn: boolean): number {
  const col = TABLE_COLUMNS[colKey];
  const pts = isWorn ? col.wornPoints : col.newPoints;
  if (v <= 50) return pts[0][1];
  if (v >= 130) {
    const slope = (pts[2][1] - pts[1][1]) / (pts[2][0] - pts[1][0]);
    return Math.max(0, pts[2][1] + slope * (v - 130));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (v >= x1 && v <= x2) return y1 + ((v - x1) / (x2 - x1)) * (y2 - y1);
  }
  return pts[0][1];
}

function calcMu(v: number, baseMu: number, isWorn: boolean): number {
  if (baseMu <= 0.1)
    return Math.max(0, interpolateInColumn(0.1, v, isWorn) * (baseMu / 0.1));
  if (baseMu >= 0.85)
    return Math.min(1.15, interpolateInColumn(0.85, v, isWorn) * (baseMu / 0.85));
  let lowKey = 0.1,
    highKey = 0.85;
  for (let i = 0; i < ABS_COLUMN_KEYS.length - 1; i++) {
    if (baseMu >= ABS_COLUMN_KEYS[i] && baseMu <= ABS_COLUMN_KEYS[i + 1]) {
      lowKey = ABS_COLUMN_KEYS[i];
      highKey = ABS_COLUMN_KEYS[i + 1];
      break;
    }
  }
  const muLow = interpolateInColumn(lowKey, v, isWorn);
  const muHigh = interpolateInColumn(highKey, v, isWorn);
  return Math.max(0, muLow + ((baseMu - lowKey) / (highKey - lowKey)) * (muHigh - muLow));
}

function AbsTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="font-bold text-white mb-1">{label} км/ч</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-mono font-semibold">{Number(p.value).toFixed(3)}</span>
        </p>
      ))}
    </div>
  );
}

function EbdTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="font-bold text-white mb-1">Замедление: {label} м/с²</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-mono font-semibold">{Number(p.value).toFixed(3)}</span>
        </p>
      ))}
    </div>
  );
}

function AbsModule() {
  const [decel, setDecel] = useState(6.0);
  const [baseMu, setBaseMu] = useState(0.65);
  const [muInput, setMuInput] = useState("0.65");

  const handleMuInput = useCallback((val: string) => {
    setMuInput(val);
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 0.05 && n <= 1.1) setBaseMu(n);
  }, []);

  const handleMuSlider = useCallback((val: number) => {
    setBaseMu(val);
    setMuInput(val.toFixed(2));
  }, []);

  // --- ЛОГИКА EBD ДЛЯ ТЕКУЩЕГО ЗАМЕДЛЕНИЯ ---
  const ebdStatus = useMemo(() => {
    const { m, h, L, g, weightDistFront, brakeDistFront } = EBD_CAR;
    const P1 = weightDistFront * m * g;
    const P2 = (1 - weightDistFront) * m * g;
    const dynamicTransfer = (m * decel * h) / L;
    const N1 = P1 + dynamicTransfer;
    const N2 = Math.max(0, P2 - dynamicTransfer);
    const T1 = m * decel * brakeDistFront;
    const T2 = m * decel * (1 - brakeDistFront);
    const f1 = N1 > 0 ? T1 / N1 : 0;
    const f2 = N2 > 0 ? T2 / N2 : 0;
    const isRearLockingFirst = f2 > f1;
    return { f1, f2, isRearLockingFirst, N2 };
  }, [decel]);

  const rows = useMemo(() =>
    VELOCITIES.map((v) => {
      const muNew = calcMu(v, baseMu, false);
      const muWorn = calcMu(v, baseMu, true);
      const aNew = muNew * G;
      const aWorn = muWorn * G;
      const isRearLockedNew = ebdStatus.f2 > muNew;
      const isRearLockedWorn = ebdStatus.f2 > muWorn;
      return { v, muNew, muWorn, aNew, aWorn, absNew: aNew < decel, absWorn: aWorn < decel, isRearLockedNew, isRearLockedWorn };
    }), [baseMu, decel, ebdStatus.f2]);

  const chartData = useMemo(() =>
    rows.map((r) => ({
      v: `${r.v}`,
      "Новые шины": +r.muNew.toFixed(3),
      "Изношенные шины": +r.muWorn.toFixed(3),
    })), [rows]);

  // --- ДАННЫЕ ДЛЯ ГРАФИКА EBD (f1, f2 vs замедление) ---
  const ebdChartData = useMemo(() => {
    const { m, h, L, g, weightDistFront, brakeDistFront } = EBD_CAR;
    const P1 = weightDistFront * m * g;
    const P2 = (1 - weightDistFront) * m * g;
    return Array.from({ length: 19 }, (_, i) => 1.0 + i * 0.5).map((ax) => {
      const dynamicTransfer = (m * ax * h) / L;
      const N1 = P1 + dynamicTransfer;
      const N2 = Math.max(0, P2 - dynamicTransfer);
      const T1 = m * ax * brakeDistFront;
      const T2 = m * ax * (1 - brakeDistFront);
      const f1 = N1 > 0 ? T1 / N1 : 0;
      const f2 = N2 > 0 ? T2 / N2 : 0;
      return {
        ax: ax.toFixed(1),
        f1: +f1.toFixed(3),
        f2: +f2.toFixed(3),
      };
    });
  }, []);

  const firstAbsNew = rows.find((r) => r.absNew)?.v ?? null;
  const firstAbsWorn = rows.find((r) => r.absWorn)?.v ?? null;
  const isRearLockedAny = rows.some(r => r.isRearLockedNew || r.isRearLockedWorn);

  return (
    <div className="space-y-8">
      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg flex flex-col justify-between">
          <div>
            <label className="block text-sm font-semibold text-slate-300 mb-2">
              Требуемое замедление машины (<span className="text-emerald-400 font-bold">x</span>):
            </label>
            <div className="flex items-baseline justify-between mb-3">
              <span className="text-3xl font-bold text-white font-mono">{decel.toFixed(1)}</span>
              <span className="text-sm text-slate-400">м/с²</span>
            </div>
            <input
              type="range" min={1.0} max={10.0} step={0.1} value={decel}
              onChange={(e) => setDecel(parseFloat(e.target.value))}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>1.0</span><span>10.0</span>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 mt-4 leading-relaxed">
            Если возможности дороги ниже заданного порога (<span className="text-amber-400">a_max &lt; x</span>), колеса
            сорвутся в блокировку, активируя ABS.
          </p>
        </div>

        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg col-span-1 md:col-span-2">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-3 gap-2">
            <label className="block text-sm font-semibold text-slate-300">
              Базовый коэффициент сцепления (<span className="text-sky-400 font-bold">μ₀</span> при 50 км/ч):
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number" min={0.05} max={1.1} step={0.01} value={muInput}
                onChange={(e) => handleMuInput(e.target.value)}
                className="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-center font-mono font-bold text-sky-400 focus:outline-none focus:border-sky-500 text-sm"
              />
              <span className="text-xs text-slate-400">для новых шин</span>
            </div>
          </div>
          <input
            type="range" min={0.05} max={1.1} step={0.01} value={baseMu}
            onChange={(e) => handleMuSlider(parseFloat(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500 mb-4"
          />
          <div>
            <span className="block text-xs font-semibold text-slate-400 mb-2">
              Выбор опорных столбцов из Таблицы 7 справочника:
            </span>
            <div className="flex flex-wrap gap-2">
              {ABS_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => { setBaseMu(p.value); setMuInput(p.value.toFixed(2)); }}
                  className={p.ice
                    ? "px-2.5 py-1 bg-sky-950 hover:bg-sky-900 text-xs text-sky-300 rounded border border-sky-800 transition font-medium"
                    : "px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-xs text-slate-200 rounded transition font-medium"}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* EBD / Analysis Results */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-base font-bold text-white">
              Анализ баланса тормозных сил (EBD Deficit)
            </h3>
            <span className="text-[10px] text-slate-400 uppercase tracking-wider">Критерии ООН № 13-Н</span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={ebdChartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="ax" tick={{ fill: "#94a3b8", fontSize: 11 }} label={{ value: 'Замедление ax (м/с²)', position: 'insideBottom', offset: -5, fill: '#64748b', fontSize: 10 }} />
                <YAxis domain={[0, 1.0]} tick={{ fill: "#94a3b8", fontSize: 11 }} label={{ value: 'Реализуемое сцепление f', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 10 }} />
                <Tooltip content={<EbdTooltip />} />
                <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 12 }} />
                <ReferenceLine
                  x={decel.toFixed(1)}
                  stroke="#10b981"
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  label={{ value: `Текущее: ${decel}`, fill: "#10b981", fontSize: 10, position: "insideTopRight" }}
                />
                <Line name="Передняя ось (f1)" type="monotone" dataKey="f1" stroke="#38bdf8" strokeWidth={2.5} dot={false} />
                <Line name="Задняя ось (f2)" type="monotone" dataKey="f2" stroke="#f43f5e" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-4 text-[11px] text-slate-500 leading-relaxed italic">
            * Точка пересечения линий f1 и f2 показывает предел устойчивости ТС без системы EBD. Если красная линия (f2) выше синей (f1), задние колеса заблокируются раньше передних.
          </p>
        </div>

        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg flex flex-col gap-4">
          <h3 className="text-base font-bold text-white">Результаты экспресс-анализа</h3>
          
          <div className="space-y-4">
            {/* ABS Verdict */}
            <div className={`p-3 rounded-lg bg-slate-900 border-l-4 ${firstAbsNew !== null ? "border-amber-500" : "border-emerald-500"}`}>
              <h4 className="text-xs uppercase tracking-wider text-slate-400 font-bold">Статус ABS</h4>
              <p className="text-sm text-slate-200 mt-1">
                {firstAbsNew !== null ? (
                  <>Риск блокировки передней оси на скоростях <strong className="text-amber-400">от {firstAbsNew} км/ч</strong>.</>
                ) : (
                  <><strong className="text-emerald-400">ABS стабильна.</strong> Передние колеса сохраняют качение.</>
                )}
              </p>
            </div>

            {/* EBD Balance Warning */}
            {ebdStatus.isRearLockingFirst && (
              <div className="p-3 rounded-lg bg-amber-950/40 border-l-4 border-amber-500 border border-amber-500/20">
                <h4 className="text-xs uppercase tracking-wider text-amber-400 font-bold">⚠️ Нарушение баланса (EBD)</h4>
                <p className="text-[11px] text-amber-200 mt-1 leading-tight">
                  Задняя ось разгружена (f2 &gt; f1). В автомобиле без EBD это привело бы к <strong>опережающей блокировке задних колес</strong> и заносу.
                </p>
              </div>
            )}

            {/* Critical Rear Lock */}
            {isRearLockedAny && (
              <div className="p-3 rounded-lg bg-rose-950/40 border-l-4 border-rose-500 border border-rose-500/20 animate-pulse">
                <h4 className="text-xs uppercase tracking-wider text-rose-400 font-bold">🚨 Критический занос сзади</h4>
                <p className="text-[11px] text-rose-200 mt-1 leading-tight">
                  Предел сцепления задних колес (f2 &gt; μ) превышен. Требуется немедленное вмешательство EBD/ABS для сброса давления.
                </p>
              </div>
            )}

            {!ebdStatus.isRearLockingFirst && !isRearLockedAny && (
              <div className="p-3 rounded-lg bg-emerald-950/40 border-l-4 border-emerald-500 border border-emerald-500/20">
                <h4 className="text-xs uppercase tracking-wider text-emerald-400 font-bold">✅ Баланс в норме</h4>
                <p className="text-[11px] text-emerald-200 mt-1">
                  Тормозные силы распределены безопасно. Передняя ось блокируется первой или одновременно.
                </p>
              </div>
            )}
          </div>

          <div className="mt-auto pt-4 border-t border-slate-700">
            <div className="flex justify-between text-[10px] text-slate-400 mb-1">
              <span>Реализуемое сцепление спереди (f1):</span>
              <span className="font-mono text-sky-400">{ebdStatus.f1.toFixed(3)}</span>
            </div>
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>Реализуемое сцепление сзади (f2):</span>
              <span className={`font-mono ${ebdStatus.isRearLockingFirst ? 'text-rose-400' : 'text-slate-300'}`}>{ebdStatus.f2.toFixed(3)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Mu Chart */}
      <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
        <h3 className="text-base font-bold text-white mb-4">
          Зависимость коэффициента сцепления μ(v) от скорости
        </h3>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="v" tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <YAxis domain={[0, 1.15]} tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <Tooltip content={<AbsTooltip />} />
              <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 12 }} />
              <ReferenceLine
                y={decel / G}
                stroke="#10b981"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                label={{ value: `x/g = ${(decel / G).toFixed(2)}`, fill: "#10b981", fontSize: 10, position: "insideTopRight" }}
              />
              <Line type="monotone" dataKey="Новые шины" stroke="#38bdf8" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="Изношенные шины" stroke="#f59e0b" strokeWidth={2.5} strokeDasharray="6 4" dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden">
        <div className="p-6 border-b border-slate-700 flex justify-between items-center flex-wrap gap-4">
          <div>
            <h2 className="text-xl font-bold text-white">Инженерная верификационная ведомость</h2>
            <p className="text-sm text-slate-400 mt-1">
              Подробный пошаговый расчет изменения сцепления от скорости (от 20 до 160 км/ч)
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-950 border border-red-500 inline-block" />
              Блок / ABS сработает
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-emerald-950 border border-emerald-500 inline-block" />
              Качение / ABS молчит
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-900 text-slate-400 text-xs font-semibold uppercase tracking-wider border-b border-slate-700">
                <th className="py-3 px-5 text-center" rowSpan={2}>Скорость (км/ч)</th>
                <th className="py-3 px-4 border-l border-slate-700 text-center" colSpan={3}>Новые пневматические шины</th>
                <th className="py-3 px-4 border-l border-slate-700 text-center" colSpan={3}>Изношенные шины (протектор ≤ 1.6 мм)</th>
              </tr>
              <tr className="bg-slate-900/60 text-slate-500 text-[10px] uppercase tracking-wider border-b border-slate-700">
                <th className="py-2 px-4 border-l border-slate-700 text-center">Коэфф. μ(v)</th>
                <th className="py-2 px-4 text-center">a_max (м/с²)</th>
                <th className="py-2 px-4 text-center">Статус ABS</th>
                <th className="py-2 px-4 border-l border-slate-700 text-center">Коэфф. μ(v)</th>
                <th className="py-2 px-4 text-center">a_max (м/с²)</th>
                <th className="py-2 px-4 text-center">Статус ABS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {rows.map((r) => (
                <tr key={r.v} className="hover:bg-slate-700/30 transition-colors">
                  <td className="py-2.5 px-5 text-center font-mono font-bold text-slate-300 bg-slate-900/30">{r.v}</td>
                  <td className="py-2.5 px-4 text-center border-l border-slate-700 font-mono text-sky-400">{r.muNew.toFixed(3)}</td>
                  <td className="py-2.5 px-4 text-center font-mono text-slate-400">{r.aNew.toFixed(2)}</td>
                  <td className="py-2.5 px-4 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter ${r.absNew ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"}`}>
                      {r.absNew ? "БЛОК (ABS)" : "КАЧЕНИЕ"}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-center border-l border-slate-700 font-mono text-amber-500">{r.muWorn.toFixed(3)}</td>
                  <td className="py-2.5 px-4 text-center font-mono text-slate-400">{r.aWorn.toFixed(2)}</td>
                  <td className="py-2.5 px-4 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter ${r.absWorn ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"}`}>
                      {r.absWorn ? "БЛОК (ABS)" : "КАЧЕНИЕ"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MODULE 2 — CSC / CBC CORNERING STABILITY CONTROL
// ============================================================

const CAR = {
  m: 1500, h: 0.5, L: 2.7, B: 1.5, g: 9.81,
  s_opt: 20,
  weightDistFront: 0.6,
  brakeDistFront: 0.65,
  ay_comfort: 3.5,
};

const MU_PRESETS = [
  { label: "Лед (0.1)", value: 0.1 },
  { label: "Мокрый снег (0.3)", value: 0.3 },
  { label: "Мокрый асфальт (0.5)", value: 0.5 },
  { label: "Влажный асфальт (0.65)", value: 0.65 },
  { label: "Сухой асфальт (0.85)", value: 0.85 },
];

function calculateDynamicState(speedKmh: number, deceleration: number, radius: number, muMax: number) {
  const v_ms = speedKmh / 3.6;
  const safeComfortRadius = (v_ms * v_ms) / CAR.ay_comfort;
  const a_y = (v_ms * v_ms) / radius;
  const a_y_g = a_y / CAR.g;
  
  const Fz_static_front = (CAR.weightDistFront * CAR.m * CAR.g) / 2;
  const deltaFz_long = (CAR.m * deceleration * CAR.h) / (2 * CAR.L);
  const deltaFz_lat = (CAR.weightDistFront * CAR.m * a_y * CAR.h) / CAR.B;

  const Fz_front_physical_max = 2 * (Fz_static_front + deltaFz_long);
  
  let Fz_VF = Fz_static_front + deltaFz_long + deltaFz_lat;
  let Fz_VN = Fz_static_front + deltaFz_long - deltaFz_lat;
  
  if (Fz_VN < 0) {
    Fz_VN = 0;
    Fz_VF = Fz_front_physical_max;
  }
  if (Fz_VF < 0) Fz_VF = 0;

  const Fz_front_total = Fz_VF + Fz_VN;
  const Fz_straight = Fz_static_front + deltaFz_long;
  const Fy_front_total_req = CAR.weightDistFront * CAR.m * a_y;
  const Fy_front_max_possible = muMax * Fz_front_total;
  const Fy_front_actual = Math.min(Fy_front_total_req, Fy_front_max_possible);
  
  const getMuDynamic = (Fz: number, Fz_ref: number, mu_base: number) => {
    if (Fz <= 0) return 0;
    const k = 0.15; 
    return mu_base * (1 - k * (Fz - Fz_ref) / Fz_ref);
  };

  const mu_VF = getMuDynamic(Fz_VF, Fz_static_front, muMax);
  const mu_VN = getMuDynamic(Fz_VN, Fz_static_front, muMax);

  const Fmax_VF = mu_VF * Fz_VF;
  const Fmax_VN = mu_VN * Fz_VN;
  
  const lateralLoadRatio = Math.max(0.1, a_y_g / Math.max(0.1, muMax));
  let Fy_VF = Fy_front_actual * (0.5 + 0.12 * lateralLoadRatio);
  let Fy_VN = Fy_front_actual * (0.5 - 0.12 * lateralLoadRatio);

  if (Fy_VN > Fmax_VN) { const excess = Fy_VN - Fmax_VN; Fy_VN = Fmax_VN; Fy_VF = Math.min(Fmax_VF, Fy_VF + excess); }
  if (Fy_VF > Fmax_VF) Fy_VF = Fmax_VF;

  let Fx_max_VF = Fmax_VF > Fy_VF ? Math.sqrt(Fmax_VF ** 2 - Fy_VF ** 2) : 0;
  let Fx_max_VN = Fmax_VN > Fy_VN ? Math.sqrt(Fmax_VN ** 2 - Fy_VN ** 2) : 0;

  const mu_x_VF = Fz_VF > 0 ? Fx_max_VF / Fz_VF : 0;
  const mu_x_VN = Fz_VN > 0 ? Fx_max_VN / Fz_VN : 0;
  
  const calculateScritCombined = (mu_x: number, mu_base: number, s_straight: number) => {
    if (mu_base <= 0) return s_straight;
    const combinedRatio = mu_x / mu_base;
    return Math.min(40, s_straight / Math.max(0.5, combinedRatio));
  };

  const s_crit_VF = calculateScritCombined(mu_x_VF, muMax, CAR.s_opt);
  const s_crit_VN = calculateScritCombined(mu_x_VN, muMax, CAR.s_opt);
  
  const Fx_max_straight = muMax * Fz_straight;
  const Fx_front_required = CAR.m * deceleration * CAR.brakeDistFront;
  const Fx_req_per_wheel = Fx_front_required / 2;

  const calcSlip = (Fx_req: number, Fx_max: number, s_crit: number) => {
    if (Fx_max <= 0 || s_crit <= 0) return 100;
    const r = Fx_req / Fx_max;
    if (r <= 0.95) return s_crit * Math.pow(r, 1.8);
    const excess = r - 0.95;
    return Math.min(100, s_crit * 0.9 + (100 - s_crit * 0.9) * (1 - Math.exp(-excess * 4.5)));
  };

  const s_actual_VF = calcSlip(Fx_req_per_wheel, Fx_max_VF, s_crit_VF);
  const s_actual_VN = calcSlip(Fx_req_per_wheel, Fx_max_VN, s_crit_VN);
  const isLocked_VF = s_actual_VF >= s_crit_VF * 1.15 || Fx_req_per_wheel >= Fx_max_VF;
  const isLocked_VN = s_actual_VN >= s_crit_VN * 1.15 || Fx_req_per_wheel >= Fx_max_VN;
  const Fx_csc_safe_VN = Fx_max_VN * 0.8;
  const cscBrakeReductionRequired = Fx_req_per_wheel > Fx_csc_safe_VN;
  const cscForceDelta = cscBrakeReductionRequired ? Fx_req_per_wheel - Fx_csc_safe_VN : 0;
  const cscPressureReductionPercent = cscBrakeReductionRequired
    ? Math.min(100, (cscForceDelta / Fx_req_per_wheel) * 100)
    : 0;

  const isSliding = a_y > muMax * CAR.g;
  const isUncomfortable = a_y > CAR.ay_comfort;

  return {
    safeComfortRadius, a_y, a_y_g, Fz_VF, Fz_VN, Fmax_VF, Fmax_VN,
    Fx_max_VF, Fx_max_VN, Fx_max_straight, mu_x_VF, mu_x_VN,
    s_crit_VF, s_crit_VN, s_actual_VF, s_actual_VN,
    isLocked_VF, isLocked_VN, Fx_req_per_wheel,
    cscPressureReductionPercent, cscBrakeReductionRequired, cscForceDelta,
    isSliding, isWheelLifting: Fz_VN === 0, isUncomfortable,
    deltaFz_long, deltaFz_lat, Fz_static_front, Fz_straight,
  };
}

function CscModule() {
  const [speed, setSpeed] = useState(80);
  const [deceleration, setDeceleration] = useState(2.8);
  const [radius, setRadius] = useState(105);
  const [muMax, setMuMax] = useState(0.65);

  const calc = useMemo(() => calculateDynamicState(speed, deceleration, radius, muMax), [speed, deceleration, radius, muMax]);

  const tableData = useMemo(() => {
    const base = [30, 50, 70, 90, 110, 130, 150];
    return Array.from(new Set([...base, speed])).sort((a, b) => a - b).map((v) => {
      const s = calculateDynamicState(v, deceleration, radius, muMax);
      return {
        v,
        s_crit_VF: s.s_crit_VF, s_crit_VN: s.s_crit_VN,
        s_actual_VF: s.s_actual_VF, s_actual_VN: s.s_actual_VN,
        isLocked_VN: s.isLocked_VN, isLocked_VF: s.isLocked_VF,
        cscReduction: s.cscPressureReductionPercent,
        isCurrent: v === speed,
        isUncomfortable: s.isUncomfortable,
        isSliding: s.isSliding,
      };
    });
  }, [speed, deceleration, radius, muMax]);

  const setComfortRadius = () => {
    const v_ms = speed / 3.6;
    setRadius(Math.max(15, Math.min(500, Math.ceil((v_ms * v_ms) / CAR.ay_comfort))));
  };

  const yMaxScale = Math.ceil(Math.max(calc.Fx_max_VF, calc.Fx_max_straight, 2000) / 1000) * 1000;
  const yBrakeReq = 170 - (calc.Fx_req_per_wheel / yMaxScale) * 140;

  const makeCurve = (fxMax: number, sCrit: number) =>
    Array.from({ length: 26 }, (_, i) => i * 2).map((s) => {
      const x = 50 + s * 8.2;
      const f = sCrit > 0 ? s / sCrit : 0;
      const force = fxMax * (f > 0 ? (2 * f / (1 + f * f)) : 0);
      const y = 170 - (force / yMaxScale) * 140;
      return `${s === 0 ? "M" : "L"} ${x} ${y}`;
    }).join(" ");

  return (
    <div className="space-y-6">

      {/* Physics / comfort alerts */}
      {calc.isSliding && (
        <div className="bg-rose-950 border border-rose-500/50 text-rose-200 px-4 py-3 rounded-xl flex items-center gap-3 animate-pulse">
          <span className="text-2xl">⚠️</span>
          <div className="text-sm">
            <strong className="font-bold">Критический снос оси!</strong> Автомобиль не может удержаться на дуге поворота.
            Поперечное ускорение ({calc.a_y_g.toFixed(2)}g) превышает физический предел сцепления ({muMax}g).
          </div>
        </div>
      )}
      {!calc.isSliding && calc.isUncomfortable && (
        <div className="bg-amber-950/60 border border-amber-500/30 text-amber-200 px-4 py-3 rounded-xl flex items-center gap-3">
          <span className="text-2xl">🤢</span>
          <div className="text-sm">
            <strong className="font-bold">Превышен порог комфортного вождения!</strong> Боковое ускорение ({calc.a_y.toFixed(2)} м/с²) выше
            рекомендуемых {CAR.ay_comfort} м/с² для гражданских поездок. Сильные крены кузова и сдвиг порогов блокировки!
          </div>
        </div>
      )}

      {/* Verdict cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className={`rounded-2xl p-5 border shadow-lg transition-all duration-300 ${calc.isLocked_VN ? "bg-rose-950/80 border-rose-500 text-rose-100" : "bg-slate-800/90 border-slate-700 text-slate-100"}`}>
          <div className="flex justify-between items-center">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Внутреннее колесо (VN)</h3>
            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${calc.isLocked_VN ? "bg-rose-500 text-white animate-pulse" : "bg-emerald-500/10 text-emerald-400"}`}>
              {calc.isLocked_VN ? "🚨 БЛОКИРОВКА!" : "✅ СТАБИЛЬНО"}
            </span>
          </div>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Порог скольжения (s_crit):</span>
              <span className="font-mono font-bold text-amber-400">{calc.s_crit_VN.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Скольжение без CSC (s_act):</span>
              <span className={`font-mono font-bold ${calc.isLocked_VN ? "text-rose-400" : "text-slate-300"}`}>
                {calc.s_actual_VN.toFixed(1)}% {calc.isLocked_VN && "(Глубокий Срыв)"}
              </span>
            </div>
            <div className="border-t border-slate-700/50 pt-2 flex justify-between text-[10px] text-slate-500">
              <span>Запрос тормозов: {calc.Fx_req_per_wheel.toFixed(0)} Н</span>
              <span>Предел сцепления: {calc.Fx_max_VN.toFixed(0)} Н</span>
            </div>
          </div>
        </div>

        <div className="bg-slate-800/90 border border-slate-700 rounded-2xl p-5 shadow-lg">
          <div className="flex justify-between items-center">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Внешнее колесо (VF)</h3>
            <span className="bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full text-xs font-bold">✅ СТАБИЛЬНО</span>
          </div>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Порог скольжения (s_crit):</span>
              <span className="font-mono font-bold text-emerald-400">{calc.s_crit_VF.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Скольжение без CSC (s_act):</span>
              <span className="font-mono font-bold text-slate-300">{calc.s_actual_VF.toFixed(1)}%</span>
            </div>
            <div className="border-t border-slate-700/50 pt-2 flex justify-between text-[10px] text-slate-500">
              <span>Запрос тормозов: {calc.Fx_req_per_wheel.toFixed(0)} Н</span>
              <span>Предел сцепления: {calc.Fx_max_VF.toFixed(0)} Н</span>
            </div>
          </div>
        </div>

        <div className={`rounded-2xl p-5 border shadow-lg transition-all duration-300 ${calc.cscBrakeReductionRequired ? "bg-blue-950/80 border-blue-500 text-blue-100" : "bg-slate-800/90 border-slate-700 text-slate-100"}`}>
          <div className="flex justify-between items-center">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Реакция системы CSC</h3>
            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${calc.cscBrakeReductionRequired ? "bg-blue-500 text-white" : "bg-slate-700 text-slate-400"}`}>
              {calc.cscBrakeReductionRequired ? "⚡ АКТИВНА" : "⏸️ ОЖИДАНИЕ"}
            </span>
          </div>
          <div className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Сброс давления на VN:</span>
              <span className="font-mono font-bold text-blue-400">
                {calc.cscPressureReductionPercent > 0 ? `Снизить на ${calc.cscPressureReductionPercent.toFixed(0)}%` : "Не требуется"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Необходимая дельта сил (ΔFx):</span>
              <span className="font-mono font-bold text-slate-300">
                {calc.cscForceDelta > 0 ? `${calc.cscForceDelta.toFixed(0)} Н` : "0 Н"}
              </span>
            </div>
            <div className="border-t border-slate-700/50 pt-2 text-[10px] text-slate-500 leading-tight">
              {calc.cscBrakeReductionRequired
                ? "CSC превентивно ослабляет внутренний тормозной контур, удерживая колесо от юза."
                : "Запас сцепления внутреннего колеса достаточен для безопасного замедления ТС."}
            </div>
          </div>
        </div>
      </div>

      {/* Controls + Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Sliders */}
        <div className="lg:col-span-4 bg-slate-800/80 border border-slate-700 p-6 rounded-2xl space-y-5">
          <h2 className="text-base font-bold text-white border-b border-slate-700 pb-2">Параметры симуляции</h2>

          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300">Начальная скорость:</span>
              <span className="font-mono font-bold text-emerald-400">{speed} км/ч</span>
            </div>
            <input type="range" min={20} max={185} step={5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500" />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300">Замедление торможения:</span>
              <span className="font-mono font-bold text-rose-400">{deceleration.toFixed(1)} м/с²</span>
            </div>
            <input type="range" min={0.5} max={8.5} step={0.1} value={deceleration} onChange={(e) => setDeceleration(Number(e.target.value))}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-rose-500" />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-slate-300">Радиус поворота:</span>
              <span className="font-mono font-bold text-blue-400">{radius} м</span>
            </div>
            <input type="range" min={15} max={350} step={5} value={radius} onChange={(e) => setRadius(Number(e.target.value))}
              className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
            <button onClick={setComfortRadius}
              className="text-xs bg-slate-700 hover:bg-slate-600 text-blue-300 px-2 py-1.5 rounded transition-colors w-full">
              Установить комфортный радиус (~{Math.ceil(calc.safeComfortRadius)} м)
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-slate-300 block">Коэффициент сцепления покрытия (μ_max):</label>
            <div className="flex flex-wrap gap-1.5">
              {MU_PRESETS.map((p) => (
                <button key={p.value} onClick={() => setMuMax(p.value)}
                  className={`text-[11px] px-2 py-1 rounded border transition-all ${Math.abs(muMax - p.value) < 0.01
                    ? "bg-slate-100 text-slate-900 border-white font-semibold"
                    : "bg-slate-800 text-slate-400 border-slate-700 hover:text-white"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Charts */}
        <div className="lg:col-span-8 space-y-6">
          {/* SVG slip chart */}
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6">
            <div className="flex justify-between items-start mb-4 gap-2 flex-wrap">
              <h3 className="text-base font-bold text-white">Тормозное усилие и зоны проскальзывания шин</h3>
              <span className="text-[11px] text-slate-400">Штрихпунктиром показан порог срыва (блокировки)</span>
            </div>
            <svg viewBox="0 0 500 200" className="w-full h-auto overflow-visible">
              <line x1="50" y1="170" x2="480" y2="170" stroke="#475569" strokeWidth="1.5" />
              <line x1="50" y1="20" x2="50" y2="170" stroke="#475569" strokeWidth="1.5" />
              <text x="480" y="185" fill="#94a3b8" fontSize="10" textAnchor="end">Скольжение шины (%)</text>
              <text x="45" y="15" fill="#94a3b8" fontSize="10" textAnchor="start">Тормозная сила Fx (Н)</text>

              {[0, 10, 20, 30, 40, 50].map((s) => {
                const x = 50 + s * 8.2;
                return <g key={s}>
                  <line x1={x} y1="170" x2={x} y2="175" stroke="#475569" strokeWidth="1" />
                  <text x={x} y="190" fill="#64748b" fontSize="9" textAnchor="middle">{s}%</text>
                </g>;
              })}

              {[0, 0.5, 1.0].map((ratio) => {
                const y = 170 - ratio * 140;
                return <g key={ratio}>
                  <line x1="45" y1={y} x2="480" y2={y} stroke="#1e293b" strokeWidth="1" strokeDasharray="2 2" />
                  <text x="40" y={y + 3} fill="#64748b" fontSize="9" textAnchor="end">{(yMaxScale * ratio).toFixed(0)}</text>
                </g>;
              })}

              <line x1="50" y1={yBrakeReq} x2="480" y2={yBrakeReq} stroke="#f43f5e" strokeWidth="2" strokeDasharray="4 4" />
              <text x="470" y={yBrakeReq - 6} fill="#f43f5e" fontSize="9" fontWeight="bold" textAnchor="end">
                Давление педали: {calc.Fx_req_per_wheel.toFixed(0)} Н
              </text>

              <path d={makeCurve(calc.Fx_max_VF, calc.s_crit_VF)} fill="none" stroke="#10b981" strokeWidth="3" />
              <path d={makeCurve(calc.Fx_max_VN, calc.s_crit_VN)} fill="none" stroke="#f59e0b" strokeWidth="3" />

              {/* VF working point — only when not locked */}
              {!calc.isLocked_VF && (
                <g>
                  <circle cx={50 + calc.s_actual_VF * 8.2} cy={yBrakeReq} r="6" fill="#10b981" stroke="#fff" strokeWidth="2" />
                  <text x={50 + calc.s_actual_VF * 8.2} y={yBrakeReq - 10} fill="#10b981" fontSize="10" fontWeight="bold" textAnchor="middle">
                    VF: {calc.s_actual_VF.toFixed(1)}%
                  </text>
                </g>
              )}

              {/* VN working point */}
              {calc.isLocked_VN ? (
                <g>
                  <circle cx="460" cy="170" r="7" fill="#ef4444" stroke="#fff" strokeWidth="2" />
                  <text x="460" y="155" fill="#ef4444" fontSize="10" fontWeight="bold" textAnchor="middle">VN ЮЗ!</text>
                </g>
              ) : (
                <g>
                  <circle cx={50 + calc.s_actual_VN * 8.2} cy={yBrakeReq} r="6" fill="#f59e0b" stroke="#fff" strokeWidth="2" />
                  <text x={50 + calc.s_actual_VN * 8.2} y={yBrakeReq - 10} fill="#f59e0b" fontSize="10" fontWeight="bold" textAnchor="middle">
                    VN: {calc.s_actual_VN.toFixed(1)}%
                  </text>
                </g>
              )}
            </svg>

            <div className="flex flex-wrap gap-4 justify-center mt-3 text-xs text-slate-400">
              <span className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-500 rounded-full" /> Внешняя рабочая точка скольжения</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 bg-amber-500 rounded-full" /> Внутренняя рабочая точка скольжения</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 bg-rose-500 rounded-full" /> Глубокий срыв сцепления</span>
            </div>
          </div>

          {/* Speed table */}
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6">
            <h3 className="text-base font-bold text-white mb-1">Анализ работы CSC по диапазону скоростей</h3>
            <p className="text-xs text-slate-400 mb-4">
              Сравнение скольжений при неизменном давлении педали (замедление {deceleration.toFixed(1)} м/с²):
            </p>
            <div className="overflow-x-auto rounded-xl border border-slate-700">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-900/60 text-slate-400 border-b border-slate-700 text-xs uppercase">
                    <th className="py-3 px-4">Скорость</th>
                    <th className="py-3 px-4 text-emerald-400">Внешнее (Порог / Факт)</th>
                    <th className="py-3 px-4 text-amber-400">Внутреннее (Порог / Факт)</th>
                    <th className="py-3 px-4 text-blue-400">Дельта Порогов</th>
                    <th className="py-3 px-4">Комфорт / Вмешательство CSC</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 font-mono text-xs">
                  {tableData.map((row) => {
                    const deltaCrit = row.s_crit_VF - row.s_crit_VN;
                    return (
                      <tr key={row.v}
                        className={`transition-colors hover:bg-slate-700/30 ${row.isCurrent ? "bg-blue-600/10 border-l-4 border-l-blue-500 text-white font-bold" : "text-slate-300"}`}>
                        <td className="py-3 px-4">{row.v} км/ч {row.isCurrent && "📍"}</td>
                        <td className="py-3 px-4 text-emerald-400">
                          {row.s_crit_VF.toFixed(1)}% / <span className="font-bold">{row.s_actual_VF.toFixed(1)}%</span>
                        </td>
                        <td className="py-3 px-4 text-amber-400">
                          {row.s_crit_VN.toFixed(1)}% /{" "}
                          <span className={row.isLocked_VN ? "text-rose-400 font-bold" : "font-bold"}>
                            {row.s_actual_VN.toFixed(1)}% {row.isLocked_VN && "(Срыв)"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-blue-300">{deltaCrit.toFixed(1)}%</td>
                        <td className="py-3 px-4">
                          <div className="flex flex-col gap-0.5 font-sans text-xs">
                            {row.isSliding ? (
                              <span className="text-rose-400 font-extrabold">🚨 СНОС ОСИ</span>
                            ) : row.isUncomfortable ? (
                              <span className="text-amber-400 font-semibold">⚠️ ПРЕВЫШЕН 3.5 м/с²</span>
                            ) : (
                              <span className="text-emerald-400">🟢 КОМФОРТНО</span>
                            )}
                            {row.cscReduction > 0 && (
                              <span className="text-blue-400 font-bold font-mono text-[10px]">
                                CSC: сброс VN на {row.cscReduction.toFixed(0)}%
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Info block */}
      <section className="bg-slate-800/80 border border-slate-700 rounded-2xl p-6">
        <h3 className="text-base font-bold text-white mb-4">Как работает алгоритм CSC (Cornering Stability Control)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-slate-300 leading-relaxed">
          <div>
            <h4 className="font-bold text-slate-100 mb-1">1. Распознавание дефицита сцепления</h4>
            <p>Блок управления тормозной системой постоянно вычисляет угловые скорости колес. В повороте внутреннее колесо разгружается и начинает скользить сильнее под действием тормозного давления. Как только алгоритм CSC фиксирует, что реальное проскальзывание внутреннего колеса (<span className="text-amber-400 font-bold">s_act</span>) приближается к критическому пиковому значению (<span className="text-amber-400 font-bold">s_crit</span>), система понимает: колесо на грани юза.</p>
          </div>
          <div>
            <h4 className="font-bold text-slate-100 mb-1">2. Коррекция давления (сброс в контуре)</h4>
            <p>Чтобы не допустить юза внутреннего колеса, алгоритм CSC задействует соленоиды гидромодулятора и превентивно сбрасывает давление в контуре разгруженного колеса. Давление на нагруженном внешнем колесе остается максимальным. Это устраняет разворачивающий момент и сохраняет курсовую устойчивость автомобиля.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// ROOT — TAB NAVIGATION
// ============================================================

export default function App() {
  const [tab, setTab] = useState<Tab>("abs");

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100" style={{ fontFamily: "'Inter', sans-serif" }}>
      <div className="container mx-auto px-4 py-8 max-w-6xl">

        {/* Header */}
        <header className="mb-6 border-b border-slate-700 pb-6">
          <h1 className="text-2xl font-bold text-white mb-1">
            Физико-математическая модель торможения автомобиля
          </h1>
          <p className="text-slate-400 text-sm">
            Расчет блокировки колес (Таблица 7 StVZO) и анализ систем активного распределения тормозных усилий CBC/CSC
          </p>
        </header>

        {/* Tab bar */}
        <div className="flex gap-1 bg-slate-800 p-1 rounded-xl mb-8 w-fit border border-slate-700">
          <button
            onClick={() => setTab("abs")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${tab === "abs" ? "bg-slate-600 text-white shadow" : "text-slate-400 hover:text-white"}`}
          >
            ABS — Блокировка колес
          </button>
          <button
            onClick={() => setTab("csc")}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${tab === "csc" ? "bg-slate-600 text-white shadow" : "text-slate-400 hover:text-white"}`}
          >
            CSC / CBC — Анализ в повороте
          </button>
        </div>

        {tab === "abs" ? <AbsModule /> : <CscModule />}

        <footer className="mt-10 text-center text-xs text-slate-600">
          Разработано на основе физических моделей тормозной динамики ТС с адаптацией справочных коэффициентов трения покоя.
        </footer>
      </div>
    </div>
  );
}
