import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { DirectionHost } from "./directions/host";
import { BrandContext } from "./directions/kit/brand";
import { sessionTitle } from "./directions/kit/session";
import { readSelection, type Selection } from "./directions/selection";
import { safeBrandName } from "./directions/theme-seam";
import { GuestClient, type GuestSnapshot } from "./lib/client";
import { useGuestSnapshot } from "./lib/use-guest";

const NAME_KEY = "oz.live.name";

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);
	// The query string only: the fragment carries the room key and is read by hashLink() alone.
	const selection = useMemo(() => readSelection(window.location.search), []);
	const brand = safeBrandName(selection.theme);

	const connect = useCallback((link: string, name: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		window.location.hash = link;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = `${brand} · live run`;
	}, [client, brand]);

	if (!client) {
		return (
			<BrandContext.Provider value={selection.theme}>
				<ConnectScreen defaultName={storedName()} error={connectError} onConnect={connect} />
			</BrandContext.Provider>
		);
	}
	return <Session client={client} selection={selection} onLeave={leave} onRejoin={rejoin} />;
}

interface SessionProps {
	client: GuestClient;
	selection: Selection;
	onLeave(): void;
	onRejoin(): void;
}

/**
 * Gallery preview of a phase the mock host cannot hold still. Overrides only
 * the copy of the snapshot handed to the direction; the client keeps its
 * real state, and the production selection never sets a preview.
 */
function previewSnapshot(snap: GuestSnapshot, preview: Selection["preview"]): GuestSnapshot {
	if (preview === null) return snap;
	switch (preview) {
		case "connecting":
			return {
				...snap,
				phase: "connecting",
				entries: [],
				stream: null,
				working: false,
				header: null,
				state: null,
				agents: [],
			};
		case "waiting":
			return {
				...snap,
				phase: "waiting",
				entries: [],
				stream: null,
				working: false,
				loading: { received: 38, total: 86 },
			};
		case "reconnecting":
			return { ...snap, phase: "reconnecting" };
		case "ended":
			return {
				...snap,
				phase: "ended",
				endedReason: snap.endedReason ?? "the run finished",
				working: false,
				uiRequest: null,
			};
	}
}

function Session({ client, selection, onLeave, onRejoin }: SessionProps): ReactNode {
	const live = useGuestSnapshot(client);
	const snap = useMemo(() => previewSnapshot(live, selection.preview), [live, selection.preview]);
	const brand = safeBrandName(selection.theme);
	const title = sessionTitle(snap);
	useEffect(() => {
		document.title = `${title} · ${brand}`;
	}, [title, brand]);

	return (
		<DirectionHost
			direction={selection.direction}
			client={client}
			snapshot={snap}
			theme={selection.theme}
			forcedMode={selection.mode}
			onRejoin={onRejoin}
			onLeave={onLeave}
		/>
	);
}
