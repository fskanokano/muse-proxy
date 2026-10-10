import { HashRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { clearToken, getToken } from "./api";
import { cx } from "./components/ui";
import Login from "./pages/Login";
import Egress from "./pages/Egress";
import Logs from "./pages/Logs";

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Shell({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-10">
      <header className="flex flex-wrap items-center gap-3 py-5">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight">muse-proxy · 后台管理</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{title}</p>
        </div>
        <nav className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
          {[
            { to: "/egress", label: "出口模式" },
            { to: "/logs", label: "日志查看" },
          ].map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cx(
                  "rounded-md px-3 py-1.5 text-[12px] font-medium",
                  isActive ? "bg-muted text-foreground shadow" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
          <button
            onClick={() => {
              clearToken();
              location.hash = "#/login";
            }}
            className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
          >
            退出
          </button>
        </nav>
      </header>
      {children}
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/egress" element={<RequireAuth><Shell title="动态出口 IP：主出口 / 副出口轮询"><Egress /></Shell></RequireAuth>} />
        <Route path="/logs" element={<RequireAuth><Shell title="结构化请求日志 · 5s 自动刷新"><Logs /></Shell></RequireAuth>} />
        <Route path="*" element={<Navigate to="/egress" replace />} />
      </Routes>
    </HashRouter>
  );
}
