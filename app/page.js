// app/page.js
"use client";

import React, { useState, useEffect } from "react";
import {
  Zap,
  Thermometer,
  Droplets,
  Activity,
  Sprout,
  Fan,
  Power,
  Wind,
  Lock,
  Sun,
  Battery,
  TrendingUp,
  TrendingDown,
  CloudRain,
  Calendar,
  ChevronRight,
  Eye,
  Gauge,
  Waves,
  Leaf,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

// --- Animated Counter ---
const AnimatedCounter = ({ value, suffix = "", prefix = "" }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const duration = 1000;
    const steps = 60;
    const numericValue = parseFloat(value) || 0;
    const stepValue = numericValue / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += stepValue;
      if (current >= numericValue) {
        setCount(numericValue);
        clearInterval(timer);
      } else {
        setCount(current);
      }
    }, duration / steps);
    return () => clearInterval(timer);
  }, [value]);

  return (
    <span>
      {prefix}
      {typeof count === "number" ? count.toFixed(1) : count}
      {suffix}
    </span>
  );
};

// --- Stat Card Component ---
const StatCard = ({
  icon: Icon,
  label,
  value,
  sub,
  color,
  trend,
  trendValue,
}) => (
  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm hover:shadow-lg transition-all group">
    <div className="flex justify-between items-start mb-3">
      <div
        className={`p-2.5 rounded-xl ${color} text-white shadow-lg group-hover:scale-110 transition-transform`}
      >
        <Icon size={20} />
      </div>
      {trend && (
        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${
            trend === "up"
              ? "bg-green-100 text-green-600"
              : trend === "down"
                ? "bg-red-100 text-red-600"
                : "bg-blue-100 text-blue-600"
          }`}
        >
          {trend === "up" ? (
            <TrendingUp size={10} />
          ) : trend === "down" ? (
            <TrendingDown size={10} />
          ) : null}
          {trendValue}
        </span>
      )}
    </div>
    <div>
      <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider">
        {label}
      </p>
      <h4 className="text-2xl font-black text-slate-800 mt-1">
        <AnimatedCounter
          value={typeof value === "number" ? value : parseFloat(value)}
          suffix={typeof value === "string" ? value.replace(/[0-9.]/g, "") : ""}
        />
      </h4>
      <p className="text-[10px] text-slate-500 font-medium mt-0.5">{sub}</p>
    </div>
  </div>
);

// --- Control Row Component ---
const ControlRow = ({ icon: Icon, label, state, active }) => (
  <div className="flex items-center justify-between p-3 rounded-xl bg-[#F0F4F2] hover:bg-[#e8ecea] transition-all">
    <div className="flex items-center gap-3">
      <div
        className={`p-1.5 rounded-lg ${active ? "bg-[#005C3F] text-white" : "bg-white text-slate-400 shadow-sm"}`}
      >
        <Icon size={14} />
      </div>
      <span className="text-sm font-bold text-slate-700">{label}</span>
    </div>
    <div
      className={`px-2 py-1 rounded-full text-[9px] font-black uppercase tracking-tighter ${
        active ? "bg-[#10B981] text-white" : "bg-slate-200 text-slate-500"
      }`}
    >
      {state}
    </div>
  </div>
);

// --- Bar Chart Component ---
const BarChart = ({ data, title, color }) => {
  const maxValue = Math.max(...data.map((d) => d.value));

  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
      <h3 className="text-sm font-black text-slate-800 mb-4 flex items-center gap-2">
        <div
          className={`w-6 h-6 rounded-lg ${color} flex items-center justify-center`}
        >
          <Activity size={12} className="text-white" />
        </div>
        {title}
      </h3>
      <div className="space-y-3">
        {data.map((item, idx) => (
          <div key={idx}>
            <div className="flex justify-between text-[10px] font-medium text-slate-500 mb-1">
              <span>{item.label}</span>
              <span className="font-black text-slate-700">
                {item.value}
                {item.unit}
              </span>
            </div>
            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-1000"
                style={{
                  width: `${(item.value / maxValue) * 100}%`,
                  background: `linear-gradient(90deg, ${item.gradientStart}, ${item.gradientEnd})`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- Line Chart (Mock) Component ---
const LineChartPreview = ({ title, data, color }) => (
  <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-sm font-black text-slate-800 flex items-center gap-2">
        <div
          className={`w-6 h-6 rounded-lg ${color} flex items-center justify-center`}
        >
          <TrendingUp size={12} className="text-white" />
        </div>
        {title}
      </h3>
      <span className="text-[9px] text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
        +12% vs yesterday
      </span>
    </div>

    {/* SVG Line Chart */}
    <svg
      className="w-full h-32"
      viewBox="0 0 400 100"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="lineGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop
            offset="0%"
            stopColor={color === "bg-green-500" ? "#10B981" : "#005C3F"}
            stopOpacity="0.3"
          />
          <stop
            offset="100%"
            stopColor={color === "bg-green-500" ? "#10B981" : "#005C3F"}
            stopOpacity="0"
          />
        </linearGradient>
      </defs>
      {/* Area under line */}
      <path
        d="M0,95 L20,85 L40,70 L60,75 L80,60 L100,50 L120,55 L140,40 L160,45 L180,30 L200,35 L220,25 L240,30 L260,20 L280,25 L300,15 L320,20 L340,10 L360,15 L380,5 L400,0 L400,100 L0,100 Z"
        fill="url(#lineGradient)"
      />
      {/* Line */}
      <path
        d="M0,95 L20,85 L40,70 L60,75 L80,60 L100,50 L120,55 L140,40 L160,45 L180,30 L200,35 L220,25 L240,30 L260,20 L280,25 L300,15 L320,20 L340,10 L360,15 L380,5 L400,0"
        fill="none"
        stroke={color === "bg-green-500" ? "#10B981" : "#005C3F"}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* Data points */}
      {[0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400].map((x, i) => (
        <circle
          key={i}
          cx={x}
          cy={data[i] || 50}
          r="2.5"
          fill={color === "bg-green-500" ? "#10B981" : "#005C3F"}
        />
      ))}
    </svg>

    <div className="flex justify-between mt-2 text-[8px] text-slate-400">
      <span>12AM</span>
      <span>4AM</span>
      <span>8AM</span>
      <span>12PM</span>
      <span>4PM</span>
      <span>8PM</span>
      <span>Now</span>
    </div>
  </div>
);

// --- Mini Gauge Component ---
const MiniGauge = ({ value, label, color, max = 100 }) => {
  const percentage = (value / max) * 100;
  const getColor = () => {
    if (percentage >= 70) return "stroke-green-500";
    if (percentage >= 30) return "stroke-yellow-500";
    return "stroke-red-500";
  };

  return (
    <div className="text-center">
      <svg className="w-16 h-16 mx-auto" viewBox="0 0 100 100">
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="#E2E8F0"
          strokeWidth="8"
        />
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={`${percentage * 2.51} 251`}
          strokeDashoffset="0"
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
          className="transition-all duration-1000"
        />
        <text
          x="50"
          y="55"
          textAnchor="middle"
          className="text-xs font-black fill-slate-700"
        >
          {value}
          {label === "Temp" ? "°" : "%"}
        </text>
      </svg>
      <p className="text-[9px] font-semibold text-slate-500 mt-1">{label}</p>
    </div>
  );
};

// --- Insight Card ---
const InsightCard = ({ type, title, message, icon: Icon }) => (
  <div
    className={`p-3 rounded-xl border-l-4 flex gap-2 ${
      type === "warning"
        ? "bg-orange-50 border-l-orange-500"
        : type === "success"
          ? "bg-green-50 border-l-green-500"
          : "bg-blue-50 border-l-blue-500"
    }`}
  >
    <div
      className={
        type === "warning"
          ? "text-orange-500"
          : type === "success"
            ? "text-green-500"
            : "text-blue-500"
      }
    >
      <Icon size={14} />
    </div>
    <div>
      <p className="text-[10px] font-bold text-slate-800">{title}</p>
      <p className="text-[9px] text-slate-600">{message}</p>
    </div>
  </div>
);

// --- Main Page Component ---
export default function OverviewPage() {
  const data = {
    house: {
      location: "Syria - Damascus",
      status: "Online",
      uptime: "15 days, 4 hours",
      lastSync: "2026-04-24T15:30:00Z",
    },
    env: { temp: 24.5, hum: 62, co2: 415, aqi: 45, light: 12000 },
    water: { tank: 85, ph: 6.4, temp: 19.0, ec: 1.2 },
    energy: { solar: 450, battery: 92, consumption: 120 },
    zones: [
      { name: "Zone A - Tomatoes", value: 45, threshold: 40 },
      { name: "Zone B - Peppers", value: 52, threshold: 35 },
      { name: "Zone C - Strawberries", value: 38, threshold: 40 },
    ],
    actuators: {
      windows: "Closed",
      pump: "OFF",
      fans: "ON",
      door: "Locked",
      mister: "OFF",
      lights: "OFF",
    },
  };

  // Chart data
  const soilMoistureData = [
    {
      label: "Zone A - Tomatoes",
      value: 45,
      unit: "%",
      gradientStart: "#005C3F",
      gradientEnd: "#0a8a5c",
    },
    {
      label: "Zone B - Peppers",
      value: 52,
      unit: "%",
      gradientStart: "#005C3F",
      gradientEnd: "#0a8a5c",
    },
    {
      label: "Zone C - Strawberries",
      value: 38,
      unit: "%",
      gradientStart: "#ef4444",
      gradientEnd: "#f97316",
    },
  ];

  const energyData = [
    {
      label: "Solar Generation",
      value: 450,
      unit: "W",
      gradientStart: "#f59e0b",
      gradientEnd: "#f97316",
    },
    {
      label: "Power Consumption",
      value: 120,
      unit: "W",
      gradientStart: "#3b82f6",
      gradientEnd: "#06b6d4",
    },
    {
      label: "Battery Charge",
      value: 92,
      unit: "%",
      gradientStart: "#10B981",
      gradientEnd: "#34d399",
    },
  ];

  const waterData = [
    {
      label: "Tank Level",
      value: 85,
      unit: "%",
      gradientStart: "#0ea5e9",
      gradientEnd: "#3b82f6",
    },
    {
      label: "pH Level",
      value: 6.4,
      unit: "",
      gradientStart: "#8b5cf6",
      gradientEnd: "#a78bfa",
    },
    {
      label: "EC Level",
      value: 1.2,
      unit: "mS/cm",
      gradientStart: "#ec4899",
      gradientEnd: "#f43f5e",
    },
  ];

  // Line chart data points
  const tempDataPoints = [
    95, 85, 70, 75, 60, 50, 55, 40, 45, 30, 35, 25, 30, 20, 25, 15, 20, 10, 15,
    5, 0,
  ];

  const criticalZones = data.zones.filter((z) => z.value < z.threshold).length;

  return (
    <div className="min-h-screen bg-[#F0F4F2]">
      <div className="max-w-7xl mx-auto p-4 md:p-8 font-sans">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span className="text-[#005C3F] font-bold">Dashboard</span>
              <ChevronRight size={12} />
              <span>Overview</span>
            </nav>
            <h1 className="text-3xl md:text-4xl font-black bg-gradient-to-r from-[#005C3F] to-[#0a8a5c] bg-clip-text text-transparent">
              Greenhouse Command Center
            </h1>
            <p className="text-slate-500 text-sm mt-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {data.house.location} • System {data.house.status}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="bg-white/80 backdrop-blur-sm px-4 py-2 rounded-2xl shadow-sm border border-slate-100">
              <p className="text-[9px] font-bold text-slate-400 uppercase">
                Uptime
              </p>
              <p className="text-xs font-black text-[#005C3F]">
                {data.house.uptime}
              </p>
            </div>
            <button className="bg-[#005C3F] hover:bg-[#064a35] text-white px-5 py-2 rounded-xl font-bold text-sm shadow-lg transition-all flex items-center gap-2">
              <Eye size={14} />
              Live Feed
            </button>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={Sun}
            label="Solar Input"
            value={`${data.energy.solar}W`}
            sub="Peak: 650W"
            color="bg-gradient-to-br from-amber-500 to-orange-500"
            trend="up"
            trendValue="+12%"
          />
          <StatCard
            icon={Thermometer}
            label="Air Temp"
            value={`${data.env.temp}°C`}
            sub="Optimal"
            color="bg-gradient-to-br from-[#005C3F] to-[#0a8a5c]"
            trend="stable"
            trendValue="→"
          />
          <StatCard
            icon={Droplets}
            label="Tank Level"
            value={`${data.water.tank}%`}
            sub={`${Math.round((data.water.tank / 100) * 1000)}L Left`}
            color="bg-gradient-to-br from-blue-500 to-cyan-500"
            trend="down"
            trendValue="-3%"
          />
          <StatCard
            icon={Activity}
            label="Air Quality"
            value={data.env.aqi}
            sub="Good (AQI)"
            color="bg-gradient-to-br from-green-500 to-emerald-500"
            trend="up"
            trendValue="+5"
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Charts */}
          <div className="lg:col-span-2 space-y-6">
            {/* Soil Moisture Chart */}
            <BarChart
              data={soilMoistureData}
              title="Soil Moisture Analysis"
              color="bg-[#005C3F]"
            />

            {/* Temperature Trend Line Chart */}
            <LineChartPreview
              title="Temperature Trend (24h)"
              data={tempDataPoints}
              color="bg-[#005C3F]"
            />

            {/* Two Column Charts */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <BarChart
                data={energyData}
                title="Energy Distribution"
                color="bg-amber-500"
              />
              <BarChart
                data={waterData}
                title="Water System Status"
                color="bg-blue-500"
              />
            </div>

            {/* Quick Insights */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-slate-800 mb-3 flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-purple-500 flex items-center justify-center">
                  <Waves size={12} className="text-white" />
                </div>
                Smart Insights
              </h3>
              <div className="space-y-2">
                <InsightCard
                  type="success"
                  icon={CheckCircle2}
                  title="Energy Positive"
                  message={`Solar (${data.energy.solar}W) exceeds consumption by ${data.energy.solar - data.energy.consumption}W`}
                />
                {criticalZones > 0 && (
                  <InsightCard
                    type="warning"
                    icon={AlertTriangle}
                    title="Low Moisture Alert"
                    message={`${criticalZones} zone(s) below threshold - irrigation recommended`}
                  />
                )}
                <InsightCard
                  type="info"
                  icon={TrendingUp}
                  title="Optimal Conditions"
                  message="Temperature and humidity levels are ideal for all crop zones"
                />
              </div>
            </div>
          </div>

          {/* Right Column - Status & Controls */}
          <div className="space-y-6">
            {/* Mini Gauges */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-slate-800 mb-4 flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-[#005C3F] flex items-center justify-center">
                  <Gauge size={12} className="text-white" />
                </div>
                Live Metrics
              </h3>
              <div className="grid grid-cols-3 gap-4">
                <MiniGauge
                  value={data.env.hum}
                  label="Humidity"
                  color="#4A6359"
                />
                <MiniGauge
                  value={data.env.temp}
                  label="Temp"
                  color="#005C3F"
                  max={50}
                />
                <MiniGauge
                  value={data.energy.battery}
                  label="Battery"
                  color="#10B981"
                />
              </div>
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">CO₂ Level</span>
                  <span className="font-black text-slate-800">
                    {data.env.co2} ppm
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs mt-2">
                  <span className="text-slate-500">Light Intensity</span>
                  <span className="font-black text-slate-800">
                    {data.env.light.toLocaleString()} Lux
                  </span>
                </div>
              </div>
            </div>

            {/* System Actuators */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-[#005C3F] mb-4 flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-[#005C3F]/10 flex items-center justify-center">
                  <Zap size={12} className="text-[#005C3F]" />
                </div>
                System Actuators
              </h3>
              <div className="space-y-2">
                <ControlRow
                  icon={Fan}
                  label="Cooling Fans"
                  state={data.actuators.fans}
                  active={data.actuators.fans === "ON"}
                />
                <ControlRow
                  icon={Power}
                  label="Irrigation Pump"
                  state={data.actuators.pump}
                  active={data.actuators.pump === "ON"}
                />
                <ControlRow
                  icon={Wind}
                  label="Smart Windows"
                  state={data.actuators.windows}
                  active={data.actuators.windows === "Open"}
                />
                <ControlRow
                  icon={CloudRain}
                  label="Mister System"
                  state={data.actuators.mister}
                  active={data.actuators.mister === "ON"}
                />
                <ControlRow
                  icon={Sun}
                  label="Grow Lights"
                  state={data.actuators.lights}
                  active={data.actuators.lights === "ON"}
                />
                <ControlRow
                  icon={Lock}
                  label="Main Door"
                  state={data.actuators.door}
                  active={data.actuators.door === "Locked"}
                />
              </div>
            </div>

            {/* Environmental Impact */}
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-5 text-white shadow-xl">
              <div className="flex items-center gap-2 mb-4">
                <Leaf size={16} className="text-green-400" />
                <span className="text-[10px] font-bold uppercase tracking-wider">
                  Environmental Impact
                </span>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-300">
                    CO₂ Saved Today
                  </span>
                  <span className="text-sm font-black text-green-400">
                    ~2.4 kg
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-300">
                    Clean Energy Share
                  </span>
                  <span className="text-sm font-black text-amber-400">
                    100% Solar
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-300">
                    Grid Independence
                  </span>
                  <span className="text-sm font-black text-cyan-400">94%</span>
                </div>
                <div className="pt-2">
                  <div className="w-full bg-slate-700 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-green-500 to-amber-500 h-full rounded-full"
                      style={{ width: "94%" }}
                    />
                  </div>
                  <p className="text-[8px] text-slate-400 mt-1 text-center">
                    94% Sustainable
                  </p>
                </div>
              </div>
            </div>

            {/* Recent Activity */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-slate-800 mb-3 flex items-center gap-2">
                <Calendar size={14} className="text-[#005C3F]" />
                Recent Activity
              </h3>
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-[10px]">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  <span className="text-slate-500">10 min ago</span>
                  <span className="text-slate-700">
                    Solar peak reached: 650W
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px]">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                  <span className="text-slate-500">1 hour ago</span>
                  <span className="text-slate-700">
                    Zone A irrigation completed
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px]">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  <span className="text-slate-500">3 hours ago</span>
                  <span className="text-slate-700">
                    Humidity adjustment triggered
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
