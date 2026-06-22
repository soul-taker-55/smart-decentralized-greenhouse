// app/water-system/page.js
"use client";

import React from "react";
import {
  Droplets,
  Thermometer,
  Activity,
  Gauge,
  Beaker,
  Waves,
  RefreshCw,
  Zap,
  Sun,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Droplet,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

// --- Shared Components (same style as Climate page) ---

const StatCard = ({ icon: Icon, label, value, sub, color, trend }) => (
  <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all group">
    <div className="flex justify-between items-start mb-4">
      <div className={`p-3 rounded-2xl ${color} text-white shadow-lg`}>
        <Icon size={24} />
      </div>
      {trend && (
        <span
          className={`text-[10px] font-bold px-2 py-1 rounded-full ${
            trend === "up"
              ? "bg-orange-100 text-orange-600"
              : trend === "down"
                ? "bg-blue-100 text-blue-600"
                : "bg-green-100 text-green-600"
          }`}
        >
          {trend === "up"
            ? "↑ RISING"
            : trend === "down"
              ? "↓ FALLING"
              : "→ STABLE"}
        </span>
      )}
    </div>
    <div>
      <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
        {label}
      </p>
      <h4 className="text-2xl font-black text-slate-800 mt-1">{value}</h4>
      <div className="flex items-center gap-1 mt-1">
        <div
          className={`w-1.5 h-1.5 rounded-full ${
            sub === "Optimal" ||
            sub === "Perfect" ||
            sub === "Good" ||
            sub === "Normal"
              ? "bg-green-500"
              : sub === "Warning_High" || sub === "Warning_Low"
                ? "bg-orange-500 animate-pulse"
                : "bg-blue-500"
          }`}
        />
        <p className="text-xs text-slate-500 font-medium">
          {sub === "Warning_High"
            ? "Warning High"
            : sub === "Warning_Low"
              ? "Warning Low"
              : sub}
        </p>
      </div>
    </div>
  </div>
);

// New: Circular Gauge Component for Tank Level
const CircularGauge = ({ value, label, unit }) => {
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  const getColor = () => {
    if (value >= 70) return "#10B981";
    if (value >= 30) return "#F59E0B";
    return "#EF4444";
  };

  return (
    <div className="relative flex flex-col items-center">
      <svg width="180" height="180" className="transform -rotate-90">
        <circle
          cx="90"
          cy="90"
          r={radius}
          stroke="#E2E8F0"
          strokeWidth="12"
          fill="none"
          className="transition-all duration-500"
        />
        <circle
          cx="90"
          cy="90"
          r={radius}
          stroke={getColor()}
          strokeWidth="12"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black text-slate-800">{value}</span>
        <span className="text-xs font-semibold text-slate-400">{unit}</span>
      </div>
      <p className="text-xs font-bold text-slate-500 mt-2">{label}</p>
    </div>
  );
};

// New: Quality Metric Card with different design
const QualityMetricCard = ({
  icon: Icon,
  label,
  value,
  status,
  description,
  color,
  trend,
}) => (
  <div className="p-5 rounded-2xl bg-[#F0F4F2] border border-transparent hover:border-[#10B981] transition-all">
    <div className="flex items-start justify-between mb-3">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-xl ${color}`}>
          <Icon size={18} className="text-white" />
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            {label}
          </p>
          <div className="flex items-center gap-2">
            <p className="text-xl font-black text-slate-800">{value}</p>
            {trend && (
              <div className="flex items-center">
                {trend === "up" ? (
                  <TrendingUp size={14} className="text-orange-500" />
                ) : trend === "down" ? (
                  <TrendingDown size={14} className="text-blue-500" />
                ) : (
                  <Minus size={14} className="text-green-500" />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="text-right">
        <span
          className={`text-[10px] font-bold px-2 py-1 rounded-full ${
            status === "Perfect" || status === "Optimal"
              ? "bg-green-100 text-green-600"
              : status === "Warning"
                ? "bg-orange-100 text-orange-600"
                : "bg-blue-100 text-blue-600"
          }`}
        >
          {status}
        </span>
      </div>
    </div>
    <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
      {description}
    </p>
  </div>
);

// New: Usage History Item
const UsageHistoryItem = ({ time, amount, zone, efficiency }) => (
  <div className="flex items-center justify-between p-3 rounded-xl bg-[#F0F4F2] hover:bg-[#e8ecea] transition-colors">
    <div className="flex items-center gap-3">
      <div className="p-1.5 rounded-lg bg-[#005C3F]/10 text-[#005C3F]">
        <Clock size={14} />
      </div>
      <div>
        <p className="text-sm font-bold text-slate-800">{time}</p>
        <p className="text-[10px] text-slate-500">{zone}</p>
      </div>
    </div>
    <div className="text-right">
      <span className="text-sm font-black text-[#005C3F]">{amount} L</span>
      {efficiency && (
        <p className="text-[9px] font-semibold text-green-600">{efficiency}</p>
      )}
    </div>
  </div>
);

const InsightAlert = ({ type, title, message }) => (
  <div
    className={`p-4 rounded-2xl border-l-4 flex gap-4 ${
      type === "warning"
        ? "bg-orange-50 border-orange-200 border-l-orange-500"
        : type === "success"
          ? "bg-green-50 border-green-200 border-l-green-500"
          : "bg-blue-50 border-blue-200 border-l-blue-500"
    }`}
  >
    <div
      className={
        type === "warning"
          ? "text-orange-600"
          : type === "success"
            ? "text-green-600"
            : "text-blue-600"
      }
    >
      {type === "warning" ? (
        <AlertTriangle size={20} />
      ) : (
        <CheckCircle2 size={20} />
      )}
    </div>
    <div>
      <p className="text-sm font-bold text-slate-800 leading-none mb-1">
        {title}
      </p>
      <p className="text-xs text-slate-600 leading-relaxed">{message}</p>
    </div>
  </div>
);

// --- Main Page Component ---

export default function WaterSystemPage() {
  // Same API data structure
  const apiData = {
    house_metadata: {
      system_status: "Online",
      last_sync: "2026-04-01T23:15:00Z",
      location: "Syria - Damascus",
      firmware_version: "v2.5.0",
      uptime: "15 days, 4 hours",
    },
    water_system: {
      water_level_tank: { value: 85, unit: "%", is_filling: false },
      ph_level: { value: 6.4, status: "Perfect" },
      ec_level: { value: 1.2, unit: "mS/cm", label: "Nutrient Concentration" },
      water_temp: { value: 19.0, unit: "°C" },
      last_irrigation_total: { value: 150, unit: "Liters" },
    },
    actuators_status: {
      irrigation_pump: { state: "OFF", flow_rate: 0, next_run: "04:00 AM" },
      mister_system: { state: "OFF", tank_fluid_level: 70, unit: "%" },
    },
    energy_management: {
      solar_input: { value: 450, unit: "Watts" },
      battery_charge: { value: 92, unit: "%" },
      power_consumption: { value: 120, unit: "Watts" },
    },
    forecast: {
      outside_temp: 18.0,
      expected_rain: "Low",
      wind_speed: 12,
      unit: "km/h",
    },
  };

  // Irrigation history data
  const irrigationHistory = [
    {
      time: "04:00 AM",
      amount: 45,
      zone: "Zone A - Tomatoes",
      efficiency: "+8% moisture",
    },
    {
      time: "04:00 AM",
      amount: 35,
      zone: "Zone B - Peppers",
      efficiency: "+12% moisture",
    },
    {
      time: "04:00 AM",
      amount: 40,
      zone: "Zone C - Strawberries",
      efficiency: "+6% moisture",
    },
    {
      time: "Yesterday",
      amount: 30,
      zone: "Mister System (Humidity)",
      efficiency: "Optimal",
    },
  ];

  const totalWaterUsed = irrigationHistory.reduce(
    (sum, item) => sum + item.amount,
    0,
  );
  const tankCapacity = 1000; // Liters
  const remainingWater =
    (apiData.water_system.water_level_tank.value / 100) * tankCapacity;

  return (
    <div className="min-h-screen bg-[#F0F4F2] p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header Section */}
        <header className="flex justify-between items-end mb-8">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span>Home</span> <ChevronRight size={12} />{" "}
              <span>Water System</span>
            </nav>
            <h1 className="text-3xl font-black text-[#005C3F] tracking-tight">
              Water Management Hub
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Complete water quality monitoring and irrigation control for
              Damascus Greenhouse.
            </p>
          </div>
          <div className="hidden md:block bg-white px-4 py-2 rounded-2xl shadow-sm border border-slate-100 text-right">
            <p className="text-[10px] font-bold text-slate-400 uppercase">
              System Status
            </p>
            <p className="text-sm font-black text-[#10B981]">
              {apiData.house_metadata.system_status.toUpperCase()} & SYNCED
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Metrics (Left & Center) */}
          <div className="lg:col-span-2 space-y-8">
            {/* Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                icon={Droplets}
                label="Water Tank"
                value={`${apiData.water_system.water_level_tank.value}%`}
                sub="Available"
                color="bg-[#005C3F]"
                trend="stable"
              />
              <StatCard
                icon={Beaker}
                label="pH Level"
                value={apiData.water_system.ph_level.value}
                sub={apiData.water_system.ph_level.status}
                color="bg-[#4A6359]"
                trend="stable"
              />
              <StatCard
                icon={Thermometer}
                label="Water Temperature"
                value={`${apiData.water_system.water_temp.value}°C`}
                sub="Optimal"
                color="bg-blue-600"
                trend="stable"
              />
            </div>

            {/* Water Quality Details - New Design */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-[#005C3F]/10 text-[#005C3F] flex items-center justify-center">
                  <Activity size={18} />
                </div>
                <h3 className="text-lg font-black text-slate-800">
                  Water Quality Analysis
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <QualityMetricCard
                  icon={Beaker}
                  label="pH Level"
                  value={apiData.water_system.ph_level.value}
                  status={apiData.water_system.ph_level.status}
                  description="pH is within optimal range (6.0-7.0) for most plants. Perfect for nutrient absorption and root health."
                  color="bg-purple-500"
                  trend="stable"
                />
                <QualityMetricCard
                  icon={Gauge}
                  label="Electrical Conductivity (EC)"
                  value={`${apiData.water_system.ec_level.value} mS/cm`}
                  status="Optimal"
                  description="Nutrient concentration is ideal for vegetative growth and flowering stages. Maintain current levels."
                  color="bg-emerald-500"
                  trend="stable"
                />
              </div>
            </div>

            {/* Smart AI Insights */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                  <Waves size={18} />
                </div>
                <h3 className="text-lg font-black text-slate-800">
                  Smart AI Insights
                </h3>
              </div>

              <div className="space-y-4">
                <InsightAlert
                  type="success"
                  title="Water Quality Optimal"
                  message="pH and EC levels are perfectly balanced. Current water quality is ideal for all crop zones. No adjustments needed."
                />
                <InsightAlert
                  type="info"
                  title="Irrigation Schedule"
                  message={`Next irrigation scheduled for ${apiData.actuators_status.irrigation_pump.next_run}. Tank level at ${apiData.water_system.water_level_tank.value}% (${Math.round(remainingWater)}L remaining) is sufficient for 3-4 days.`}
                />
                {apiData.forecast.expected_rain === "Low" && (
                  <InsightAlert
                    type="warning"
                    title="Low Rain Forecast"
                    message="Expected rain is low over the next few days. Consider increasing water reserves by 15% or adjusting irrigation schedule to compensate."
                  />
                )}
              </div>
            </div>
          </div>

          {/* Right Side Panel */}
          <div className="space-y-8">
            {/* Tank Level Visualization - New Circular Gauge */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100 text-center">
              <h3 className="text-lg font-black text-[#005C3F] mb-4">
                Tank Level
              </h3>
              <CircularGauge
                value={apiData.water_system.water_level_tank.value}
                label="Current Capacity"
                unit="%"
              />
              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="flex justify-between items-center text-sm mb-2">
                  <span className="text-slate-500">Remaining Water</span>
                  <span className="font-black text-[#005C3F]">
                    {Math.round(remainingWater)} / {tankCapacity} L
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Status</span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      apiData.water_system.water_level_tank.is_filling
                        ? "bg-blue-100 text-blue-600"
                        : "bg-green-100 text-green-600"
                    }`}
                  >
                    {apiData.water_system.water_level_tank.is_filling
                      ? "Filling..."
                      : "Stable"}
                  </span>
                </div>
              </div>
            </div>

            {/* Recent Irrigation History */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-lg font-black text-[#005C3F] mb-4">
                Recent Irrigation
              </h3>
              <div className="space-y-3">
                {irrigationHistory.map((item, idx) => (
                  <UsageHistoryItem key={idx} {...item} />
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-slate-500">
                    Total Today
                  </span>
                  <span className="text-lg font-black text-[#005C3F]">
                    {totalWaterUsed} Liters
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-500">
                    Average per Zone
                  </span>
                  <span className="text-sm font-bold text-slate-700">
                    {Math.round(totalWaterUsed / 4)} L
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-lg font-black text-[#005C3F] mb-4">
                Quick Actions
              </h3>

              <div className="space-y-3">
                <button className="w-full bg-[#005C3F] hover:bg-[#064a35] text-white py-3 rounded-xl font-bold transition-all shadow-md flex items-center justify-center gap-2 text-sm">
                  <RefreshCw size={16} />
                  Run Manual Irrigation
                </button>
                <button className="w-full border-2 border-[#005C3F] text-[#005C3F] hover:bg-[#005C3F] hover:text-white py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2 text-sm">
                  <Droplets size={16} />
                  Adjust Nutrient Mix
                </button>
              </div>
            </div>

            {/* Energy Snapshot */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100">
              <p className="text-[10px] font-black text-slate-400 uppercase mb-4 tracking-widest">
                Energy Snapshot
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <Sun size={14} />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      Solar Input
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-800">
                    {apiData.energy_management.solar_input.value}W
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <div
                      className={`w-2 h-2 rounded-full ${apiData.energy_management.battery_charge.value > 50 ? "bg-green-500" : "bg-yellow-400"} ${apiData.energy_management.battery_charge.value > 50 ? "" : "animate-pulse"}`}
                    />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      Battery Charge
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-800">
                    {apiData.energy_management.battery_charge.value}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <Zap size={14} />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      Consumption
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-800">
                    {apiData.energy_management.power_consumption.value}W
                  </span>
                </div>
                <div className="pt-3 border-t border-slate-100">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-500">
                      Pump Efficiency
                    </span>
                    <span className="text-xs font-bold text-green-600">
                      94%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
