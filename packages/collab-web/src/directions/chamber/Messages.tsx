/**
 * Chamber's transcript: OpenChamber's turn layout. The prompt sits right in
 * a tinted bubble with a small bottom-right corner; the reply runs
 * full-width beneath it as prose with tool and reasoning rows inline; a
 * quiet footer (model · duration) closes a finished turn. Adapted from
 * OpenChamber's `TurnItem.tsx`, `ChatMessage.tsx` and
 * `AssistantTextPart.tsx`.
 *
 * Copyright (c) 2025 Bohdan Triapitsyn. MIT License; see
 * LICENSE-openchamber.txt in this folder.
 */
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import type { ActiveTool } from "../../lib/client";
import type { Turn } from "../kit/run";
import type { TimelineItem } from "../kit/session";
import { toolCallView, toolDiff } from "../kit/tools";
import { Prose } from "../kit/views";
import { clock, seconds } from "../kit/words";
import { ThinkingRow, ToolRow } from "./ToolRow";

/** The host's display name for the model when the reply came from it; else the id's last segment. */
function modelLabel(model: string, modelName: string | null): string {
	return modelName ?? model.split("/").pop() ?? model;
}

const Reply = memo(function Reply({
	message,
	streaming,
	results,
	active,
	diffHookId,
}: {
	message: AssistantMessage;
	streaming: boolean;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	diffHookId: string | null;
}): ReactNode {
	const failed = !streaming && (message.stopReason === "error" || message.stopReason === "aborted");
	return (
		<div className="ch-reply">
			{message.content.map((block, i) => {
				switch (block.type) {
					case "thinking":
						return block.thinking.trim() ? (
							<ThinkingRow
								key={`t${i}`}
								text={block.thinking}
								streaming={streaming && i === message.content.length - 1}
							/>
						) : null;
					case "redactedThinking":
						return <ThinkingRow key={`t${i}`} text="The provider hid this reasoning." streaming={false} />;
					case "text":
						return block.text.trim() ? (
							<div key={`x${i}`} className="ch-text">
								<Prose text={block.text} streaming={streaming} />
							</div>
						) : null;
					case "toolCall":
						return (
							<ToolRow
								key={block.id}
								call={toolCallView(
									block,
									results.get(block.id),
									active.get(block.id),
									streaming,
									message.timestamp,
								)}
								diffHook={block.id === diffHookId}
							/>
						);
					default:
						return null;
				}
			})}
			{failed && (
				<div className="ch-stopped" role="note">
					{message.stopReason === "aborted"
						? "Stopped before it finished."
						: `This step failed${message.errorMessage ? `: ${message.errorMessage}` : "."}`}
				</div>
			)}
		</div>
	);
});

function TurnFooter({ turn, modelName }: { turn: Turn; modelName: string | null }): ReactNode {
	let last: AssistantMessage | null = null;
	for (let i = turn.items.length - 1; i >= 0; i--) {
		const item = turn.items[i]!;
		if (item.kind === "reply" && !item.streaming) {
			last = item.message;
			break;
		}
	}
	if (!last || last.stopReason !== "stop") return null;
	const started = turn.prompt?.at ?? null;
	const elapsed = started !== null && Number.isFinite(started) ? last.timestamp - started : null;
	return (
		<div className="ch-footer">
			<Sparkles size={13} aria-hidden="true" />
			<span>{modelLabel(last.model, modelName)}</span>
			{elapsed !== null && elapsed > 0 && (
				<>
					<span className="ch-footer-dot" aria-hidden="true">
						·
					</span>
					<span>{seconds(elapsed)}</span>
				</>
			)}
		</div>
	);
}

function Prompt({ item }: { item: Extract<TimelineItem, { kind: "prompt" }> }): ReactNode {
	return (
		<div className="ch-user">
			<div className="ch-user-meta">
				<span>{item.author}</span>
				{Number.isFinite(item.at) && <span className="ch-user-time">{clock(item.at)}</span>}
			</div>
			<div className="ch-bubble">
				<Prose text={item.text} />
			</div>
		</div>
	);
}

export const TurnView = memo(function TurnView({
	turn,
	results,
	active,
	diffHookId,
	modelName = null,
}: {
	turn: Turn;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	diffHookId: string | null;
	modelName?: string | null;
}): ReactNode {
	return (
		<section className="ch-turn" aria-label={turn.prompt ? `Request from ${turn.prompt.author}` : "Run"}>
			{turn.prompt && <Prompt item={turn.prompt} />}
			{turn.items.map(item => {
				if (item.kind === "note") {
					return (
						<div key={item.id} className="ch-note" role="note">
							{item.text}
						</div>
					);
				}
				if (item.kind === "reply") {
					return (
						<Reply
							key={item.id}
							message={item.message}
							streaming={item.streaming}
							results={results}
							active={active}
							diffHookId={diffHookId}
						/>
					);
				}
				return null;
			})}
			<TurnFooter turn={turn} modelName={modelName} />
		</section>
	);
});

/** The id of the newest edit call that carries a diff, for the screenshot hook. */
export function lastDiffCallId(turns: readonly Turn[], results: ReadonlyMap<string, ToolResultMessage>): string | null {
	for (let t = turns.length - 1; t >= 0; t--) {
		const items = turns[t]!.items;
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i]!;
			if (item.kind !== "reply") continue;
			for (let b = item.message.content.length - 1; b >= 0; b--) {
				const block = item.message.content[b]!;
				if (block.type !== "toolCall") continue;
				const result = results.get(block.id);
				if (result && toolDiff({ result })) return block.id;
			}
		}
	}
	return null;
}
