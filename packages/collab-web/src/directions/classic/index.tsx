/**
 * `classic`: the page as it shipped before the design directions, kept so
 * nothing is lost and as the default until the owner picks a direction.
 * Same components as before; only the omp wording is gone. Its look comes
 * from the global `styles/tokens.css`, not from the theme seam, since it is
 * the fallback rather than a candidate.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "../../components/agents/AgentDrawer";
import { AgentsPanel } from "../../components/agents/AgentsPanel";
import { Banners } from "../../components/shell/Banners";
import { Composer } from "../../components/shell/Composer";
import { HeaderBar } from "../../components/shell/HeaderBar";
import { Toasts } from "../../components/shell/Toasts";
import { Transcript } from "../../components/transcript/Transcript";
import type { ToolRenderHost } from "../../tool-render";
import type { Direction, DirectionProps } from "../types";
import "../../components/shell/shell.css";

function ClassicApp({ client, snapshot: snap, onRejoin }: DirectionProps): ReactNode {
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
					<div data-shot="composer" style={{ display: "contents" }}>
						<Composer
							client={client}
							phase={snap.phase}
							readOnly={snap.readOnly}
							uiRequest={snap.uiRequest}
							working={snap.working}
							queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
						/>
					</div>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closeDrawer}
					/>
				</>
			)}
			{snap.working && <span data-shot="running" hidden />}
			{snap.uiRequest && <span data-shot="ask" hidden />}
			{snap.phase === "ended" && <span data-shot="ended" hidden />}
			<Banners phase={snap.phase} endedReason={snap.endedReason} loading={snap.loading} onRejoin={onRejoin} />
			<Toasts notices={snap.notices} />
		</div>
	);
}

export const classic: Direction = {
	id: "classic",
	name: "Classic",
	pitch: "The page as it is today: dense cards on a near-black panel, kept as the fallback.",
	tokens: { light: {}, dark: {} },
	App: ClassicApp,
};
