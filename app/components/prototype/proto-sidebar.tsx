// PROTOTYPE — throwaway copy of the real Sidebar with insertion slots for
// the Notification Feed UI prototype (wayfinder ticket "What does the
// Notification Feed look like in Cadence?"). Not production code; lives on
// the prototype branch only. The real app/components/sidebar.tsx is
// untouched; this copy exists so each variant can place its bell freely.
import { NavLink, Form } from "react-router";
import { useState, useEffect, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { UserRole } from "~/db/schema";
import { UserAvatar } from "~/components/user-avatar";
import {
  BookOpen,
  Bell,
  ChartColumn,
  LayoutDashboard,
  GraduationCap,
  MessageSquare,
  Shield,
  Tag,
  Receipt,
  Users,
  UsersRound,
  Moon,
  Sun,
  LogOut,
  Settings,
} from "lucide-react";

interface CurrentUser {
  id: number;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
}

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
  roles: UserRole[] | "all";
}

const navItems: NavItem[] = [
  { label: "Browse Courses", to: "/courses", icon: <BookOpen className="size-4" />, roles: "all" },
  { label: "Dashboard", to: "/dashboard", icon: <LayoutDashboard className="size-4" />, roles: [UserRole.Student] },
  { label: "My Courses", to: "/instructor", icon: <GraduationCap className="size-4" />, roles: [UserRole.Instructor] },
  { label: "Analytics", to: "/instructor/analytics", icon: <ChartColumn className="size-4" />, roles: [UserRole.Instructor, UserRole.Admin] },
  { label: "Questions", to: "/instructor/questions", icon: <MessageSquare className="size-4" />, roles: [UserRole.Instructor, UserRole.Admin] },
  { label: "Manage Users", to: "/admin/users", icon: <Users className="size-4" />, roles: [UserRole.Admin] },
  { label: "Manage Courses", to: "/admin/courses", icon: <Shield className="size-4" />, roles: [UserRole.Admin] },
  { label: "Categories", to: "/admin/categories", icon: <Tag className="size-4" />, roles: [UserRole.Admin] },
  { label: "Refund Requests", to: "/admin/refunds", icon: <Receipt className="size-4" />, roles: [UserRole.Admin] },
];

function isVisible(item: NavItem, role: UserRole | null): boolean {
  if (item.roles === "all") return true;
  if (!role) return false;
  return item.roles.includes(role);
}

// Variant B: the feed lives as a nav item, badge and all.
function NotificationsNavItem({ count }: { count: number | null }) {
  return (
    <NavLink
      to="/prototype/notifications"
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )
      }
    >
      <Bell className="size-4" />
      Notifications
      {count ? (
        <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {count}
        </span>
      ) : null}
    </NavLink>
  );
}

export function ProtoSidebar({
  currentUser,
  isTeamAdmin = false,
  bellSlot,
  children,
  notificationsNavCount,
}: {
  currentUser: CurrentUser | null;
  isTeamAdmin?: boolean;
  /** Where the variant's bell renders: "header" (next to the logo) or "footer" (above the user row). */
  bellSlot?: "header" | "footer";
  /** Set (not undefined) to show the Notifications nav item with this unread count. */
  notificationsNavCount?: number | null;
  children?: ReactNode;
}) {
  const currentUserRole = currentUser?.role ?? null;
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggleDarkMode() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("cadence-theme", next ? "dark" : "light");
    } catch {}
  }

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <NavLink to="/" className="text-lg font-bold tracking-tight">
          Cadence
        </NavLink>
        {bellSlot === "header" && <div className="ml-auto">{children}</div>}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {navItems
          .filter((item) => isVisible(item, currentUserRole))
          .map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        {notificationsNavCount !== undefined && (
          <NotificationsNavItem count={notificationsNavCount} />
        )}
        {isTeamAdmin && (
          <NavLink
            to="/team"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <UsersRound className="size-4" />
            Team
          </NavLink>
        )}
      </nav>

      <div className="border-t border-sidebar-border p-3 space-y-1">
        {bellSlot === "footer" && children}
        <button
          onClick={toggleDarkMode}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {isDark ? "Light Mode" : "Dark Mode"}
        </button>

        {currentUser && (
          <div className="flex items-center gap-3 rounded-md px-3 py-2">
            <UserAvatar name={currentUser.name} avatarUrl={currentUser.avatarUrl} />
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium">{currentUser.name}</div>
              <div className="truncate text-xs capitalize text-sidebar-foreground/50">
                {currentUser.role}
              </div>
            </div>
            <NavLink
              to="/settings"
              title="Settings"
              className="rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Settings className="size-4" />
            </NavLink>
            <Form method="post" action="/api/logout">
              <button
                type="submit"
                title="Sign out"
                className="rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <LogOut className="size-4" />
              </button>
            </Form>
          </div>
        )}
      </div>
    </aside>
  );
}
