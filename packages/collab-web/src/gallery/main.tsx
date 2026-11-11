/**
 * Dev-only gallery: every direction against the running mock host, side by
 * side, with a light/dark switch and a 390 px frame.
 *
 * Each card is a live page in an iframe joined to the mock host's fixed dev
 * room (`bun scripts/mock-host.ts --dev-room`). The gallery builds the links
 * from the published test key in `dev/dev-room.ts`; it holds no real secret.
 */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { devLinks } from "../dev/dev-room";
import { DIRECTIONS } from "../directions/registry";
import thumbs from "./thumbs";
import "./gallery.css";

type Mode = "light" | "dark";
type Access = "full" | "view";
type Frame = "desktop" | "mobile";

const PREVIEWS = ["live", "waiting", "reconnecting", "ended"] as const;
type Preview = (typeof PREVIEWS)[number];

function pageUrl(id: string, mode: Mode, access: Access, preview: Preview, port: number): string {
	const links = devLinks(port);
	const params = new URLSearchParams({ direction: id, mode });
	if (preview !== "live") params.set("preview", preview);
	return `/?${params.toString()}#${access === "full" ? links.full : links.view}`;
}

function Segmented<T extends string>(props: {
	label: string;
	value: NoInfer<T>;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
}): ReactNode {
	return (
		<div className="gl-seg" role="radiogroup" aria-label={props.label}>
			<span className="gl-seg-label">{props.label}</span>
			{props.options.map(option => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={props.value === option.value}
					className="gl-seg-btn"
					onClick={() => props.onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

function Gallery(): ReactNode {
	const [mode, setMode] = useState<Mode>(() =>
		matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
	);
	const [frame, setFrame] = useState<Frame>("desktop");
	const [access, setAccess] = useState<Access>("full");
	const [preview, setPreview] = useState<Preview>("live");
	const [live, setLive] = useState(false);
	const port = useMemo(() => Number(new URLSearchParams(location.search).get("relay")) || 4766, []);

	return (
		<div className="gl-app" data-mode={mode}>
			<header className="gl-head">
				<div>
					<h1 className="gl-title">The live run page, six ways</h1>
					<p className="gl-sub">
						Each card is the real page, joined to the mock host. Open one to use it; type <code>/ask</code>,{" "}
						<code>/ask text</code> or <code>/end</code> in a steer composer to see a question or the ended state.
					</p>
				</div>
				<div className="gl-controls">
					<Segmented
						label="Mode"
						value={mode}
						onChange={setMode}
						options={[
							{ value: "light", label: "Light" },
							{ value: "dark", label: "Dark" },
						]}
					/>
					<Segmented
						label="Frame"
						value={frame}
						onChange={setFrame}
						options={[
							{ value: "desktop", label: "Desktop" },
							{ value: "mobile", label: "390 px" },
						]}
					/>
					<Segmented
						label="Link"
						value={access}
						onChange={setAccess}
						options={[
							{ value: "full", label: "Steer" },
							{ value: "view", label: "Watch" },
						]}
					/>
					<Segmented
						label="State"
						value={preview}
						onChange={setPreview}
						options={PREVIEWS.map(p => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))}
					/>
					<Segmented
						label="Cards"
						value={live ? "live" : "still"}
						onChange={v => setLive(v === "live")}
						options={[
							{ value: "still", label: "Pictures" },
							{ value: "live", label: "Live" },
						]}
					/>
				</div>
			</header>
			<main className={`gl-grid gl-grid--${frame}`}>
				{DIRECTIONS.map(direction => {
					const url = pageUrl(direction.id, mode, access, preview, port);
					// Stills exist for the default view only; every other combination is live.
					const still =
						frame === "desktop" && access === "full" && preview === "live"
							? thumbs[direction.id]?.[mode]
							: undefined;
					return (
						<article key={direction.id} className="gl-card">
							<div className={`gl-frame gl-frame--${frame}`}>
								{live || !still ? (
									<iframe title={`${direction.name} direction`} src={url} loading="lazy" />
								) : (
									<img src={still} alt={`${direction.name} direction, ${mode} mode`} loading="lazy" />
								)}
							</div>
							<div className="gl-meta">
								<h2 className="gl-name">{direction.name}</h2>
								<p className="gl-pitch">{direction.pitch}</p>
								<a className="gl-open" href={url} target="_blank" rel="noopener noreferrer">
									Open {direction.name}
								</a>
							</div>
						</article>
					);
				})}
			</main>
		</div>
	);
}

const root = document.getElementById("gallery");
if (!root) throw new Error("missing #gallery");
createRoot(root).render(<Gallery />);
