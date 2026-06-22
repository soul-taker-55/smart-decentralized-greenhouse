// app/alerts-center/page.js
"use client";

import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Bell,
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  Clock,
  Wifi,
  Droplets,
  Zap,
  Thermometer,
  Activity,
  ChevronRight,
  BellRing,
  BellOff,
  Eye,
  EyeOff,
  Filter,
  Search,
} from "lucide-react";

// --- Animated Alert Card ---
const AlertCard = ({
  type,
  title,
  message,
  time,
  status,
  onAcknowledge,
  onDismiss,
}) => {
  const getTypeStyles = () => {
    switch (type) {
      case "critical":
        return {
          bg: "bg-gradient-to-r from-red-50 to-rose-50",
          border: "border-red-200",
          iconBg: "bg-red-500",
          icon: AlertTriangle,
          textColor: "text-red-700",
        };
      case "warning":
        return {
          bg: "bg-gradient-to-r from-orange-50 to-amber-50",
          border: "border-orange-200",
          iconBg: "bg-orange-500",
          icon: AlertTriangle,
          textColor: "text-orange-700",
        };
      case "info":
        return {
          bg: "bg-gradient-to-r from-blue-50 to-cyan-50",
          border: "border-blue-200",
          iconBg: "bg-blue-500",
          icon: Info,
          textColor: "text-blue-700",
        };
      case "success":
        return {
          bg: "bg-gradient-to-r from-green-50 to-emerald-50",
          border: "border-green-200",
          iconBg: "bg-green-500",
          icon: CheckCircle2,
          textColor: "text-green-700",
        };
      default:
        return {
          bg: "bg-gray-50",
          border: "border-gray-200",
          iconBg: "bg-gray-500",
          icon: Info,
          textColor: "text-gray-700",
        };
    }
  };

  const styles = getTypeStyles();
  const IconComponent = styles.icon;

  return (
    <div
      className={`relative p-4 rounded-2xl ${styles.bg} border ${styles.border} shadow-sm hover:shadow-md transition-all group overflow-hidden`}
    >
      <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-to-br from-white/20 to-transparent rounded-full blur-xl" />

      <div className="relative z-10 flex items-start gap-4">
        <div className={`p-2 rounded-xl ${styles.iconBg} shadow-lg shrink-0`}>
          <IconComponent size={18} className="text-white" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
            <h4 className={`text-sm font-black ${styles.textColor}`}>
              {title}
            </h4>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-slate-400 flex items-center gap-1">
                <Clock size={10} />
                {time}
              </span>
              {status === "unread" && (
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              )}
            </div>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed mb-3">
            {message}
          </p>

          <div className="flex items-center gap-3">
            {status === "unread" && onAcknowledge && (
              <button
                onClick={onAcknowledge}
                className="text-[10px] font-bold px-3 py-1 rounded-full bg-white/80 hover:bg-white text-slate-600 hover:text-[#005C3F] transition-all shadow-sm flex items-center gap-1"
              >
                <CheckCircle2 size={10} />
                Acknowledge
              </button>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="text-[10px] font-bold px-3 py-1 rounded-full bg-white/50 hover:bg-white/80 text-slate-400 hover:text-slate-600 transition-all"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Stat Summary Card ---
const StatSummaryCard = ({ label, count, color, icon: Icon, trend }) => (
  <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 hover:shadow-md transition-all">
    <div className="flex items-center justify-between mb-2">
      <div className={`p-2 rounded-xl ${color}`}>
        <Icon size={16} className="text-white" />
      </div>
      {trend && (
        <span className="text-[9px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full">
          {trend}
        </span>
      )}
    </div>
    <p className="text-2xl font-black text-slate-800">{count}</p>
    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mt-1">
      {label}
    </p>
  </div>
);

// --- Notification Preference Toggle ---
const PreferenceToggle = ({ label, enabled, icon: Icon, onToggle }) => (
  <div className="flex items-center justify-between py-2">
    <div className="flex items-center gap-2">
      <Icon size={14} className="text-slate-400" />
      <span className="text-xs font-medium text-slate-600">{label}</span>
    </div>
    <button
      onClick={onToggle}
      className={`relative w-8 h-4 rounded-full transition-all ${
        enabled ? "bg-[#10B981]" : "bg-slate-300"
      }`}
    >
      <div
        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${
          enabled ? "right-0.5" : "left-0.5"
        }`}
      />
    </button>
  </div>
);

// --- Filter Chip ---
const FilterChip = ({ label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${
      active
        ? "bg-[#005C3F] text-white shadow-md"
        : "bg-white text-slate-500 border border-slate-200 hover:border-[#005C3F]/30"
    }`}
  >
    {label}
  </button>
);

// --- Main Page Component ---
export default function AlertsCenterPage() {
  const [alerts, setAlerts] = useState([
    {
      id: 1,
      type: "warning",
      title: "Humidity Level Rising",
      message:
        "Humidity has increased to 68% and continues to trend upward. Consider increasing ventilation.",
      time: "5 min ago",
      status: "unread",
    },
    {
      id: 2,
      type: "success",
      title: "Irrigation Cycle Complete",
      message:
        "Zone A (Tomatoes) irrigation completed successfully. 45L of water distributed.",
      time: "15 min ago",
      status: "read",
    },
    {
      id: 3,
      type: "info",
      title: "Scheduled Maintenance",
      message:
        "System firmware update scheduled for tonight at 02:00 AM. Estimated downtime: 5 minutes.",
      time: "1 hour ago",
      status: "unread",
    },
    {
      id: 4,
      type: "critical",
      title: "Water Pressure Drop Detected",
      message:
        "Water pressure in main line dropped by 30%. Checking for possible leaks in Zone B.",
      time: "2 hours ago",
      status: "unread",
    },
    {
      id: 5,
      type: "success",
      title: "Solar Peak Efficiency",
      message:
        "Solar panels operating at 94% efficiency. 560W generated in last hour.",
      time: "3 hours ago",
      status: "read",
    },
  ]);

  const [filter, setFilter] = useState("all");
  const [showRead, setShowRead] = useState(true);
  const [preferences, setPreferences] = useState({
    critical: true,
    warnings: true,
    info: true,
    success: false,
  });

  // Stats
  const stats = {
    critical: alerts.filter((a) => a.type === "critical").length,
    warning: alerts.filter((a) => a.type === "warning").length,
    info: alerts.filter((a) => a.type === "info").length,
    success: alerts.filter((a) => a.type === "success").length,
    unread: alerts.filter((a) => a.status === "unread").length,
  };

  const handleAcknowledge = (id) => {
    setAlerts((prev) =>
      prev.map((alert) =>
        alert.id === id ? { ...alert, status: "read" } : alert,
      ),
    );
  };

  const handleDismiss = (id) => {
    setAlerts((prev) => prev.filter((alert) => alert.id !== id));
  };

  const getFilteredAlerts = () => {
    let filtered = alerts;

    if (filter !== "all") {
      filtered = filtered.filter((alert) => alert.type === filter);
    }

    if (!showRead) {
      filtered = filtered.filter((alert) => alert.status === "unread");
    }

    return filtered;
  };

  const filteredAlerts = getFilteredAlerts();

  // API Data (same structure as your pages)
  const apiData = {
    house_metadata: {
      system_status: "Online",
      last_sync: "2026-04-01T23:15:00Z",
      location: "Syria - Damascus",
      firmware_version: "v2.5.0",
      uptime: "15 days, 4 hours",
    },
    security_alerts: [
      { type: "Intrusion", status: "Clear", camera_feed: "Active" },
      { type: "Fire_Smoke", status: "Clear" },
      { type: "Leak_Detection", status: "Clear" },
    ],
    environmental_sensors: {
      humidity: {
        value: 68,
        unit: "%",
        status: "Warning_High",
        trend: "Rising",
      },
      temperature: { value: 24.5, unit: "°C", status: "Optimal" },
    },
  };

  return (
    <div className="min-h-screen bg-[#F0F4F2] p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
          <div>
            <nav className="flex items-center gap-2 text-xs text-slate-400 mb-2 font-medium">
              <span>Home</span> <ChevronRight size={12} />{" "}
              <span className="text-[#005C3F] font-bold">Alerts Center</span>
            </nav>
            <h1 className="text-3xl md:text-4xl font-black text-[#005C3F] tracking-tight flex items-center gap-3">
              <BellRing className="text-[#005C3F]" size={32} />
              Security Command Center
            </h1>
            <p className="text-slate-500 text-sm mt-1">
              Real-time alerts and system notifications for Damascus Greenhouse.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* System Status Badge */}
            <div className="bg-white px-4 py-2 rounded-2xl shadow-sm border border-slate-100">
              <p className="text-[9px] font-bold text-slate-400 uppercase">
                System Health
              </p>
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <p className="text-xs font-black text-[#10B981]">
                  {apiData.house_metadata.system_status.toUpperCase()}
                </p>
              </div>
            </div>

            {/* Unread Badge */}
            {stats.unread > 0 && (
              <div className="relative">
                <div className="bg-red-500 text-white px-3 py-2 rounded-2xl shadow-lg flex items-center gap-2">
                  <Bell size={14} />
                  <span className="text-xs font-black">{stats.unread} New</span>
                </div>
                <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-300 animate-ping" />
              </div>
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Content - Alerts Feed */}
          <div className="lg:col-span-2 space-y-6">
            {/* Stats Summary Row */}
            <div className="grid grid-cols-5 gap-3">
              <StatSummaryCard
                label="Critical"
                count={stats.critical}
                color="bg-red-500"
                icon={AlertTriangle}
              />
              <StatSummaryCard
                label="Warnings"
                count={stats.warning}
                color="bg-orange-500"
                icon={AlertTriangle}
                trend="+1"
              />
              <StatSummaryCard
                label="Info"
                count={stats.info}
                color="bg-blue-500"
                icon={Info}
              />
              <StatSummaryCard
                label="Success"
                count={stats.success}
                color="bg-green-500"
                icon={CheckCircle2}
              />
              <StatSummaryCard
                label="Unread"
                count={stats.unread}
                color="bg-purple-500"
                icon={Bell}
              />
            </div>

            {/* Filter Bar */}
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  <FilterChip
                    label="All"
                    active={filter === "all"}
                    onClick={() => setFilter("all")}
                  />
                  <FilterChip
                    label="Critical"
                    active={filter === "critical"}
                    onClick={() => setFilter("critical")}
                  />
                  <FilterChip
                    label="Warnings"
                    active={filter === "warning"}
                    onClick={() => setFilter("warning")}
                  />
                  <FilterChip
                    label="Info"
                    active={filter === "info"}
                    onClick={() => setFilter("info")}
                  />
                  <FilterChip
                    label="Success"
                    active={filter === "success"}
                    onClick={() => setFilter("success")}
                  />
                </div>

                <button
                  onClick={() => setShowRead(!showRead)}
                  className="flex items-center gap-2 text-[11px] font-bold text-slate-500 hover:text-[#005C3F] transition-colors"
                >
                  {showRead ? <Eye size={14} /> : <EyeOff size={14} />}
                  {showRead ? "Show All" : "Unread Only"}
                </button>
              </div>
            </div>

            {/* Alerts Feed */}
            <div className="space-y-3">
              {filteredAlerts.length === 0 ? (
                <div className="bg-white rounded-2xl p-8 text-center border border-slate-100">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
                    <ShieldCheck size={32} className="text-green-500" />
                  </div>
                  <p className="text-sm font-black text-slate-800">
                    No alerts found
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    All systems are operating normally
                  </p>
                </div>
              ) : (
                filteredAlerts.map((alert) => (
                  <AlertCard
                    key={alert.id}
                    {...alert}
                    onAcknowledge={() => handleAcknowledge(alert.id)}
                    onDismiss={() => handleDismiss(alert.id)}
                  />
                ))
              )}
            </div>

            {/* Security Status from API */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-[#005C3F] mb-3 flex items-center gap-2">
                <ShieldCheck size={16} />
                Security Systems Status
              </h3>
              <div className="grid grid-cols-3 gap-3">
                {apiData.security_alerts.map((alert, idx) => (
                  <div
                    key={idx}
                    className="text-center p-3 rounded-xl bg-[#F0F4F2]"
                  >
                    <div
                      className={`w-2 h-2 rounded-full mx-auto mb-2 ${
                        alert.status === "Clear"
                          ? "bg-green-500"
                          : "bg-red-500 animate-pulse"
                      }`}
                    />
                    <p className="text-[10px] font-bold text-slate-600">
                      {alert.type}
                    </p>
                    <p className="text-[9px] font-semibold text-slate-400 mt-0.5">
                      {alert.status}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Sidebar */}
          <div className="space-y-6">
            {/* Current Status Widget */}
            <div className="bg-gradient-to-br from-[#005C3F] to-[#0a8a5c] rounded-2xl p-5 text-white shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] font-bold text-white/60 uppercase tracking-wider">
                  Live Status
                </span>
                <Wifi size={14} className="text-white/60" />
              </div>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-white/80">System Uptime</span>
                  <span className="text-sm font-black">
                    {apiData.house_metadata.uptime}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-white/80">Last Sync</span>
                  <span className="text-xs font-mono">
                    {new Date(
                      apiData.house_metadata.last_sync,
                    ).toLocaleTimeString()}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-white/80">Firmware</span>
                  <span className="text-xs font-mono">
                    {apiData.house_metadata.firmware_version}
                  </span>
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-white/20">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-white/80">Active Sensors</span>
                  <span className="text-sm font-black">24/24 Online</span>
                </div>
              </div>
            </div>

            {/* Notification Preferences */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-[#005C3F] mb-3 flex items-center gap-2">
                <Bell size={14} />
                Notification Preferences
              </h3>
              <div className="space-y-2">
                <PreferenceToggle
                  label="Critical Alerts"
                  enabled={preferences.critical}
                  icon={AlertTriangle}
                  onToggle={() =>
                    setPreferences({
                      ...preferences,
                      critical: !preferences.critical,
                    })
                  }
                />
                <PreferenceToggle
                  label="Warnings"
                  enabled={preferences.warnings}
                  icon={Activity}
                  onToggle={() =>
                    setPreferences({
                      ...preferences,
                      warnings: !preferences.warnings,
                    })
                  }
                />
                <PreferenceToggle
                  label="Info Updates"
                  enabled={preferences.info}
                  icon={Info}
                  onToggle={() =>
                    setPreferences({ ...preferences, info: !preferences.info })
                  }
                />
                <PreferenceToggle
                  label="Success Events"
                  enabled={preferences.success}
                  icon={CheckCircle2}
                  onToggle={() =>
                    setPreferences({
                      ...preferences,
                      success: !preferences.success,
                    })
                  }
                />
              </div>
            </div>

            {/* Environmental Snapshot */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-[#005C3F] mb-3 flex items-center gap-2">
                <Thermometer size={14} />
                Environment Snapshot
              </h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Droplets size={12} className="text-blue-500" />
                    <span className="text-xs text-slate-600">Humidity</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-black ${
                        apiData.environmental_sensors.humidity.status ===
                        "Warning_High"
                          ? "text-orange-500"
                          : "text-green-500"
                      }`}
                    >
                      {apiData.environmental_sensors.humidity.value}%
                    </span>
                    <span className="text-[9px] text-orange-500 animate-pulse">
                      ↑ Rising
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Thermometer size={12} className="text-red-400" />
                    <span className="text-xs text-slate-600">Temperature</span>
                  </div>
                  <span className="text-xs font-black text-slate-800">
                    {apiData.environmental_sensors.temperature.value}°C
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm font-black text-[#005C3F] mb-3">
                Quick Actions
              </h3>
              <div className="space-y-2">
                <button className="w-full text-left px-3 py-2 rounded-xl bg-[#F0F4F2] hover:bg-[#e0e6e2] transition-colors text-xs font-medium text-slate-700 flex items-center justify-between">
                  <span>Mark all as read</span>
                  <CheckCircle2 size={12} />
                </button>
                <button className="w-full text-left px-3 py-2 rounded-xl bg-[#F0F4F2] hover:bg-[#e0e6e2] transition-colors text-xs font-medium text-slate-700 flex items-center justify-between">
                  <span>Export alert log</span>
                  <BellOff size={12} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
