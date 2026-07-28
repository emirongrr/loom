import type { NavigationArea } from "../types";

export const primaryNavigation: readonly { id: NavigationArea; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "activity", label: "Activity", icon: "↻" },
  { id: "apps", label: "Apps", icon: "◇" },
  { id: "security", label: "Security", icon: "◆" }
];
