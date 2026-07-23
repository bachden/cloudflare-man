import {
  Activity,
  Code2,
  CloudCog,
  Menu,
  ScrollText,
  Settings,
  Store as StoreIcon,
  X
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";

const navigation = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/accounts", label: "Account pool", icon: CloudCog },
  { to: "/stores", label: "Stores", icon: StoreIcon },
  { to: "/scripts", label: "Script library", icon: Code2 },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children, username }: { children: ReactNode; username: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><CloudCog size={21} /></div>
          <div><strong>cloudflare-man</strong><span>DCorp operations</span></div>
          <button className="sidebar-close" type="button" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={19} /></button>
        </div>
        <nav>
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"} onClick={() => setMenuOpen(false)}>
              <Icon size={17} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><div><strong>{username}</strong><span>Administrator</span></div></div>
      </aside>
      <div className="main-frame">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
          <strong>cloudflare-man</strong>
        </header>
        <main>{children}</main>
      </div>
      {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
