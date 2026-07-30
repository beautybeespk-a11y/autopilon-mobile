import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar.jsx";
import MobileNav from "./MobileNav.jsx";
import Topbar from "./Topbar.jsx";

export default function Layout() {
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <Topbar />
        <main className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
