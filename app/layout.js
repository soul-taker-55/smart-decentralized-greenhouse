// app/layout.js
"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Thermometer,
  Sprout,
  Droplets,
  Zap,
  ShieldCheck,
  CloudSun,
  Settings,
} from "lucide-react";
import "./globals.css";

// تعريف NavItem داخل layout نفسه
const NavItem = ({ icon, label, active, onClick }) => {
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-4 px-4 py-3.5 rounded-2xl cursor-pointer transition-all ${
        active
          ? "bg-[#005C3F] text-white shadow-xl shadow-emerald-100"
          : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"
      }`}
    >
      {icon}
      <span className="font-bold text-sm tracking-tight">{label}</span>
    </div>
  );
};

export default function RootLayout({ children }) {
  const pathname = usePathname();
  const router = useRouter();

  const getActiveFromPath = (path) => {
    if (path === "/") return "Overview";
    if (path === "/climate-air") return "Climate";
    if (path === "/soil-irrigation") return "Soil";
    if (path === "/water-system") return "Water";
    if (path === "/energy-hub") return "Energy";
    if (path === "/alerts-center") return "Alerts";
    if (path === "/weather-forecast") return "Weather";
    if (path === "/settings") return "Settings";
    return "Overview";
  };

  const activeMenu = getActiveFromPath(pathname);

  const mainMenuItems = [
    {
      id: "Overview",
      path: "/",
      icon: <LayoutDashboard size={20} />,
      label: "Overview",
    },
    {
      id: "Climate",
      path: "/climate-air",
      icon: <Thermometer size={20} />,
      label: "Climate & Air",
    },
    {
      id: "Soil",
      path: "/soil-irrigation",
      icon: <Sprout size={20} />,
      label: "Soil & Irrigation",
    },
    {
      id: "Water",
      path: "/water-system",
      icon: <Droplets size={20} />,
      label: "Water System",
    },
    {
      id: "Energy",
      path: "/energy-hub",
      icon: <Zap size={20} />,
      label: "Energy Hub",
    },
  ];

  const securityMenuItems = [
    {
      id: "Alerts",
      path: "/alerts-center",
      icon: <ShieldCheck size={20} />,
      label: "Alerts Center",
    },
    {
      id: "Weather",
      path: "/weather-forecast",
      icon: <CloudSun size={20} />,
      label: "Weather Forecast",
    },
  ];

  const handleNavigation = (path) => {
    router.push(path);
  };

  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen bg-[#F0F4F2] text-slate-800 font-sans p-6 gap-6">
          {/* Sidebar */}
          <aside className="w-72 bg-white rounded-[2.5rem] p-8 shadow-sm flex flex-col border border-slate-100">
            <div
              className="flex items-center gap-3 mb-10 font-bold text-2xl text-[#005C3F] cursor-pointer"
              onClick={() => handleNavigation("/")}
            >
              <div className="bg-[#005C3F] p-2 rounded-xl text-white">
                <Sprout size={24} />
              </div>
              SmartFarm
            </div>

            <nav className="space-y-1 flex-1">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-4 px-2">
                Main Menu
              </p>
              {mainMenuItems.map((item) => (
                <NavItem
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={activeMenu === item.id}
                  onClick={() => handleNavigation(item.path)}
                />
              ))}

              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mt-8 mb-4 px-2">
                Security
              </p>
              {securityMenuItems.map((item) => (
                <NavItem
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={activeMenu === item.id}
                  onClick={() => handleNavigation(item.path)}
                />
              ))}
            </nav>

            <div className="pt-6 border-t border-slate-100">
              <NavItem
                icon={<Settings size={20} />}
                label="Settings"
                active={activeMenu === "Settings"}
                onClick={() => handleNavigation("/settings")}
              />
            </div>
          </aside>

          {/* المحتوى الرئيسي من الصفحات الفرعية */}
          <main className="flex-1 space-y-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
