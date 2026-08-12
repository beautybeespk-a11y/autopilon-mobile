import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";

import Landing from "./pages/Landing.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";

import Dashboard from "./pages/Dashboard.jsx";
import Chat from "./pages/Chat.jsx";
import Agents from "./pages/Agents.jsx";
import Organizations from "./pages/Organizations.jsx";
import OrganizationDetail from "./pages/OrganizationDetail.jsx";
import OrganizationDashboard from "./pages/OrganizationDashboard.jsx";
import AdminPanel from "./pages/AdminPanel.jsx";
import Marketplace from "./pages/Marketplace.jsx";
import MarketplaceAssetDetail from "./pages/MarketplaceAssetDetail.jsx";
import MyMarketplaceAssets from "./pages/MyMarketplaceAssets.jsx";
import CreatorDashboard from "./pages/CreatorDashboard.jsx";
import DeveloperTools from "./pages/DeveloperTools.jsx";
import MyInstalls from "./pages/MyInstalls.jsx";
import AgentLibrary from "./pages/AgentLibrary.jsx";
import AgentDashboard from "./pages/AgentDashboard.jsx";
import AgentBuilder from "./pages/AgentBuilder.jsx";
import Skills from "./pages/Skills.jsx";
import Automations from "./pages/Automations.jsx";
import AutomationBuilder from "./pages/AutomationBuilder.jsx";
import Integrations from "./pages/Integrations.jsx";
import Files from "./pages/Files.jsx";
import ContentStudio from "./pages/ContentStudio.jsx";
import SharedFile from "./pages/SharedFile.jsx";
import Knowledge from "./pages/Knowledge.jsx";
import Tasks from "./pages/Tasks.jsx";
import Activity from "./pages/Activity.jsx";
import Settings from "./pages/Settings.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/share/:token" element={<SharedFile />} />

      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<Chat />} />
        <Route path="agents" element={<Agents />} />
        <Route path="organizations" element={<Organizations />} />
        <Route path="organizations/:id" element={<OrganizationDetail />} />
        <Route path="organizations/:id/dashboard" element={<OrganizationDashboard />} />
        <Route path="admin" element={<AdminPanel />} />
        <Route path="marketplace" element={<Marketplace />} />
        <Route path="marketplace/mine" element={<MyMarketplaceAssets />} />
        <Route path="marketplace/creator-dashboard" element={<CreatorDashboard />} />
        <Route path="developer-tools" element={<DeveloperTools />} />
        <Route path="marketplace/installs" element={<MyInstalls />} />
        <Route path="marketplace/:id" element={<MarketplaceAssetDetail />} />
        <Route path="agents/library" element={<AgentLibrary />} />
        <Route path="agents/analytics" element={<AgentDashboard />} />
        <Route path="agents/new" element={<AgentBuilder />} />
        <Route path="agents/:id/edit" element={<AgentBuilder />} />
        <Route path="skills" element={<Skills />} />
        <Route path="automations" element={<Automations />} />
        <Route path="automations/new" element={<AutomationBuilder />} />
        <Route path="automations/:id/edit" element={<AutomationBuilder />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="files" element={<Files />} />
        <Route path="content-studio" element={<ContentStudio />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="activity" element={<Activity />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
