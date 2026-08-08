import {
  LayoutDashboard, MessageSquare, Bot, BarChart3, Wrench, Zap, Puzzle,
  BookOpen, ListChecks, Activity, Settings, Building2, Store, Code2,
} from "lucide-react";

export const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/chat", label: "AI Chat", icon: MessageSquare },
  { to: "/app/agents", label: "My Agents", icon: Bot },
  { to: "/app/agents/analytics", label: "Agent Analytics", icon: BarChart3 },
  { to: "/app/organizations", label: "Organizations", icon: Building2 },
  { to: "/app/marketplace", label: "Marketplace", icon: Store },
  { to: "/app/developer-tools", label: "Developer Tools", icon: Code2 },
  { to: "/app/skills", label: "Skills", icon: Wrench },
  { to: "/app/automations", label: "Automations", icon: Zap },
  { to: "/app/integrations", label: "Integrations", icon: Puzzle },
  { to: "/app/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/app/tasks", label: "Tasks", icon: ListChecks },
  { to: "/app/activity", label: "Activity", icon: Activity },
  { to: "/app/settings", label: "Settings", icon: Settings },
];

// Primary items surfaced in the mobile bottom bar; the rest live in the drawer.
export const MOBILE_PRIMARY = ["/app", "/app/chat", "/app/agents", "/app/integrations"];
