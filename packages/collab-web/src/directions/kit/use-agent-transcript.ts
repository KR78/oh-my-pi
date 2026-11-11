/**
 * A subagent's live transcript, polled from the host's session file while a
 * view of it is open. The same contract as the classic AgentDrawer (and the
 * TUI guest): a `null` reply is transient and retried from the same cursor;
 * a host `error` is terminal and shown, never hot-retried. Once the agent is
 * not running and several polls find the file unchanged, polling stops;
 * host activity for the agent (progress, lifecycle, status) resumes it.
 */
import type { AgentSnapshot, SessionEntry, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { useEffect, useRef, useState } from "react";
import type { GuestClient } from "../../lib/client";
import { decideTranscriptPoll } from "../../lib/transcript-poll";

const POLL_MS = 1200;
const IDLE_POLLS_BEFORE_STOP = 4;

export function useAgentTranscript(
	client: GuestClient,
	agent: AgentSnapshot | null,
	progress: SubagentProgressPayload | undefined,
	lifecycle: SubagentLifecyclePayload | undefined,
): { entries: readonly SessionEntry[]; error: string | null } {
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const resumeRef = useRef<(() => void) | null>(null);
	const quiescentRef = useRef(false);
	quiescentRef.current = agent?.status !== "running";
	const agentId = agent?.id ?? null;
	const hasFile = agent?.hasSessionFile === true;

	useEffect(() => {
		setEntries([]);
		setError(null);
		if (agentId === null || !hasFile) return;
		let disposed = false;
		let failed = false;
		let inFlight = false;
		let cursor = 0;
		let carry = "";
		let acc: readonly SessionEntry[] = [];
		let idlePolls = 0;
		let timer: Timer | null = null;
		const stop = (): void => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const poll = async (): Promise<void> => {
			if (disposed || failed || inFlight) return;
			inFlight = true;
			try {
				const reply = await client.fetchTranscript(agentId, cursor);
				if (disposed) return;
				const decision = decideTranscriptPoll(reply, carry);
				if (decision.action === "retry") return;
				if (decision.action === "stop") {
					failed = true;
					stop();
					setError(decision.message);
					return;
				}
				const grew = decision.newSize !== cursor;
				cursor = decision.newSize;
				carry = decision.carry;
				if (decision.fresh.length > 0) {
					acc = [...acc, ...decision.fresh];
					setEntries(acc);
				}
				idlePolls = grew || !quiescentRef.current ? 0 : idlePolls + 1;
				if (carry === "" && idlePolls >= IDLE_POLLS_BEFORE_STOP) stop();
			} finally {
				inFlight = false;
			}
		};
		const start = (): void => {
			idlePolls = 0;
			void poll();
			timer = setInterval(() => void poll(), POLL_MS);
		};
		resumeRef.current = () => {
			if (!disposed && !failed && timer === null) start();
		};
		start();
		return () => {
			disposed = true;
			resumeRef.current = null;
			stop();
		};
	}, [agentId, hasFile, client]);

	useEffect(() => {
		resumeRef.current?.();
	}, [progress, lifecycle, agent?.status, agent?.lastActivity]);

	return { entries, error };
}
