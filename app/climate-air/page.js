// app/climate-air/page.js
"use client";

import React from "react";
import {
  Thermometer,
  Droplets,
  Activity,
  Wind,
  Fan,
  Monitor,
  CloudRain,
  Lightbulb,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
} from "lucide-react";

// --- Components الصغيره ---

const StatCard = ({ icon: Icon, label, value, sub, color, trend }) => (
  <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all group">
    <div className="flex justify-between items-start mb-4">
      <div className={`p-3 rounded-2xl ${color} text-white shadow-lg`}>
        <Icon size={24} />
      </div>
      {trend && (
        <span
          className={`text-[10px] font-bold px-2 py-1 rounded-full ${trend === "Rising" ? "bg-orange-100 text-orange-600" : "bg-blue-100 text-blue-600"}`}
        >
          {trend === "Rising" ? "↑ RISING" : "↓ STABLE"}
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
          className={`w-1.5 h-1.5 rounded-full ${sub === "Optimal" || sub === "Normal" ? "bg-green-500" : "bg-orange-500 animate-pulse"}`}
        />
        <p className="text-xs text-slate-500 font-medium">{sub}</p>
      </div>
    </div>
  </div>
);

const ActuatorToggle = ({ icon: Icon, label, status, detail, isActive }) => (
  <div className="flex items-center justify-between p-4 rounded-2xl bg-[#F0F4F2] border border-transparent hover:border-[#10B981] transition-all">
    <div className="flex items-center gap-4">
      <div
        className={`p-2 rounded-xl ${isActive ? "bg-[#005C3F] text-white" : "bg-white text-slate-400 shadow-sm"}`}
      >
        <Icon size={20} />
      </div>
      <div>
        <p className="text-sm font-bold text-slate-800">{label}</p>
        <p className="text-[11px] text-slate-500 font-medium">{detail}</p>
      </div>
    </div>
    <div
      className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter ${isActive ? "bg-[#10B981] text-white" : "bg-slate-200 text-slate-500"}`}
    >
      {status}
    </div>
  </div>
);

const InsightAlert = ({ type, title, message }) => (
  <div
    className={`p-4 rounded-2xl border-l-4 flex gap-4 ${type === "warning" ? "bg-orange-50 border-orange-200 border-l-orange-500" : "bg-blue-50 border-blue-200 border-l-blue-500"}`}
  >
    <div className={type === "warning" ? "text-orange-600" : "text-blue-600"}>
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

// --- الصفحة الأساسية ---

export default function ClimateAirPage() {
  const data = {
    env: { temp: 24.5, hum: 62, co2: 415, aqi: 45, humTrend: "Rising" },
    actuators: {
      fans: { state: "ON", detail: "1200 RPM - Medium" },
      windows: { state: "CLOSED", detail: "0% Opening" },
      mister: { state: "OFF", detail: "Tank Level: 70%" },
    },
  };

  return (
    <div className="min-h-screen bg-[#F0F4F2] p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header Section */}
        <header className="flex justify-between items-end mb-8">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span>Home</span> <ChevronRight size={12} />{" "}
              <span>Climate & Air</span>
            </nav>
            <h1 className="text-3xl font-black text-[#005C3F] tracking-tight">
              Climate Control Hub
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Real-time environmental management for Damascus Greenhouse.
            </p>
          </div>
          <div className="hidden md:block bg-white px-4 py-2 rounded-2xl shadow-sm border border-slate-100 text-right">
            <p className="text-[10px] font-bold text-slate-400 uppercase">
              System Status
            </p>
            <p className="text-sm font-black text-[#10B981]">ONLINE & SYNCED</p>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Metrics (Left & Center) */}
          <div className="lg:col-span-2 space-y-8">
            {/* Live Metrics Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <StatCard
                icon={Thermometer}
                label="Temperature"
                value={`${data.env.temp}°C`}
                sub="Optimal"
                color="bg-[#005C3F]"
              />
              <StatCard
                icon={Droplets}
                label="Humidity"
                value={`${data.env.hum}%`}
                sub="Warning High"
                color="bg-[#4A6359]"
                trend={data.env.humTrend}
              />
              <StatCard
                icon={Activity}
                label="CO2 Concentration"
                value={`${data.env.co2} ppm`}
                sub="Normal"
                color="bg-slate-800"
              />
              <StatCard
                icon={Wind}
                label="Air Quality Index"
                value={data.env.aqi}
                sub="Good AQI"
                color="bg-[#10B981]"
              />
            </div>

            {/* Smart Insights Section */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center">
                  <Lightbulb size={18} />
                </div>
                <h3 className="text-lg font-black text-slate-800">
                  Smart AI Insights
                </h3>
              </div>

              <div className="space-y-4">
                <InsightAlert
                  type="warning"
                  title="Humidity Rising Detected"
                  message="Humidity is trending up. Recommendation: Increase fan speed to 1800 RPM or open windows by 10% to balance the airflow."
                />
                <InsightAlert
                  type="info"
                  title="Optimal Cooling Setup"
                  message="External temp is 18°C. Passive cooling via windows is currently more energy-efficient than high-speed fans."
                />
              </div>
            </div>
          </div>

          {/* Controls Side Panel (Right) */}
          <div className="space-y-8">
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100 h-full">
              <h3 className="text-lg font-black text-[#005C3F] mb-6">
                Actuators Status
              </h3>

              <div className="space-y-4">
                <ActuatorToggle
                  icon={Fan}
                  label="Cooling Fans"
                  status={data.actuators.fans.state}
                  detail={data.actuators.fans.detail}
                  isActive={true}
                />
                <ActuatorToggle
                  icon={Monitor}
                  label="Smart Windows"
                  status={data.actuators.windows.state}
                  detail={data.actuators.windows.detail}
                  isActive={false}
                />
                <ActuatorToggle
                  icon={CloudRain}
                  label="Mister System"
                  status={data.actuators.mister.state}
                  detail={data.actuators.mister.detail}
                  isActive={false}
                />
              </div>

              {/* Quick Action Button */}
              <button className="w-full mt-8 bg-[#005C3F] hover:bg-[#064a35] text-white py-4 rounded-2xl font-bold transition-all shadow-lg shadow-[#005c3f]/20 flex items-center justify-center gap-2">
                Apply Recommended Actions
              </button>

              <div className="mt-8 pt-8 border-t border-slate-100">
                <p className="text-[10px] font-black text-slate-400 uppercase mb-4 tracking-widest">
                  Energy Snapshot
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                    <span className="text-xs font-bold font-mono text-slate-800">
                      92% Battery Capacity
                    </span>
                  </div>
                  <span className="text-xs font-medium text-slate-400">
                    450W Solar
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
