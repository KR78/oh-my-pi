/**
 * Mounts one direction: resolves light/dark, lays the direction's tokens and
 * then the customer seam on a root element as CSS variables, provides the
 * brand, and renders the direction's `App`.
 *
 * Tokens go on the root as inline custom properties rather than a stylesheet
 * per direction, so switching direction in the gallery cannot leave another
 * direction's variables behind, and a customer override always wins by
 * coming last in the same object.
 */
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo } from "react";
import type { GuestClient, GuestSnapshot } from "../lib/client";
import { useThemePreference } from "../lib/theme";
import { BrandContext } from "./kit/brand";
import type { CustomerTheme, ThemeMode } from "./theme-seam";
import { seamVariables } from "./theme-seam";
import type { Direction } from "./types";

export interface DirectionHostProps {
	direction: Direction;
	client: GuestClient;
	snapshot: GuestSnapshot;
	theme: CustomerTheme;
	/** Gallery override; otherwise the visitor's preference, then the theme's default. */
	forcedMode: ThemeMode | null;
	onRejoin(): void;
	onLeave(): void;
}

export function useResolvedMode(theme: CustomerTheme, forcedMode: ThemeMode | null): ThemeMode {
	const { preference, resolved } = useThemePreference();
	if (forcedMode) return forcedMode;
	if (preference === "system" && theme.defaultMode !== "system") return theme.defaultMode;
	return resolved;
}

export function DirectionHost(props: DirectionHostProps): ReactNode {
	const { direction, theme, forcedMode } = props;
	const mode = useResolvedMode(theme, forcedMode);
	// Classic and the page background read the global theme attribute; keep it in step with a forced mode.
	useEffect(() => {
		document.documentElement.dataset.theme = mode;
		document.documentElement.style.colorScheme = mode;
	}, [mode]);
	const style = useMemo(() => {
		const vars: Record<string, string> = { colorScheme: mode };
		for (const [name, value] of Object.entries(direction.tokens[mode])) vars[`--${name}`] = value;
		for (const [name, value] of Object.entries(seamVariables(theme, mode))) vars[`--${name}`] = value;
		return vars as CSSProperties;
	}, [direction, theme, mode]);
	const App = direction.App;
	return (
		<BrandContext.Provider value={theme}>
			<div
				className={`dx-root dx-${direction.id}`}
				data-mode={mode}
				data-shot={props.snapshot.phase === "live" ? "ready" : undefined}
				style={style}
			>
				<App client={props.client} snapshot={props.snapshot} onRejoin={props.onRejoin} onLeave={props.onLeave} />
			</div>
		</BrandContext.Provider>
	);
}
