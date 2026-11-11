/**
 * The agent's name and mark, through the theme seam. Every direction draws
 * the brand with these two components, so a customer theme renames and
 * re-marks every direction the same way.
 */
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { CustomerTheme } from "../theme-seam";
import { OZ_THEME, safeBrandLogo, safeBrandName } from "../theme-seam";

export const BrandContext = createContext<CustomerTheme>(OZ_THEME);

export function useBrandName(): string {
	return safeBrandName(useContext(BrandContext));
}

/**
 * The Oz mark: a ring broken at the upper right, with a dot in the gap, the
 * shape of a spinner that has stopped to look at you. Drawn in `currentColor`
 * so each direction tints it with its own accent.
 */
function OzMark({ size }: { size: number }): ReactNode {
	return (
		<svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
			<path
				d="M24.5 9.2A11 11 0 1 0 27 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="4.2"
				strokeLinecap="round"
			/>
			<circle cx="26.6" cy="6.6" r="2.6" fill="currentColor" />
		</svg>
	);
}

export function BrandMark({ size = 20, className }: { size?: number; className?: string }): ReactNode {
	const theme = useContext(BrandContext);
	const logo = safeBrandLogo(theme);
	return (
		<span className={className} style={{ display: "inline-flex", width: size, height: size, flex: "none" }}>
			{logo ? <img src={logo} width={size} height={size} alt="" /> : <OzMark size={size} />}
		</span>
	);
}
