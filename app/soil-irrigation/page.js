// app/soil-irrigation/page.js
"use client";

import React from "react";
import {
  Sprout,
  Droplets,
  Thermometer,
  Activity,
  Waves,
  Flower2,
  Sun,
  CloudRain,
  Battery,
  Zap,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Gauge,
  Beaker,
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
          className={`text-[10px] font-bold px-2 py-1 rounded-full ${trend === "Rising" ? "bg-orange-100 text-orange-600" : trend === "Stable" ? "bg-green-100 text-green-600" : "bg-blue-100 text-blue-600"}`}
        >
          {trend === "Rising"
            ? "↑ RISING"
            : trend === "Stable"
              ? "→ STABLE"
              : "↓ FALLING"}
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

const ZoneMoistureCard = ({ zone, value, threshold }) => {
  const isCritical = value < threshold;
  return (
    <div className="p-5 rounded-2xl bg-[#F0F4F2] border border-transparent hover:border-[#10B981] transition-all">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-3">
          <div
            className={`p-2 rounded-xl ${isCritical ? "bg-orange-100 text-orange-600" : "bg-[#005C3F] text-white"}`}
          >
            <Sprout size={18} />
          </div>
          <span className="font-bold text-slate-800">{zone}</span>
        </div>
        <span
          className={`text-sm font-black ${isCritical ? "text-orange-600" : "text-[#005C3F]"}`}
        >
          {value}%
        </span>
      </div>
      <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${isCritical ? "bg-orange-500" : "bg-[#005C3F]"}`}
          style={{ width: `${value}%` }}
        />
      </div>
      <div className="flex justify-between mt-2 text-[10px] font-semibold text-slate-400">
        <span>Current: {value}%</span>
        <span>Threshold: {threshold}%</span>
      </div>
      {isCritical && (
        <div className="mt-3 text-[10px] font-bold text-orange-600 bg-orange-50 p-2 rounded-xl flex items-center gap-2">
          <AlertTriangle size={12} />
          Below threshold - Irrigation recommended
        </div>
      )}
    </div>
  );
};

const WaterMetric = ({ icon: Icon, label, value, status, color }) => (
  <div className="flex items-center justify-between p-3 rounded-xl bg-[#F0F4F2]">
    <div className="flex items-center gap-3">
      <div className={`p-1.5 rounded-lg ${color}`}>
        <Icon size={16} className="text-white" />
      </div>
      <span className="text-sm font-medium text-slate-600">{label}</span>
    </div>
    <div className="text-right">
      <span className="text-sm font-black text-slate-800">{value}</span>
      {status && (
        <p className="text-[9px] font-bold text-slate-400">{status}</p>
      )}
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
    className={`p-4 rounded-2xl border-l-4 flex gap-4 ${type === "warning" ? "bg-orange-50 border-orange-200 border-l-orange-500" : type === "success" ? "bg-green-50 border-green-200 border-l-green-500" : "bg-blue-50 border-blue-200 border-l-blue-500"}`}
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

export default function SoilIrrigationPage() {
  // Data from the provided API
  const apiData = {
    house_metadata: {
      system_status: "Online",
      last_sync: "2026-04-01T23:15:00Z",
      location: "Syria - Damascus",
      firmware_version: "v2.5.0",
      uptime: "15 days, 4 hours",
    },
    environmental_sensors: {
      temperature: {
        value: 24.5,
        unit: "°C",
        status: "Optimal",
        trend: "Stable",
      },
      humidity: {
        value: 62,
        unit: "%",
        status: "Warning_High",
        trend: "Rising",
      },
      soil_moisture: [
        {
          zone: "Zone A - Tomatoes",
          value: 45,
          unit: "%",
          moisture_threshold: 40,
        },
        {
          zone: "Zone B - Peppers",
          value: 52,
          unit: "%",
          moisture_threshold: 35,
        },
        {
          zone: "Zone C - Strawberries",
          value: 38,
          unit: "%",
          moisture_threshold: 40,
        },
      ],
      light_intensity: {
        value: 12000,
        unit: "Lux",
        uv_index: 4.2,
        shading_needed: false,
      },
      co2_level: { value: 415, unit: "ppm", status: "Normal" },
      air_quality_index: { value: 45, status: "Good" },
    },
    water_system: {
      water_level_tank: { value: 85, unit: "%", is_filling: false },
      ph_level: { value: 6.4, status: "Perfect" },
      ec_level: { value: 1.2, unit: "mS/cm", label: "Nutrient Concentration" },
      water_temp: { value: 19.0, unit: "°C" },
      last_irrigation_total: { value: 150, unit: "Liters" },
    },
    energy_management: {
      solar_input: { value: 450, unit: "Watts" },
      battery_charge: { value: 92, unit: "%" },
      power_consumption: { value: 120, unit: "Watts" },
    },
    actuators_status: {
      windows: { state: "Closed", opening_percentage: 0, auto_mode: true },
      main_door: { state: "Locked", last_access: "10:30 AM" },
      irrigation_pump: { state: "OFF", flow_rate: 0, next_run: "04:00 AM" },
      cooling_fans: { state: "ON", speed: "Medium", rpm: 1200 },
      mister_system: { state: "OFF", tank_fluid_level: 70, unit: "%" },
      grow_lights: { state: "OFF", intensity: 0, color_spectrum: "Full" },
    },
    security_alerts: [
      { type: "Intrusion", status: "Clear", camera_feed: "Active" },
      { type: "Fire_Smoke", status: "Clear" },
      { type: "Leak_Detection", status: "Clear" },
    ],
    forecast: {
      outside_temp: 18.0,
      expected_rain: "Low",
      wind_speed: 12,
      unit: "km/h",
    },
  };

  // Calculate critical zones (below threshold)
  const criticalZonesCount = apiData.environmental_sensors.soil_moisture.filter(
    (z) => z.value < z.moisture_threshold,
  ).length;

  // Check if any zone needs irrigation
  const needsIrrigation = criticalZonesCount > 0;

  return (
    <div className="min-h-screen bg-[#F0F4F2] p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header Section */}
        <header className="flex justify-between items-end mb-8">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span>Home</span> <ChevronRight size={12} />{" "}
              <span>Soil & Irrigation</span>
            </nav>
            <h1 className="text-3xl font-black text-[#005C3F] tracking-tight">
              Soil & Irrigation Hub
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Real-time soil moisture monitoring and water management for
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
            {/* Live Metrics Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Soil Moisture Overview Card (Custom) */}
              <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-3 rounded-2xl bg-[#005C3F] text-white shadow-lg">
                    <Droplets size={24} />
                  </div>
                  {needsIrrigation && (
                    <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-orange-100 text-orange-600">
                      ⚠️ ACTION NEEDED
                    </span>
                  )}
                </div>
                <div>
                  <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                    Critical Zones
                  </p>
                  <h4 className="text-2xl font-black text-slate-800 mt-1">
                    {criticalZonesCount} /{" "}
                    {apiData.environmental_sensors.soil_moisture.length}
                  </h4>
                  <div className="flex items-center gap-1 mt-1">
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${criticalZonesCount === 0 ? "bg-green-500" : "bg-orange-500 animate-pulse"}`}
                    />
                    <p className="text-xs text-slate-500 font-medium">
                      {criticalZonesCount === 0
                        ? "All zones optimal"
                        : "Below moisture threshold"}
                    </p>
                  </div>
                </div>
              </div>

              <StatCard
                icon={Thermometer}
                label="Temperature"
                value={`${apiData.environmental_sensors.temperature.value}${apiData.environmental_sensors.temperature.unit}`}
                sub={apiData.environmental_sensors.temperature.status}
                color="bg-[#005C3F]"
                trend={apiData.environmental_sensors.temperature.trend}
              />
              <StatCard
                icon={Waves}
                label="Humidity"
                value={`${apiData.environmental_sensors.humidity.value}${apiData.environmental_sensors.humidity.unit}`}
                sub={apiData.environmental_sensors.humidity.status}
                color="bg-[#4A6359]"
                trend={apiData.environmental_sensors.humidity.trend}
              />
              <StatCard
                icon={Sun}
                label="Light Intensity"
                value={`${apiData.environmental_sensors.light_intensity.value.toLocaleString()} Lux`}
                sub={`UV Index: ${apiData.environmental_sensors.light_intensity.uv_index}`}
                color="bg-amber-600"
              />
            </div>

            {/* Soil Moisture Zones Section */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-[#005C3F]/10 text-[#005C3F] flex items-center justify-center">
                  <Sprout size={18} />
                </div>
                <h3 className="text-lg font-black text-slate-800">
                  Soil Moisture Zones
                </h3>
              </div>

              <div className="space-y-4">
                {apiData.environmental_sensors.soil_moisture.map(
                  (zone, idx) => (
                    <ZoneMoistureCard
                      key={idx}
                      zone={zone.zone}
                      value={zone.value}
                      threshold={zone.moisture_threshold}
                    />
                  ),
                )}
              </div>
            </div>

            {/* Smart AI Insights Section */}
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
                {needsIrrigation ? (
                  <InsightAlert
                    type="warning"
                    title="Low Soil Moisture Detected"
                    message={`${criticalZonesCount} zone(s) are below their moisture threshold. Recommendation: Activate irrigation pump or increase watering schedule.`}
                  />
                ) : (
                  <InsightAlert
                    type="success"
                    title="All Zones Optimal"
                    message="All soil moisture levels are within healthy ranges. Maintaining current irrigation schedule is recommended."
                  />
                )}
                <InsightAlert
                  type="info"
                  title="Water Efficiency Tip"
                  message={`Next irrigation scheduled for ${apiData.actuators_status.irrigation_pump.next_run}. Combined with ${apiData.forecast.expected_rain.toLowerCase()} rain forecast, consider delaying manual watering.`}
                />
              </div>
            </div>
          </div>

          {/* Controls Side Panel (Right) */}
          <div className="space-y-8">
            {/* Water System Card */}
            <div className="bg-white rounded-[2.5rem] p-8 shadow-sm border border-slate-100">
              <h3 className="text-lg font-black text-[#005C3F] mb-6">
                Water System
              </h3>

              <div className="space-y-3 mb-6">
                <WaterMetric
                  icon={Droplets}
                  label="Water Tank Level"
                  value={`${apiData.water_system.water_level_tank.value}%`}
                  status={
                    apiData.water_system.water_level_tank.is_filling
                      ? "Filling..."
                      : "Stable"
                  }
                  color="bg-blue-500"
                />
                <WaterMetric
                  icon={Beaker}
                  label="pH Level"
                  value={apiData.water_system.ph_level.value}
                  status={apiData.water_system.ph_level.status}
                  color="bg-purple-500"
                />
                <WaterMetric
                  icon={Gauge}
                  label="Nutrient Concentration (EC)"
                  value={`${apiData.water_system.ec_level.value} ${apiData.water_system.ec_level.unit}`}
                  status="Optimal"
                  color="bg-emerald-500"
                />
                <WaterMetric
                  icon={Thermometer}
                  label="Water Temperature"
                  value={`${apiData.water_system.water_temp.value}${apiData.water_system.water_temp.unit}`}
                  color="bg-[#4A6359]"
                />
              </div>

              <div className="border-t border-slate-100 pt-4 mb-6">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Last Irrigation Total</span>
                  <span className="font-black text-[#005C3F]">
                    {apiData.water_system.last_irrigation_total.value}{" "}
                    {apiData.water_system.last_irrigation_total.unit}
                  </span>
                </div>
              </div>

              <h3 className="text-lg font-black text-[#005C3F] mb-4">
                Actuators Status
              </h3>

              <div className="space-y-4">
                <ActuatorToggle
                  icon={CloudRain}
                  label="Irrigation Pump"
                  status={apiData.actuators_status.irrigation_pump.state}
                  detail={`Next run: ${apiData.actuators_status.irrigation_pump.next_run}`}
                  isActive={
                    apiData.actuators_status.irrigation_pump.state === "ON"
                  }
                />
                <ActuatorToggle
                  icon={Flower2}
                  label="Grow Lights"
                  status={apiData.actuators_status.grow_lights.state}
                  detail={`${apiData.actuators_status.grow_lights.color_spectrum} Spectrum`}
                  isActive={apiData.actuators_status.grow_lights.state === "ON"}
                />
                <ActuatorToggle
                  icon={Sun}
                  label="Smart Windows"
                  status={apiData.actuators_status.windows.state}
                  detail={`${apiData.actuators_status.windows.opening_percentage}% Opening • Auto: ${apiData.actuators_status.windows.auto_mode ? "ON" : "OFF"}`}
                  isActive={apiData.actuators_status.windows.state === "Open"}
                />
              </div>

              {/* Quick Action Button */}
              <button className="w-full mt-8 bg-[#005C3F] hover:bg-[#064a35] text-white py-4 rounded-2xl font-bold transition-all shadow-lg shadow-[#005c3f]/20 flex items-center justify-center gap-2">
                {needsIrrigation
                  ? "💧 Run Irrigation Cycle"
                  : "✓ All Systems Optimal"}
              </button>

              {/* Energy Snapshot */}
              <div className="mt-8 pt-8 border-t border-slate-100">
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
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
