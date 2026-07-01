import React, { useState, useMemo } from 'react';

// --- КОНСТАНТЫ АВТОМОБИЛЯ (Средний класс) ---
const CAR = {
  m: 1500,       // Масса, кг
  h: 0.5,        // Высота центра тяжести, м
  L: 2.7,        // Колесная база, м
  B: 1.5,        // Ширина колеи, м
  g: 9.81,       // Ускорение свободного падения, м/с²
  s_opt: 20,     // Оптимальное продольное скольжение на прямой, %
  weightDistFront: 0.6, // Распределение статического веса на переднюю ось (60%)
  brakeDistFront: 0.65, // Распределение тормозных усилий на переднюю ось (65%)
  ay_comfort: 3.5,      // Рекомендуемый предел комфортного бокового ускорения, м/с²
};

// --- ФУНКЦИЯ ФИЗИЧЕСКИХ РАСЧЕТОВ ---
function calculateDynamicState(speedKmh, deceleration, radius, muMax) {
  const v_ms = speedKmh / 3.6; // Скорость в м/с
  
  // Рекомендуемый безопасный радиус по критерию комфортного ускорения (3.5 м/с²)
  const safeComfortRadius = (v_ms * v_ms) / CAR.ay_comfort;
  
  // Фактическое боковое ускорение
  const a_y = (v_ms * v_ms) / radius;
  const a_y_g = a_y / CAR.g;

  // Статическая нагрузка на одно переднее колесо
  const Fz_static_front = (CAR.weightDistFront * CAR.m * CAR.g) / 2;

  // Перераспределение веса при торможении (продольное)
  const deltaFz_long = (CAR.m * deceleration * CAR.h) / (2 * CAR.L);

  // Перераспределение веса при повороте (поперечное на передней оси)
  const deltaFz_lat = (CAR.weightDistFront * CAR.m * a_y * CAR.h) / CAR.B;

  // Вертикальные нагрузки на передние колеса
  let Fz_VF = Fz_static_front + deltaFz_long + deltaFz_lat;
  let Fz_VN = Fz_static_front + deltaFz_long - deltaFz_lat;

  // Физическое ограничение: колесо не может разгрузиться ниже нуля
  if (Fz_VN < 0) Fz_VN = 0;
  if (Fz_VF < 0) Fz_VF = 0;

  const Fz_front_total = Fz_VF + Fz_VN;
  const Fz_straight = Fz_static_front + deltaFz_long;

  // Потребная боковая сила на переднюю ось для удержания траектории
  const Fy_front_total_req = CAR.weightDistFront * CAR.m * a_y;
  const Fy_front_max_possible = muMax * Fz_front_total;
  const Fy_front_actual = Math.min(Fy_front_total_req, Fy_front_max_possible);

  // Максимальный потенциал сцепления каждого колеса
  const Fmax_VF = muMax * Fz_VF;
  const Fmax_VN = muMax * Fz_VN;

  // Распределение боковой силы с учетом нелинейности увода шин
  const lateralLoadRatio = Math.max(0.1, a_y_g / Math.max(0.1, muMax));
  let Fy_VF = Fy_front_actual * (0.5 + 0.12 * lateralLoadRatio);
  let Fy_VN = Fy_front_actual * (0.5 - 0.12 * lateralLoadRatio);

  if (Fy_VN > Fmax_VN) {
    const excess = Fy_VN - Fmax_VN;
    Fy_VN = Fmax_VN;
    Fy_VF = Math.min(Fmax_VF, Fy_VF + excess);
  }
  if (Fy_VF > Fmax_VF) {
    Fy_VF = Fmax_VF;
  }

  // Оставшийся продольный потенциал торможения в Ньютонах (по Камму)
  let Fx_max_VF = 0;
  if (Fmax_VF > Fy_VF) {
    Fx_max_VF = Math.sqrt(Fmax_VF * Fmax_VF - Fy_VF * Fy_VF);
  }

  let Fx_max_VN = 0;
  if (Fmax_VN > Fy_VN) {
    Fx_max_VN = Math.sqrt(Fmax_VN * Fmax_VN - Fy_VN * Fy_VN);
  }

  // Предельное продольное скольжение до блокировки
  const loadSensitivity_VF = Math.pow(Fz_VF / Fz_straight, 0.15);
  const loadSensitivity_VN = Math.pow(Fz_VN / Fz_straight, 0.15);

  const mu_x_VF = Fz_VF > 0 ? Fx_max_VF / Fz_VF : 0;
  const mu_x_VN = Fz_VN > 0 ? Fx_max_VN / Fz_VN : 0;

  const s_crit_VF = Math.max(2, CAR.s_opt * (mu_x_VF / muMax) * loadSensitivity_VF);
  const s_crit_VN = Math.max(2, CAR.s_opt * (mu_x_VN / muMax) * loadSensitivity_VN);

  // Справочная максимальная тормозная сила на прямой
  const Fx_max_straight = muMax * Fz_straight;

  // --- РАСЧЕТ РАБОТЫ ТОРМОЗНОЙ СИСТЕМЫ И CSC ---
  const Fx_front_required = CAR.m * deceleration * CAR.brakeDistFront;
  const Fx_req_per_wheel = Fx_front_required / 2;

  // Расчет фактического скольжения шины
  const calculateSlipFromForce = (Fx_req, Fx_max, s_crit) => {
    if (Fx_max <= 0 || s_crit <= 0) return 100;
    
    const forceRatio = Fx_req / Fx_max;
    
    if (forceRatio <= 0.95) {
      return s_crit * Math.pow(forceRatio, 1.8);
    } else {
      const excess = forceRatio - 0.95;
      const s_unstable = s_crit * 0.9 + (100 - s_crit * 0.9) * (1 - Math.exp(-excess * 4.5));
      return Math.min(100, s_unstable);
    }
  };

  const s_actual_VF = calculateSlipFromForce(Fx_req_per_wheel, Fx_max_VF, s_crit_VF);
  const s_actual_VN = calculateSlipFromForce(Fx_req_per_wheel, Fx_max_VN, s_crit_VN);

  // Вердикт о блокировке
  const isLocked_VF = s_actual_VF >= s_crit_VF * 1.15 || Fx_req_per_wheel >= Fx_max_VF;
  const isLocked_VN = s_actual_VN >= s_crit_VN * 1.15 || Fx_req_per_wheel >= Fx_max_VN;

  // CSC срезает избыток силы на внутреннем колесе
  const Fx_csc_safe_VN = Fx_max_VN * 0.8;
  const Fx_csc_safe_VF = Fx_max_VF * 0.9;

  const cscBrakeReductionRequired = Fx_req_per_wheel > Fx_csc_safe_VN;
  const cscForceDelta = cscBrakeReductionRequired ? (Fx_req_per_wheel - Fx_csc_safe_VN) : 0;
  
  const cscPressureReductionPercent = cscBrakeReductionRequired 
    ? Math.min(100, (cscForceDelta / Fx_req_per_wheel) * 100)
    : 0;

  const isSliding = a_y > muMax * CAR.g;
  const isWheelLifting = Fz_VN === 0;

  // Дискомфортный режим: если боковое ускорение выше комфортных 3.5 м/с²
  const isUncomfortable = a_y > CAR.ay_comfort;

  return {
    safeComfortRadius,
    a_y,
    a_y_g,
    Fz_VF,
    Fz_VN,
    Fy_VF,
    Fy_VN,
    Fmax_VF,
    Fmax_VN,
    Fx_max_VF,
    Fx_max_VN,
    Fx_max_straight,
    mu_x_VF,
    mu_x_VN,
    s_crit_VF,
    s_crit_VN,
    s_actual_VF,
    s_actual_VN,
    isLocked_VF,
    isLocked_VN,
    Fx_req_per_wheel,
    cscPressureReductionPercent,
    cscBrakeReductionRequired,
    cscForceDelta,
    isSliding,
    isWheelLifting,
    isUncomfortable,
    deltaFz_long,
    deltaFz_lat,
    Fz_static_front,
    Fz_straight,
  };
}

