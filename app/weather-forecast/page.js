// app/weather-forecast/page.js
"use client";

import React, { useState, useEffect } from "react";
import {
  CloudSun,
  Wind,
  Droplets,
  Sun,
  CloudRain,
  Thermometer,
  Umbrella,
  Compass,
  Calendar,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Sunrise,
  Sunset,
  Eye,
  Waves,
  Gauge,
  MoonStar,
  Cloud,
  Sparkles,
  Star,
  CloudFog,
  CloudLightning,
} from "lucide-react";

// --- Animated Number Counter ---
const AnimatedCounter = ({ value, suffix = "", prefix = "" }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const duration = 800;
    const steps = 50;
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

// --- Main Weather Card ---
const MainWeatherCard = ({ temp, condition, high, low, icon: Icon, color }) => (
  <div
    className={`relative overflow-hidden bg-gradient-to-br ${color} rounded-[2rem] p-6 text-white shadow-xl`}
  >
    {/* Decorative elements */}
    <div className="absolute top-0 right-0 w-56 h-56 bg-white/10 rounded-full blur-3xl" />
    <div className="absolute bottom-0 left-0 w-40 h-40 bg-yellow-400/10 rounded-full blur-2xl" />
    <div className="absolute top-20 left-10 w-20 h-20 bg-white/5 rounded-full blur-xl" />

    {/* Floating particles */}
    <div className="absolute top-10 right-20 w-1 h-1 bg-white/40 rounded-full animate-ping" />
    <div className="absolute bottom-10 left-20 w-1.5 h-1.5 bg-white/30 rounded-full animate-pulse" />

    <div className="relative z-10">
      <div className="flex justify-between items-start mb-6">
        <div>
          <p className="text-white/60 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
            <Star size={10} className="text-yellow-300" />
            Current Weather
          </p>
          <p className="text-5xl font-black mt-1">
            <AnimatedCounter value={temp} suffix="°C" />
          </p>
          <p className="text-white/80 text-sm mt-1 flex items-center gap-1">
            {condition}
          </p>
        </div>
        <div className="p-3 rounded-2xl bg-white/20 backdrop-blur-sm shadow-lg">
          <Icon size={32} />
        </div>
      </div>

      <div className="flex justify-between pt-4 border-t border-white/20">
        <div className="bg-white/10 rounded-xl px-3 py-1.5">
          <p className="text-white/50 text-[9px] font-semibold">High</p>
          <p className="text-lg font-black">{high}°C</p>
        </div>
        <div className="bg-white/10 rounded-xl px-3 py-1.5">
          <p className="text-white/50 text-[9px] font-semibold">Low</p>
          <p className="text-lg font-black">{low}°C</p>
        </div>
        <div className="bg-white/10 rounded-xl px-3 py-1.5">
          <p className="text-white/50 text-[9px] font-semibold">Feels Like</p>
          <p className="text-lg font-black">{Math.round(temp - 1)}°C</p>
        </div>
      </div>
    </div>
  </div>
);

// --- Stat Card (matching style) ---
const StatCard = ({ icon: Icon, label, value, sub, color, trend }) => (
  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm hover:shadow-lg transition-all group">
    <div className="flex justify-between items-start mb-3">
      <div
        className={`p-2.5 rounded-xl ${color} text-white shadow-lg group-hover:scale-110 transition-transform`}
      >
        <Icon size={20} />
      </div>
      {trend && (
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gradient-to-r from-orange-100 to-amber-100 text-orange-600">
          {trend}
        </span>
      )}
    </div>
    <div>
      <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider">
        {label}
      </p>
      <h4 className="text-xl font-black text-slate-800 mt-1">{value}</h4>
      <p className="text-[10px] text-slate-500 font-medium mt-0.5">{sub}</p>
    </div>
  </div>
);

// --- Hourly Forecast Item ---
const HourlyForecastItem = ({
  time,
  temp,
  condition,
  icon: Icon,
  isActive,
}) => (
  <div
    className={`text-center p-3 rounded-xl transition-all cursor-pointer ${
      isActive
        ? "bg-gradient-to-br from-[#005C3F]/10 to-[#0a8a5c]/5 border border-[#005C3F]/30 shadow-md"
        : "hover:bg-gradient-to-br hover:from-slate-50 hover:to-slate-100"
    }`}
  >
    <p className="text-[10px] font-bold text-slate-500">{time}</p>
    <Icon
      size={20}
      className={`mx-auto my-2 transition-all ${
        isActive
          ? "text-[#005C3F] scale-110"
          : "text-slate-400 group-hover:text-[#005C3F]"
      }`}
    />
    <p
      className={`text-sm font-black ${
        isActive ? "text-[#005C3F]" : "text-slate-700"
      }`}
    >
      {temp}°
    </p>
    {isActive && (
      <div className="w-1 h-1 bg-[#005C3F] rounded-full mx-auto mt-1 animate-pulse" />
    )}
  </div>
);

// --- Daily Forecast Card ---
const DailyForecastCard = ({
  day,
  date,
  high,
  low,
  condition,
  icon: Icon,
  isToday,
}) => (
  <div
    className={`flex items-center justify-between p-3 rounded-xl transition-all cursor-pointer ${
      isToday
        ? "bg-gradient-to-r from-[#005C3F]/5 to-[#0a8a5c]/5 border border-[#005C3F]/20 shadow-sm"
        : "hover:bg-gradient-to-r hover:from-slate-50 hover:to-slate-100"
    }`}
  >
    <div className="flex items-center gap-3">
      <div
        className={`p-2 rounded-lg transition-all ${
          isToday
            ? "bg-gradient-to-br from-[#005C3F] to-[#0a8a5c] shadow-md"
            : "bg-slate-100 group-hover:bg-[#005C3F]/10"
        }`}
      >
        <Icon
          size={16}
          className={
            isToday ? "text-white" : "text-slate-500 group-hover:text-[#005C3F]"
          }
        />
      </div>
      <div>
        <p
          className={`text-sm font-black ${
            isToday ? "text-[#005C3F]" : "text-slate-700"
          }`}
        >
          {day}
        </p>
        <p className="text-[9px] text-slate-400">{date}</p>
      </div>
    </div>
    <div className="flex items-center gap-4">
      <p className="text-xs text-slate-500">{condition}</p>
      <div className="text-right">
        <p className="text-sm font-black text-slate-800">{high}°</p>
        <p className="text-[10px] text-slate-400">{low}°</p>
      </div>
    </div>
  </div>
);

// --- Insight Alert ---
const InsightAlert = ({ type, title, message }) => {
  const getGradient = () => {
    switch (type) {
      case "warning":
        return "bg-gradient-to-r from-orange-50 to-amber-50 border-l-orange-500";
      case "success":
        return "bg-gradient-to-r from-green-50 to-emerald-50 border-l-green-500";
      default:
        return "bg-gradient-to-r from-blue-50 to-cyan-50 border-l-blue-500";
    }
  };

  return (
    <div
      className={`p-3 rounded-xl border-l-4 flex gap-3 shadow-sm ${getGradient()}`}
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
        {type === "warning" ? (
          <AlertTriangle size={16} />
        ) : (
          <CheckCircle2 size={16} />
        )}
      </div>
      <div>
        <p className="text-xs font-bold text-slate-800">{title}</p>
        <p className="text-[10px] text-slate-600">{message}</p>
      </div>
    </div>
  );
};

// --- Main Page Component ---
export default function WeatherForecastPage() {
  // API Data (same structure as your previous pages)
  const apiData = {
    house_metadata: {
      system_status: "Online",
      last_sync: "2026-04-01T23:15:00Z",
      location: "Syria - Damascus",
      firmware_version: "v2.5.0",
      uptime: "15 days, 4 hours",
    },
    forecast: {
      outside_temp: 18.0,
      expected_rain: "Low",
      wind_speed: 12,
      unit: "km/h",
    },
    environmental_sensors: {
      temperature: { value: 24.5, unit: "°C", status: "Optimal" },
      humidity: { value: 62, unit: "%", status: "Normal" },
      light_intensity: { value: 12000, unit: "Lux", uv_index: 4.2 },
    },
  };

  // Mock hourly forecast data
  const hourlyForecast = [
    { time: "Now", temp: 18, condition: "Cloudy", icon: Cloud, isActive: true },
    { time: "11AM", temp: 19, condition: "Sunny", icon: Sun, isActive: false },
    { time: "12PM", temp: 20, condition: "Sunny", icon: Sun, isActive: false },
    {
      time: "1PM",
      temp: 21,
      condition: "Partly Cloudy",
      icon: CloudSun,
      isActive: false,
    },
    {
      time: "2PM",
      temp: 21,
      condition: "Partly Cloudy",
      icon: CloudSun,
      isActive: false,
    },
    {
      time: "3PM",
      temp: 20,
      condition: "Cloudy",
      icon: Cloud,
      isActive: false,
    },
  ];

  // Mock daily forecast data
  const dailyForecast = [
    {
      day: "Today",
      date: "Apr 24",
      high: 21,
      low: 14,
      condition: "Partly Cloudy",
      icon: CloudSun,
      isToday: true,
    },
    {
      day: "Friday",
      date: "Apr 25",
      high: 22,
      low: 15,
      condition: "Sunny",
      icon: Sun,
      isToday: false,
    },
    {
      day: "Saturday",
      date: "Apr 26",
      high: 20,
      low: 13,
      condition: "Cloudy",
      icon: Cloud,
      isToday: false,
    },
    {
      day: "Sunday",
      date: "Apr 27",
      high: 19,
      low: 12,
      condition: "Rain",
      icon: CloudRain,
      isToday: false,
    },
    {
      day: "Monday",
      date: "Apr 28",
      high: 18,
      low: 11,
      condition: "Cloudy",
      icon: Cloud,
      isToday: false,
    },
  ];

  // Get UV index status with colors
  const getUVStatus = (uv) => {
    if (uv < 3)
      return { text: "Low", color: "text-green-500", bg: "bg-green-100" };
    if (uv < 6)
      return {
        text: "Moderate",
        color: "text-yellow-600",
        bg: "bg-yellow-100",
      };
    if (uv < 8)
      return { text: "High", color: "text-orange-600", bg: "bg-orange-100" };
    return { text: "Very High", color: "text-red-600", bg: "bg-red-100" };
  };

  const uvStatus = getUVStatus(
    apiData.environmental_sensors.light_intensity.uv_index,
  );
  const feelsLike = apiData.forecast.outside_temp - 1;

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#F0F4F2] via-[#e8ede6] to-[#F0F4F2] p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-end mb-6 gap-4">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span className="hover:text-[#005C3F] transition">Home</span>{" "}
              <ChevronRight size={12} />{" "}
              <span className="text-[#005C3F] font-bold bg-[#005C3F]/5 px-2 py-0.5 rounded-full">
                Weather Forecast
              </span>
            </nav>
            <h1 className="text-3xl md:text-4xl font-black bg-gradient-to-r from-[#005C3F] to-[#0a8a5c] bg-clip-text text-transparent tracking-tight flex items-center gap-3">
              <div className="p-2 rounded-2xl bg-gradient-to-br from-[#005C3F] to-[#0a8a5c] shadow-md">
                <CloudSun size={24} className="text-white" />
              </div>
              Weather Intelligence
            </h1>
            <p className="text-slate-500 text-sm mt-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Hyperlocal forecast for Damascus Greenhouse
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="bg-white/80 backdrop-blur-sm px-4 py-2 rounded-2xl shadow-sm border border-slate-100">
              <p className="text-[9px] font-bold text-slate-400 uppercase flex items-center gap-1">
                📍 Location
              </p>
              <p className="text-xs font-black text-[#005C3F]">
                {apiData.house_metadata.location}
              </p>
            </div>
            <div className="bg-white/80 backdrop-blur-sm px-4 py-2 rounded-2xl shadow-sm border border-slate-100">
              <p className="text-[9px] font-bold text-slate-400 uppercase">
                🕐 Last Update
              </p>
              <p className="text-xs font-black text-slate-700">
                {new Date(
                  apiData.house_metadata.last_sync,
                ).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Main Weather & Stats */}
          <div className="lg:col-span-2 space-y-6">
            {/* Main Weather Card */}
            <MainWeatherCard
              temp={apiData.forecast.outside_temp}
              condition="Partly Cloudy ⛅"
              high={21}
              low={14}
              icon={CloudSun}
              color="from-[#005C3F] to-[#0a8a5c]"
            />

            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                icon={Wind}
                label="Wind Speed"
                value={`${apiData.forecast.wind_speed} km/h`}
                sub="Moderate Breeze 🌬️"
                color="bg-gradient-to-br from-[#4A6359] to-[#5a7a6e]"
                trend="↓ 2km/h"
              />
              <StatCard
                icon={Droplets}
                label="Expected Rain"
                value={apiData.forecast.expected_rain}
                sub="10% chance ☔"
                color="bg-gradient-to-br from-slate-700 to-slate-600"
              />
              <StatCard
                icon={Thermometer}
                label="Feels Like"
                value={`${feelsLike}°C`}
                sub="Cool 🧥"
                color="bg-gradient-to-br from-blue-600 to-blue-500"
              />
              <StatCard
                icon={Eye}
                label="UV Index"
                value={apiData.environmental_sensors.light_intensity.uv_index}
                sub={uvStatus.text}
                color="bg-gradient-to-br from-amber-500 to-orange-500"
              />
            </div>

            {/* Hourly Forecast */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-white/50">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#005C3F] to-[#0a8a5c] flex items-center justify-center shadow-md">
                    <Calendar size={14} className="text-white" />
                  </div>
                  <h3 className="text-sm font-black text-slate-800">
                    Hourly Forecast
                  </h3>
                </div>
                <span className="text-[9px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                  Next 6 hours
                </span>
              </div>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                {hourlyForecast.map((hour, idx) => (
                  <HourlyForecastItem key={idx} {...hour} />
                ))}
              </div>
            </div>

            {/* 5-Day Forecast */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-white/50">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#005C3F] to-[#0a8a5c] flex items-center justify-center shadow-md">
                  <Calendar size={14} className="text-white" />
                </div>
                <h3 className="text-sm font-black text-slate-800">
                  5-Day Forecast
                </h3>
              </div>
              <div className="space-y-2">
                {dailyForecast.map((day, idx) => (
                  <DailyForecastCard key={idx} {...day} />
                ))}
              </div>
            </div>
          </div>

          {/* Right Column - Insights & Details */}
          <div className="space-y-6">
            {/* Smart Insights */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-white/50">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-md">
                  <Sparkles size={14} className="text-white" />
                </div>
                <h3 className="text-sm font-black text-slate-800">
                  Weather Insights
                </h3>
              </div>
              <div className="space-y-3">
                <InsightAlert
                  type="info"
                  title="🌡️ Optimal Growing Conditions"
                  message={`Outside temperature (${apiData.forecast.outside_temp}°C) is ideal for greenhouse ventilation.`}
                />
                {apiData.forecast.expected_rain === "Low" && (
                  <InsightAlert
                    type="warning"
                    title="⚠️ Low Rainfall Expected"
                    message="Precipitation forecast is low. Consider adjusting irrigation schedule for the next 3 days."
                  />
                )}
                <InsightAlert
                  type="success"
                  title="⚡ Energy Efficiency Window"
                  message="Cool outside temperatures mean passive cooling is more effective than fans. Save ~15% energy."
                />
              </div>
            </div>

            {/* Environmental Impact on Greenhouse */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-white/50">
              <h3 className="text-sm font-black text-[#005C3F] mb-3 flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#005C3F] to-[#0a8a5c] flex items-center justify-center">
                  <Waves size={14} className="text-white" />
                </div>
                Greenhouse Impact
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center p-2 rounded-lg bg-gradient-to-r from-green-50 to-emerald-50">
                  <span className="text-[10px] font-medium text-slate-600">
                    💨 Ventilation Efficiency
                  </span>
                  <span className="text-xs font-black text-green-600">
                    High ↑
                  </span>
                </div>
                <div className="flex justify-between items-center p-2 rounded-lg bg-gradient-to-r from-amber-50 to-orange-50">
                  <span className="text-[10px] font-medium text-slate-600">
                    💧 Irrigation Need
                  </span>
                  <span className="text-xs font-black text-amber-600">
                    Moderate →
                  </span>
                </div>
                <div className="flex justify-between items-center p-2 rounded-lg bg-gradient-to-r from-green-50 to-emerald-50">
                  <span className="text-[10px] font-medium text-slate-600">
                    🔥 Heating Required
                  </span>
                  <span className="text-xs font-black text-green-600">
                    None ✓
                  </span>
                </div>
              </div>
            </div>

            {/* Sun & Moon Info - Original Style */}
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl p-5 text-white shadow-xl">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <Sunrise size={16} className="text-amber-400" />
                  <span className="text-xs font-bold uppercase tracking-wider">
                    SUN & MOON
                  </span>
                </div>
                <MoonStar size={16} className="text-slate-400" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-white/50 text-[10px]">Sunrise</p>
                  <p className="text-base font-black">06:15 AM</p>
                </div>
                <div>
                  <p className="text-white/50 text-[10px]">Sunset</p>
                  <p className="text-base font-black">07:08 PM</p>
                </div>
                <div>
                  <p className="text-white/50 text-[10px]">Moon Phase</p>
                  <p className="text-base font-black">Waxing Gibbous</p>
                </div>
                <div>
                  <p className="text-white/50 text-[10px]">Daylight Hours</p>
                  <p className="text-base font-black">12h 53m</p>
                </div>
              </div>
            </div>

            {/* Air Quality Info */}
            <div className="bg-white/80 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-white/50">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-black text-slate-800 flex items-center gap-2">
                  <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center">
                    <Wind size={12} className="text-white" />
                  </div>
                  Air Quality
                </h3>
                <span className="text-[9px] font-bold text-green-600 bg-gradient-to-r from-green-50 to-emerald-50 px-2 py-0.5 rounded-full">
                  ✅ Good
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex justify-between text-[9px] text-slate-400 mb-1">
                    <span>PM2.5</span>
                    <span>12 µg/m³</span>
                  </div>
                  <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-green-500 to-emerald-500 h-full rounded-full"
                      style={{ width: "24%" }}
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-[9px] text-slate-400 mb-1">
                    <span>PM10</span>
                    <span>28 µg/m³</span>
                  </div>
                  <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-green-500 to-emerald-500 h-full rounded-full"
                      style={{ width: "28%" }}
                    />
                  </div>
                </div>
              </div>
              <p className="text-[9px] text-slate-400 mt-3 flex items-center gap-1">
                ✨ Air quality is excellent for greenhouse ventilation
              </p>
            </div>

            {/* Quick Note */}
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl p-4 border border-amber-200 shadow-sm">
              <p className="text-[10px] font-bold text-amber-700 flex items-center gap-2">
                <div className="p-1 rounded-lg bg-amber-100">
                  <Umbrella size={12} className="text-amber-600" />
                </div>
                Weather Tip
              </p>
              <p className="text-[9px] text-amber-700 mt-1 leading-relaxed">
                Low wind speeds expected. Perfect conditions for opening vents
                without pest intrusion risk. 🌿
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
