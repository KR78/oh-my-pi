/** Small React hooks every direction needs: a ticking clock, tail-follow scrolling, toast expiry, Esc. */
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Notice } from "../../lib/client";

/** Re-renders every `ms` while `active`, for live durations. */
export function useNow(ms: number, active = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms, active]);
	return now;
}

/**
 * Keeps a scroll container pinned to its bottom while the reader is there
 * (within 48px), and lets go the moment they scroll up. `deps` are whatever
 * grows the content. Returns whether the reader is away from the bottom and
 * a function that jumps back.
 */
export function useFollowTail(
	ref: RefObject<HTMLElement | null>,
	deps: readonly unknown[],
): { away: boolean; jump(): void } {
	const locked = useRef(true);
	const [away, setAway] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onScroll = (): void => {
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
			locked.current = atBottom;
			setAway(!atBottom);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [ref]);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && locked.current) el.scrollTop = el.scrollHeight;
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's content signals
	}, deps);
	const jump = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		locked.current = true;
		el.scrollTop = el.scrollHeight;
		setAway(false);
	}, [ref]);
	return { away, jump };
}

const TTL_MS: Record<Notice["level"], number> = { info: 4_000, warning: 8_000, error: 0 };

/**
 * The notices still on screen: info and warnings expire, errors stay until
 * dismissed. Capped to the newest `max`.
 */
export function useToasts(notices: readonly Notice[], max = 3): { visible: Notice[]; dismiss(id: number): void } {
	const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set());
	const now = useNow(1_000, notices.length > 0);
	const dismiss = useCallback((id: number) => {
		setDismissed(prev => new Set(prev).add(id));
	}, []);
	const visible: Notice[] = [];
	for (let i = notices.length - 1; i >= 0 && visible.length < max; i--) {
		const notice = notices[i]!;
		if (dismissed.has(notice.id)) continue;
		const ttl = TTL_MS[notice.level];
		if (ttl > 0 && now - notice.at > ttl) continue;
		visible.unshift(notice);
	}
	return { visible, dismiss };
}

/** Calls `onEscape` on Esc while `active`, unless focus is in a field that handles it. */
export function useEscape(onEscape: () => void, active = true): void {
	const handler = useRef(onEscape);
	handler.current = onEscape;
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape" && !e.defaultPrevented) handler.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);
}

/** True below the given width; follows resizes. */
export function useNarrow(maxWidth: number): boolean {
	const query = `(max-width: ${maxWidth}px)`;
	const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
	useEffect(() => {
		const mq = window.matchMedia(query);
		const onChange = (): void => setNarrow(mq.matches);
		onChange();
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [query]);
	return narrow;
}