export default function App() {
  // --- СОСТОЯНИЕ (Входные параметры) ---
  const [speed, setSpeed] = useState(80);       // км/ч
  const [deceleration, setDeceleration] = useState(2.8); // м/с²
  const [radius, setRadius] = useState(105);     // метров
  const [muMax, setMuMax] = useState(0.65);     // Коэффициент сцепления покрытия
  const [turnDirection, setTurnDirection] = useState('left'); // 'left' или 'right'

  // Пресеты сцепления
  const muPresets = [
    { label: 'Лед (0.1)', value: 0.1 },
    { label: 'Мокрый снег (0.3)', value: 0.3 },
    { label: 'Мокрый асфальт (0.5)', value: 0.5 },
    { label: 'Влажный асфальт (0.65)', value: 0.65 },
    { label: 'Сухой асфальт (0.85)', value: 0.85 },
  ];

  // --- РАСЧЕТ ДЛЯ ТЕКУЩЕГО СОСТОЯНИЯ ---
  const calculations = useMemo(() => {
    return calculateDynamicState(speed, deceleration, radius, muMax);
  }, [speed, deceleration, radius, muMax]);

  // --- РАСЧЕТ ДАННЫХ ТАБЛИЦЫ ---
  const tableData = useMemo(() => {
    const baseSpeeds = [30, 50, 70, 90, 110, 130, 150];
    const mergedSpeeds = Array.from(new Set([...baseSpeeds, speed])).sort((a, b) => a - b);

    return mergedSpeeds.map((v) => {
      const state = calculateDynamicState(v, deceleration, radius, muMax);
      return {
        speedValue: v,
        s_crit_VF: state.s_crit_VF,
        s_crit_VN: state.s_crit_VN,
        s_actual_VF: state.s_actual_VF,
        s_actual_VN: state.s_actual_VN,
        isLocked_VN: state.isLocked_VN,
        isLocked_VF: state.isLocked_VF,
        cscReduction: state.cscPressureReductionPercent,
        isCurrent: v === speed,
        isUncomfortable: state.isUncomfortable,
        isSliding: state.isSliding,
      };
    });
  }, [speed, deceleration, radius, muMax]);

  const setOptimalRadius = () => {
    const v_ms = speed / 3.6;
    const safeR = Math.ceil((v_ms * v_ms) / CAR.ay_comfort);
    setRadius(Math.max(15, Math.min(500, safeR)));
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Шапка */}
        <header className="border-b border-slate-800 pb-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-2">
              <span className="text-emerald-500">🏎️</span> 
              Анализатор Систем CBC / CSC
            </h1>
            <p className="text-slate-400 mt-1 text-sm">
              Интерактивная модель распределения тормозных усилий в повороте и предотвращения заноса передней оси
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setTurnDirection('left')}
              className={`px-4 py-2 rounded-lg font-semibold text-sm transition-all ${
                turnDirection === 'left' 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/30' 
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              🔄 Поворот Налево
            </button>
            <button
              onClick={() => setTurnDirection('right')}
              className={`px-4 py-2 rounded-lg font-semibold text-sm transition-all ${
                turnDirection === 'right' 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/30' 
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              🔄 Поворот Направо
            </button>
          </div>
        </header>

        {/* Предупреждения о физических лимитах и уровне комфорта */}
        {calculations.isSliding && (
          <div className="bg-rose-950 border border-rose-500/50 text-rose-200 px-4 py-3 rounded-xl flex items-center gap-3 animate-pulse">
            <span className="text-2xl">⚠️</span>
            <div>
              <strong className="font-bold">Критический снос оси!</strong> Автомобиль не может удержаться на дуге поворота. Поперечное ускорение ({calculations.a_y_g.toFixed(2)}g) превышает физический предел сцепления ({muMax}g).
            </div>
          </div>
        )}
        {!calculations.isSliding && calculations.isUncomfortable && (
          <div className="bg-amber-950/60 border border-amber-500/30 text-amber-200 px-4 py-3 rounded-xl flex items-center gap-3">
            <span className="text-2xl">🤢</span>
            <div>
              <strong className="font-bold">Превышен порог комфортного вождения!</strong> Боковое ускорение ({calculations.a_y.toFixed(2)} м/с²) выше рекомендуемых производителем {CAR.ay_comfort} м/с² для гражданских поездок. Сильные крены кузова и сдвиг порогов блокировки!
            </div>
          </div>
        )}

        {/* Прямой ответ на вопрос пользователя (Сводная панель вердикта) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* Вердикт по внутреннему колесу */}
          <div className={`rounded-2xl p-5 border shadow-lg transition-all duration-300 ${
            calculations.isLocked_VN 
              ? 'bg-rose-950/80 border-rose-500 text-rose-100' 
              : 'bg-slate-800/90 border-slate-700 text-slate-100'
          }`}>
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Внутреннее колесо (VN)</h3>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                calculations.isLocked_VN ? 'bg-rose-500 text-white animate-pulse' : 'bg-emerald-500/10 text-emerald-400'
              }`}>
                {calculations.isLocked_VN ? '🚨 БЛОКИРОВКА!' : '✅ СТАБИЛЬНО'}
              </span>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span>Порог скольжения (s_crit):</span>
                <span className="font-mono font-bold text-amber-400">{calculations.s_crit_VN.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span>Скольжение без CSC (s_act):</span>
                <span className={`font-mono font-bold ${calculations.isLocked_VN ? 'text-rose-400 font-extrabold' : 'text-slate-300'}`}>
                  {calculations.s_actual_VN.toFixed(1)}% {calculations.isLocked_VN && "(Глубокий Срыв)"}
                </span>
              </div>
              <div className="border-t border-slate-700/50 pt-2 mt-2 flex justify-between text-[11px] text-slate-400">
                <span>Запрос тормозов: {calculations.Fx_req_per_wheel.toFixed(0)} Н</span>
                <span>Предел сцепления: {calculations.Fx_max_VN.toFixed(0)} Н</span>
              </div>
            </div>
          </div>

          {/* Вердикт по внешнему колесу */}
          <div className="bg-slate-800/90 border border-slate-700 rounded-2xl p-5 shadow-lg">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Внешнее колесо (VF)</h3>
              <span className="bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full text-xs font-bold">
                ✅ СТАБИЛЬНО
              </span>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span>Порог скольжения (s_crit):</span>
                <span className="font-mono font-bold text-emerald-400">{calculations.s_crit_VF.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span>Скольжение без CSC (s_act):</span>
                <span className="font-mono font-bold text-slate-300">{calculations.s_actual_VF.toFixed(1)}%</span>
              </div>
              <div className="border-t border-slate-700/50 pt-2 mt-2 flex justify-between text-[11px] text-slate-400">
                <span>Запрос тормозов: {calculations.Fx_req_per_wheel.toFixed(0)} Н</span>
                <span>Предел сцепления: {calculations.Fx_max_VF.toFixed(0)} Н</span>
              </div>
            </div>
          </div>

          {/* Режим работы и реакция CSC */}
          <div className={`rounded-2xl p-5 border shadow-lg transition-all duration-300 ${
            calculations.cscBrakeReductionRequired 
              ? 'bg-blue-950/80 border-blue-500 text-blue-100' 
              : 'bg-slate-800/90 border-slate-700 text-slate-100'
          }`}>
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Реакция системы CSC</h3>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                calculations.cscBrakeReductionRequired ? 'bg-blue-500 text-white' : 'bg-slate-700 text-slate-400'
              }`}>
                {calculations.cscBrakeReductionRequired ? '⚡ АКТИВНА' : '⏸️ РЕЖИМ ОЖИДАНИЯ'}
              </span>
            </div>
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span>Сброс давления на VN:</span>
                <span className="font-mono font-bold text-blue-400">
                  {calculations.cscPressureReductionPercent > 0 
                    ? `Снизить на ${calculations.cscPressureReductionPercent.toFixed(0)}%` 
                    : 'Не требуется'}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span>Необходимая дельта сил (Δ Fx):</span>
                <span className="font-mono font-bold text-slate-300">
                  {calculations.cscForceDelta > 0 ? `${calculations.cscForceDelta.toFixed(0)} Н` : '0 Н'}
                </span>
              </div>
              <div className="border-t border-slate-700/50 pt-2 mt-2 text-[10px] text-slate-400 leading-tight">
                {calculations.cscBrakeReductionRequired 
                  ? 'CSC превентивно ослабляет внутренний тормозной контур, удерживая колесо от юза.'
                  : 'Запас сцепления внутреннего колеса достаточен для безопасного замедления ТС.'}
              </div>
            </div>
          </div>

        </div>

        {/* Основной интерфейс: слайдеры и графики */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Слайдеры управления */}
          <div className="lg:col-span-4 bg-slate-800/80 backdrop-blur border border-slate-700 p-6 rounded-2xl space-y-6">
            <h2 className="text-lg font-bold text-white border-b border-slate-700 pb-2">Параметры симуляции</h2>
            
            {/* Скорость */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-300">Начальная скорость:</span>
                <span className="font-mono text-emerald-400 font-bold">{speed} км/ч</span>
              </div>
              <input
                type="range"
                min="20"
                max="185"
                step="5"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>

            {/* Замедление */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-300">Замедление торможения:</span>
                <span className="font-mono text-rose-400 font-bold">{deceleration.toFixed(1)} м/с²</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="8.5"
                step="0.1"
                value={deceleration}
                onChange={(e) => setDeceleration(Number(e.target.value))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-rose-500"
              />
            </div>

            {/* Радиус */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-300">Радиус поворота:</span>
                <span className="font-mono text-blue-400 font-bold">{radius} м</span>
              </div>
              <input
                type="range"
                min="15"
                max="350"
                step="5"
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
              <button
                onClick={setOptimalRadius}
                className="text-xs bg-slate-700 hover:bg-slate-600 text-blue-300 px-2 py-1 rounded transition-colors w-full"
              >
                Установить комфортный радиус (~{Math.ceil(calculations.safeComfortRadius)}м)
              </button>
            </div>

            {/* Сцепление с дорогой */}
            <div className="space-y-3">
              <label className="text-sm text-slate-300 block">Коэффициент сцепления покрытия (mu_max):</label>
              <div className="flex flex-wrap gap-2">
                {muPresets.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setMuMax(p.value)}
                    className={`text-[11px] px-2 py-1 rounded border transition-all ${
                      Math.abs(muMax - p.value) < 0.01
                        ? 'bg-slate-100 text-slate-900 border-white font-semibold'
                        : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

          </div>

          {/* Правая панель с визуализацией */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* График зависимости силы от скольжения с демонстрацией блокировки */}
            <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-bold text-white">Тормозное усилие и зоны проскальзывания шин</h3>
                <span className="text-xs text-slate-400">Штрихпунктиром показан порог срыва (блокировки)</span>
              </div>
              
              <div className="w-full">
                <svg viewBox="0 0 500 200" className="w-full h-auto overflow-visible">
                  {/* Базовые оси */}
                  <line x1="50" y1="170" x2="480" y2="170" stroke="#475569" strokeWidth="1.5" />
                  <line x1="50" y1="20" x2="50" y2="170" stroke="#475569" strokeWidth="1.5" />

                  <text x="480" y="185" fill="#94a3b8" fontSize="10" textAnchor="end">Скольжение шины (%)</text>
                  <text x="45" y="15" fill="#94a3b8" fontSize="10" textAnchor="start">Тормозная сила Fx (Н)</text>

                  {/* Автоматически вычисляемая шкала Y */}
                  {(() => {
                    const maxPossibleForce = Math.max(calculations.Fx_max_VF, calculations.Fx_max_straight, 2000);
                    const yMaxScale = Math.ceil(maxPossibleForce / 1000) * 1000;
                    
                    // Расчет координат Y для текущего запроса тормозов
                    const yBrakeReq = 170 - ((calculations.Fx_req_per_wheel / yMaxScale) * 140);
                    
                    return (
                      <>
                        {/* Сетка скольжения */}
                        {[0, 10, 20, 30, 40, 50].map((s) => {
                          const x = 50 + s * 8.2;
                          return (
                            <g key={s}>
                              <line x1={x} y1="170" x2={x} y2="175" stroke="#475569" strokeWidth="1" />
                              <text x={x} y="190" fill="#64748b" fontSize="9" textAnchor="middle">{s}%</text>
                            </g>
                          );
                        })}

                        {/* Сетка forces по Y */}
                        {[0, 0.5, 1.0].map((ratio) => {
                          const forceVal = yMaxScale * ratio;
                          const y = 170 - (ratio * 140);
                          return (
                            <g key={ratio}>
                              <line x1="45" y1={y} x2="480" y2={y} stroke="#1e293b" strokeWidth="1" strokeDasharray="2 2" />
                              <text x="40" y={y + 3} fill="#64748b" fontSize="9" textAnchor="end">{forceVal.toFixed(0)}</text>
                            </g>
                          );
                        })}

                        {/* Линия требуемой тормозной силы от педали */}
                        <line x1="50" y1={yBrakeReq} x2="480" y2={yBrakeReq} stroke="#f43f5e" strokeWidth="2" strokeDasharray="4 4" />
                        <text x="470" y={yBrakeReq - 6} fill="#f43f5e" fontSize="9" fontWeight="bold" textAnchor="end">
                          Давление педали: {calculations.Fx_req_per_wheel.toFixed(0)} Н
                        </text>

                        {/* Кривая внешнего колеса VF */}
                        <path
                          d={(() => {
                            let points = [];
                            const optSlip = calculations.s_crit_VF;
                            for (let s = 0; s <= 50; s += 2) {
                              const x = 50 + s * 8.2;
                              const factor = optSlip > 0 ? s / optSlip : 0;
                              const currentForce = calculations.Fx_max_VF * (factor > 0 ? (2 * factor / (1 + factor * factor)) : 0);
                              const y = 170 - ((currentForce / yMaxScale) * 140);
                              points.push(`${s === 0 ? 'M' : 'L'} ${x} ${y}`);
                            }
                            return points.join(' ');
                          })()}
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="3"
                        />

                        {/* Кривая внутреннего колеса VN */}
                        <path
                          d={(() => {
                            let points = [];
                            const optSlip = calculations.s_crit_VN;
                            for (let s = 0; s <= 50; s += 2) {
                              const x = 50 + s * 8.2;
                              const factor = optSlip > 0 ? s / optSlip : 0;
                              const currentForce = calculations.Fx_max_VN * (factor > 0 ? (2 * factor / (1 + factor * factor)) : 0);
                              const y = 170 - ((currentForce / yMaxScale) * 140);
                              points.push(`${s === 0 ? 'M' : 'L'} ${x} ${y}`);
                            }
                            return points.join(' ');
                          })()}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth="3"
                        />

                        {/* Метка рабочей точки внешнего колеса */}
                        {!calculations.isLocked_VF && (
                          <g>
                            <circle 
                              cx={50 + calculations.s_actual_VF * 8.2} 
                              cy={yBrakeReq} 
                              r="6" 
                              fill="#10b981" 
                              stroke="#fff" 
                              strokeWidth="2" 
                            />
                            <text 
                              x={50 + calculations.s_actual_VF * 8.2} 
                              y={yBrakeReq - 10} 
                              fill="#10b981" 
                              fontSize="10" 
                              fontWeight="bold" 
                              textAnchor="middle"
                            >
                              VF: {calculations.s_actual_VF.toFixed(1)}%
                            </text>
                          </g>
                        )}

                        {/* Метка рабочей точки внутреннего колеса */}
                        {calculations.isLocked_VN ? (
                          <g>
                            <circle cx="460" cy="170" r="7" fill="#ef4444" stroke="#fff" strokeWidth="2" />
                            <text x="460" y="155" fill="#ef4444" fontSize="10" fontWeight="extrabold" textAnchor="middle">
                              VN ЮЗ!
                            </text>
                          </g>
                        ) : (
                          <g>
                            <circle 
                              cx={50 + calculations.s_actual_VN * 8.2} 
                              cy={yBrakeReq} 
                              r="6" 
                              fill="#f59e0b" 
                              stroke="#fff" 
                              strokeWidth="2" 
                            />
                            <text 
                              x={50 + calculations.s_actual_VN * 8.2} 
                              y={yBrakeReq - 10} 
                              fill="#f59e0b" 
                              fontSize="10" 
                              fontWeight="bold" 
                              textAnchor="middle"
                            >
                              VN: {calculations.s_actual_VN.toFixed(1)}%
                            </text>
                          </g>
                        )}
                      </>
                    );
                  })()}
                </svg>
              </div>

              {/* Легенда */}
              <div className="flex gap-4 justify-center mt-3 text-xs text-slate-400">
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-500 rounded-full"></span> Внешняя рабочая точка скольжения</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-amber-500 rounded-full"></span> Внутренняя рабочая точка скольжения</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-rose-500 rounded-full"></span> Глубокий срыв сцепления</span>
              </div>

            </div>

            {/* ТАБЛИЦА С КОНКРЕТНЫМИ ОТВЕТАМИ ДЛЯ АЛГОРИТМА CSC */}
            <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6">
              <h3 className="text-lg font-bold text-white mb-2">Анализ работы CSC по диапазону скоростей</h3>
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
                      const hasCscReduction = row.cscReduction > 0;
                      return (
                        <tr 
                          key={row.speedValue}
                          className={`transition-colors hover:bg-slate-700/30 ${
                            row.isCurrent ? 'bg-blue-600/10 border-l-4 border-l-blue-500 text-white font-bold' : 'text-slate-300'
                          }`}
                        >
                          <td className="py-3 px-4">
                            {row.speedValue} км/ч {row.isCurrent && "📍"}
                          </td>
                          <td className="py-3 px-4 text-emerald-400">
                            {row.s_crit_VF.toFixed(1)}% / <span className="font-bold">{row.s_actual_VF.toFixed(1)}%</span>
                          </td>
                          <td className="py-3 px-4 text-amber-400">
                            {row.s_crit_VN.toFixed(1)}% / {' '}
                            <span className={row.isLocked_VN ? "text-rose-400 font-bold" : "font-bold"}>
                              {row.s_actual_VN.toFixed(1)}% {row.isLocked_VN && "(Срыв)"}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-blue-300">
                            {deltaCrit.toFixed(1)}%
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-col gap-0.5 font-sans text-xs">
                              {row.isSliding ? (
                                <span className="text-rose-400 font-extrabold">🚨 СНОС ОСИ</span>
                              ) : row.isUncomfortable ? (
                                <span className="text-amber-400 font-semibold">⚠️ ПРЕВЫШЕН 3.5 м/с²</span>
                              ) : (
                                <span className="text-emerald-400">🟢 КОМФОРТНО</span>
                              )}
                              {hasCscReduction && (
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

        {/* Раздел: как работает алгоритм CSC/CBC */}
        <section className="bg-slate-800/80 border border-slate-700 rounded-2xl p-6 space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <span>ℹ️</span> Как работает алгоритм CSC (Cornering Stability Control)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-slate-300 leading-relaxed">
            <div>
              <h4 className="font-bold text-slate-100 mb-1">1. Распознавание дефицита сцепления</h4>
              <p>
                Блок управления тормозной системой постоянно вычисляет угловые скорости колес. В повороте внутреннее колесо разгружается и начинает скользить сильнее под действием тормозного давления. Как только алгоритм CSC фиксирует, что реальное проскальзывание внутреннего колеса (<span className="text-amber-400 font-bold">s_act</span>) приближается к критическому пиковому значению (<span className="text-amber-400 font-bold">s_crit</span>), система понимает: **колесо на грани юза**.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-slate-100 mb-1">2. Коррекция давления (сброс в контуре)</h4>
              <p>
                Чтобы не допустить юза внутреннего колеса, алгоритм CSC задействует соленоиды гидромодулятора и **превентивно сбрасывает давление** в контуре разгруженного колеса (на графике показана расчетная величина в %). Давление на нагруженном внешнем колесе остается максимальным. Это устраняет разворачивающий момент и сохраняет курсовую устойчивость автомобиля.
              </p>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}