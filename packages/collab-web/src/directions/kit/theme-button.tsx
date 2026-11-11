/** Light / dark / system switch. Each direction styles it through `className`. */
import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import type { ThemePreference } from "../../lib/theme";
import { useThemePreference } from "../../lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemePreference, string> = {
	system: "Theme follows your system. Switch to light",
	light: "Light theme. Switch to dark",
	dark: "Dark theme. Switch to follow your system",
};

export function ThemeButton({ className, size = 16 }: { className?: string; size?: number }): ReactNode {
	const { preference, setPreference } = useThemePreference();
	const Icon = preference === "light" ? Sun : preference === "dark" ? Moon : Monitor;
	return (
		<button
			type="button"
			className={className}
			onClick={() => setPreference(NEXT[preference])}
			aria-label={LABEL[preference]}
			title={LABEL[preference]}
		>
			<Icon size={size} aria-hidden="true" />
		</button>
	);
}
