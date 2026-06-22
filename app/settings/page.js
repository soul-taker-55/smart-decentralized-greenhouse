// app/settings/page.js
"use client";

import { Settings } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="bg-white p-8 rounded-[3rem] shadow-sm">
      <h2 className="text-2xl font-bold text-[#005C3F] mb-6 flex items-center gap-2">
        <Settings className="text-[#005C3F]" /> Settings
      </h2>
      <p className="text-slate-500">
        System settings and preferences will be available soon.
      </p>
    </div>
  );
}
