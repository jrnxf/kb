import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const DARK = matchMedia("(prefers-color-scheme: dark)");

function stored(): Theme {
  try {
    const theme = localStorage.getItem("kb-theme");
    if (theme === "light" || theme === "dark") return theme;
  } catch {}
  return "system";
}

/** The theme follows the system until the person picks one. Only a pick that is not "system" is kept. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored);
  const systemDark = useSyncExternalStore((change) => (DARK.addEventListener("change", change), () => DARK.removeEventListener("change", change)), () => DARK.matches);
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
    try {
      if (theme === "system") localStorage.removeItem("kb-theme");
      else localStorage.setItem("kb-theme", theme);
    } catch {}
  }, [theme, resolved]);
  const next = useCallback(() => setTheme((t) => NEXT[t]), []);
  return { theme, resolved, next } as const;
}
