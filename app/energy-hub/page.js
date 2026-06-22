// app/energy-hub/page.js
"use client";

import React from "react";
import {
  Zap,
  Activity,
  Power,
  Sun,
  Battery,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Gauge,
  Leaf,
  BarChart3,
  PieChart,
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
              ? "bg-green-100 text-green-600"
              : trend === "down"
                ? "bg-orange-100 text-orange-600"
                : "bg-blue-100 text-blue-600"
          }`}
        >
          {trend === "up" ? "↑ +12%" : trend === "down" ? "↓ -5%" : "→ STABLE"}
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
            sub === "Optimal" || sub === "Good" || sub === "Charged"
              ? "bg-green-500"
              : sub === "Warning" || sub === "Low"
                ? "bg-orange-500 animate-pulse"
                : "bg-blue-500"
          }`}
        />
        <p className="text-xs text-slate-500 font-medium">{sub}</p>
      </div>
    </div>
  </div>
);

// New: Battery Gauge Component
const BatteryGauge = ({ value, isCharging }) => {
  const getBatteryColor = () => {
    if (value >= 70) return "from-green-500 to-green-600";
    if (value >= 30) return "from-yellow-500 to-amber-500";
    return "from-red-500 to-red-600";
  };

  return (
    <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-[#005C3F] text-white shadow-lg">
            <Battery size={20} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Battery Status
            </p>
            <p className="text-2xl font-black text-slate-800">{value}%</p>
          </div>
        </div>
        {isCharging && (
          <div className="flex items-center gap-1 text-[10px] font-bold text-green-600 bg-green-50 px-2 py-1 rounded-full">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            CHARGING
          </div>
        )}
      </div>

      {/* Battery Visualization */}
      <div className="relative mt-4 mb-2">
        <div className="w-full bg-slate-200 h-24 rounded-2xl overflow-hidden border-2 border-slate-300 relative">
          <div
            className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t ${getBatteryColor()} transition-all duration-700 ease-out`}
            style={{ height: `${value}%` }}
          >
            <div className="absolute top-2 left-0 right-0 flex justify-center">
              <div className="w-8 h-1 bg-white/30 rounded-full" />
            </div>
          </div>
        </div>
        <div className="absolute -top-2 left-1/2 transform -translate-x-1/2 w-6 h-2 bg-slate-400 rounded-t-md" />
      </div>

      <div className="flex justify-between mt-3 text-[10px] font-semibold text-slate-400">
        <span>Empty</span>
        <span>{value}% Charged</span>
        <span>Full</span>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-100">
        <div className="flex justify-between items-center text-sm">
          <span className="text-slate-500">Estimated Runtime</span>
          <span className="font-black text-[#005C3F]">
            {Math.floor((value / 20) * 8)} hours
          </span>
        </div>
      </div>
    </div>
  );
};

// New: Energy Flow Card
const EnergyFlowCard = ({
  title,
  value,
  unit,
  icon: Icon,
  color,
  percentage,
}) => (
  <div className="p-4 rounded-2xl bg-[#F0F4F2] border border-transparent hover:border-[#10B981] transition-all">
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-lg ${color}`}>
          <Icon size={14} className="text-white" />
        </div>
        <span className="text-xs font-semibold text-slate-500">{title}</span>
      </div>
      {percentage && (
        <span className="text-[10px] font-bold text-slate-400">
          {percentage}
        </span>
      )}
    </div>
    <div className="flex items-baseline justify-between">
      <span className="text-xl font-black text-slate-800">
        {value}{" "}
        <span className="text-xs font-normal text-slate-400">{unit}</span>
      </span>
      {percentage && (
        <div className="w-16 bg-slate-200 h-1.5 rounded-full overflow-hidden">
          <div
            className="bg-[#005C3F] h-full rounded-full"
            style={{ width: percentage }}
          />
        </div>
      )}
    </div>
  </div>
);

// New: Usage Timeline Item
const UsageTimelineItem = ({ time, device, consumption, percentage }) => (
  <div className="flex items-center justify-between p-3 rounded-xl bg-[#F0F4F2] hover:bg-[#e8ecea] transition-colors">
    <div className="flex items-center gap-3">
      <div className="p-1.5 rounded-lg bg-[#005C3F]/10 text-[#005C3F]">
        <Clock size={14} />
      </div>
      <div>
        <p className="text-sm font-bold text-slate-800">{time}</p>
        <p className="text-[10px] text-slate-500">{device}</p>
      </div>
    </div>
    <div className="text-right">
      <span className="text-sm font-black text-[#005C3F]">{consumption} W</span>
      <p className="text-[9px] font-semibold text-slate-400">
        {percentage} of total
      </p>
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

export default function EnergyHubPage() {
  // Same API data structure
  const apiData = {
    house_metadata: {
      system_status: "Online",
      last_sync: "2026-04-01T23:15:00Z",
      location: "Syria - Damascus",
      firmware_version: "v2.5.0",
      uptime: "15 days, 4 hours",
    },
    energy_management: {
      solar_input: { value: 450, unit: "Watts" },
      battery_charge: { value: 92, unit: "%" },
      power_consumption: { value: 120, unit: "Watts" },
    },
    actuators_status: {
      cooling_fans: { state: "ON", speed: "Medium", rpm: 1200 },
      irrigation_pump: { state: "OFF", flow_rate: 0, next_run: "04:00 AM" },
      grow_lights: { state: "OFF", intensity: 0, color_spectrum: "Full" },
      windows: { state: "Closed", opening_percentage: 0, auto_mode: true },
    },
    environmental_sensors: {
      temperature: { value: 24.5, unit: "°C", status: "Optimal" },
      light_intensity: { value: 12000, unit: "Lux" },
    },
    forecast: {
      outside_temp: 18.0,
      expected_rain: "Low",
      wind_speed: 12,
      unit: "km/h",
    },
  };

  // Calculate derived metrics
  const totalCapacity = 5000; // Watt-hours
  const storedEnergy =
    (apiData.energy_management.battery_charge.value / 100) * totalCapacity;
  const netEfficiency =
    apiData.energy_management.solar_input.value > 0
      ? ((apiData.energy_management.solar_input.value -
          apiData.energy_management.power_consumption.value) /
          apiData.energy_management.solar_input.value) *
        100
      : 0;

  // Device consumption breakdown
  const deviceConsumption = [
    { device: "Cooling Fans", consumption: 45, percentage: "38%" },
    { device: "Irrigation Pump", consumption: 35, percentage: "29%" },
    { device: "Control System", consumption: 25, percentage: "21%" },
    { device: "Sensors & Network", consumption: 15, percentage: "12%" },
  ];

  const usageTimeline = [
    {
      time: "00:00 - 04:00",
      device: "Night Mode",
      consumption: 45,
      percentage: "8%",
    },
    {
      time: "04:00 - 08:00",
      device: "Irrigation + Fans",
      consumption: 180,
      percentage: "32%",
    },
    {
      time: "08:00 - 12:00",
      device: "Peak Solar",
      consumption: 210,
      percentage: "38%",
    },
    {
      time: "12:00 - 16:00",
      device: "High Activity",
      consumption: 195,
      percentage: "35%",
    },
    {
      time: "16:00 - 20:00",
      device: "Evening Mode",
      consumption: 120,
      percentage: "22%",
    },
    {
      time: "20:00 - 00:00",
      device: "Low Power",
      consumption: 65,
      percentage: "12%",
    },
  ];

  const totalDailyConsumption = usageTimeline.reduce((sum, item) => {
    const avgConsumption = item.consumption;
    return sum + avgConsumption * 4;
  }, 0);

  const solarProductionToday = apiData.energy_management.solar_input.value * 8; // Assume 8 hours effective solar

  return (
    <div className="min-h-screen bg-[#F0F4F2] p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header Section */}
        <header className="flex justify-between items-end mb-8">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span>Home</span> <ChevronRight size={12} />{" "}
              <span>Energy Hub</span>
            </nav>
            <h1 className="text-3xl font-black text-[#005C3F] tracking-tight">
              Energy Management Hub
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Real-time energy monitoring and optimization for Damascus
              Greenhouse.
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
                icon={Sun}
                label="Solar Input"
                value={`${apiData.energy_management.solar_input.value}W`}
                sub="Active"
                color="bg-[#005C3F]"
                trend="up"
              />
              <StatCard
                icon={Battery}
                label="Battery"
                value={`${apiData.energy_management.battery_charge.value}%`}
                sub="Charged"
                color="bg-[#4A6359]"
                trend="stable"
              />
              <StatCard
                icon={Zap}
                label="Consumption"
                value={`${apiData.energy_management.power_consumption.value}W`}
                sub="Current Load"
                color="bg-slate-800"
                trend="down"
              />
            </div>

            {/* Energy Flow Distribution */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-[#005C3F]/10 text-[#005C3F] flex items-center justify-center">
                  <PieChart size={18} />
                </div>
                <h3 className="text-lg font-black text-slate-800">
                  Energy Flow Distribution
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <EnergyFlowCard
                  icon={Sun}
                  title="Solar Generation"
                  value={apiData.energy_management.solar_input.value}
                  unit="W"
                  color="bg-amber-500"
                  percentage="100%"
                />
                <EnergyFlowCard
                  icon={Battery}
                  title="Battery Storage"
                  value={`${storedEnergy.toFixed(0)}`}
                  unit="Wh"
                  color="bg-green-500"
                  percentage={`${apiData.energy_management.battery_charge.value}%`}
                />
                <EnergyFlowCard
                  icon={Zap}
                  title="Active Consumption"
                  value={apiData.energy_management.power_consumption.value}
                  unit="W"
                  color="bg-blue-500"
                  percentage={`${Math.round((apiData.energy_management.power_consumption.value / apiData.energy_management.solar_input.value) * 100)}%`}
                />
                <EnergyFlowCard
                  icon={Gauge}
                  title="Grid Export (Net)"
                  value={netEfficiency > 0 ? netEfficiency.toFixed(0) : 0}
                  unit="W"
                  color="bg-purple-500"
                  percentage={
                    netEfficiency > 0 ? `${netEfficiency.toFixed(0)}%` : "0%"
                  }
                />
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-500">
                    System Efficiency
                  </span>
                  <span className="text-sm font-black text-green-600">
                    {netEfficiency > 0 ? `${netEfficiency.toFixed(1)}%` : "0%"}{" "}
                    Net Positive
                  </span>
                </div>
              </div>
            </div>

            {/* Smart AI Insights */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                  <Activity size={18} />
                </div>
                <h3 className="text-lg font-black text-slate-800">
                  Smart AI Insights
                </h3>
              </div>

              <div className="space-y-4">
                <InsightAlert
                  type="success"
                  title="Energy Positive Status"
                  message={`Solar production (${apiData.energy_management.solar_input.value}W) exceeds current consumption (${apiData.energy_management.power_consumption.value}W). Battery is charging efficiently.`}
                />
                <InsightAlert
                  type="info"
                  title="Optimization Suggestion"
                  message={`External temperature is ${apiData.forecast.outside_temp}°C. Consider increasing window ventilation during peak solar hours to reduce cooling fan load by ~15%.`}
                />
                {apiData.energy_management.battery_charge.value > 80 && (
                  <InsightAlert
                    type="success"
                    title="Battery Health Excellent"
                    message="Battery is at optimal charge level. System is ready for nighttime operations or cloudy conditions."
                  />
                )}
              </div>
            </div>
          </div>

          {/* Right Side Panel */}
          <div className="space-y-8">
            {/* Battery Gauge Visualization */}
            <BatteryGauge
              value={apiData.energy_management.battery_charge.value}
              isCharging={
                apiData.energy_management.solar_input.value >
                apiData.energy_management.power_consumption.value
              }
            />

            {/* Device Consumption Breakdown */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-lg font-black text-[#005C3F] mb-4">
                Device Consumption
              </h3>
              <div className="space-y-3">
                {deviceConsumption.map((device, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 rounded-xl hover:bg-[#F0F4F2] transition-colors"
                  >
                    <span className="text-sm font-medium text-slate-600">
                      {device.device}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-black text-slate-800">
                        {device.consumption} W
                      </span>
                      <span className="text-[10px] font-semibold text-slate-400 w-10 text-right">
                        {device.percentage}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-500">
                    Total Active Load
                  </span>
                  <span className="text-sm font-black text-[#005C3F]">
                    {deviceConsumption.reduce(
                      (sum, d) => sum + d.consumption,
                      0,
                    )}{" "}
                    W
                  </span>
                </div>
              </div>
            </div>

            {/* Usage Timeline */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100">
              <h3 className="text-lg font-black text-[#005C3F] mb-4">
                Daily Usage Timeline
              </h3>
              <div className="space-y-2">
                {usageTimeline.slice(0, 4).map((item, idx) => (
                  <UsageTimelineItem key={idx} {...item} />
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-slate-500">
                    Total Daily
                  </span>
                  <span className="text-lg font-black text-[#005C3F]">
                    {Math.round(totalDailyConsumption / 1000)} kWh
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-500">
                    Solar Production Today
                  </span>
                  <span className="text-sm font-bold text-green-600">
                    {Math.round(solarProductionToday / 1000)} kWh
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
                  <Leaf size={16} />
                  Optimize Energy Mode
                </button>
                <button className="w-full border-2 border-[#005C3F] text-[#005C3F] hover:bg-[#005C3F] hover:text-white py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2 text-sm">
                  <BarChart3 size={16} />
                  View Detailed Report
                </button>
              </div>
            </div>

            {/* Environmental Impact */}
            <div className="bg-white rounded-[2.5rem] p-6 shadow-sm border border-slate-100">
              <p className="text-[10px] font-black text-slate-400 uppercase mb-4 tracking-widest">
                Environmental Impact
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <Leaf size={14} className="text-green-600" />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      CO₂ Saved Today
                    </span>
                  </div>
                  <span className="text-xs font-bold text-green-600">
                    ~2.4 kg
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <Sun size={14} className="text-amber-500" />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      Clean Energy Share
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-800">
                    100% Solar
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <Activity size={14} className="text-blue-500" />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      Grid Independence
                    </span>
                  </div>
                  <span className="text-xs font-bold text-slate-800">94%</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
