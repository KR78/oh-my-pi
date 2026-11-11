/**
 * Chamber's composer: OpenChamber's floating composer box (text field on
 * top, a footer row of quiet controls with the model chip and a round send
 * or stop button), and its question card docked above the box when the run
 * asks something. Adapted from OpenChamber's `ChatInput.tsx` (the look, not
 * its 5,000 lines of features) and its question tool card.
 *
 * Copyright (c) 2025 Bohdan Triapitsyn. MIT License; see
 * LICENSE-openchamber.txt in this folder.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ArrowUp, Brain, Eye, ListChecks, Sparkles, Square } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { useEscape } from "../kit/hooks";
import { BLOCK_WORDS, optionDescription, optionLabel, sendPrompt, steerState, useEnterToSend } from "../kit/steer";

function autosize(el: HTMLTextAreaElement | null, maxPx: number): void {
	if (!el) return;
	el.style.height = "0px";
	el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
	el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
}

const QuestionCard = memo(function QuestionCard({
	request,
	client,
}: {
	request: CollabUiRequest;
	client: GuestClient;
}): ReactNode {
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const [picked, setPicked] = useState<number>(request.kind === "select" ? (request.initialIndex ?? 0) : 0);
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => autosize(ref.current, 180), [draft]);
	const submitText = useCallback(() => client.sendUiResponse(request.reqId, draft), [client, request.reqId, draft]);
	const keys = useEnterToSend(submitText);
	const skip = (): void => client.sendUiResponse(request.reqId);
	useEscape(skip);
	return (
		<div className="ch-ask" role="group" aria-labelledby={`ask-${request.reqId}`} data-shot="ask">
			<div className="ch-ask-head">
				<ListChecks size={14} aria-hidden="true" />
				<span>Oz is asking</span>
			</div>
			<div className="ch-ask-title" id={`ask-${request.reqId}`}>
				{request.title}
			</div>
			{request.kind === "select" ? (
				<div className="ch-ask-options" role="radiogroup" aria-labelledby={`ask-${request.reqId}`}>
					{request.options.map((option, index) => {
						const label = optionLabel(option);
						const description = optionDescription(option);
						return (
							<button
								// biome-ignore lint/suspicious/noArrayIndexKey: options are positional in the request
								key={`${request.reqId}-${index}`}
								type="button"
								role="radio"
								aria-checked={picked === index}
								className="ch-ask-option"
								onFocus={() => setPicked(index)}
								onClick={() => client.sendUiResponse(request.reqId, label)}
							>
								<span className="ch-ask-index">{index + 1}</span>
								<span className="ch-ask-copy">
									<span className="ch-ask-label">{label}</span>
									{description && <span className="ch-ask-desc">{description}</span>}
								</span>
							</button>
						);
					})}
				</div>
			) : (
				<textarea
					ref={ref}
					className="ch-ask-input"
					value={draft}
					rows={2}
					aria-label="Your answer"
					onChange={e => setDraft(e.target.value)}
					{...keys}
				/>
			)}
			<div className="ch-ask-actions">
				<button type="button" className="ch-btn ch-btn--ghost" onClick={skip}>
					Skip
				</button>
				{request.kind === "editor" && (
					<button type="button" className="ch-btn ch-btn--primary" onClick={submitText}>
						Answer
					</button>
				)}
			</div>
		</div>
	);
});

export const Composer = memo(function Composer({
	client,
	snapshot,
}: {
	client: GuestClient;
	snapshot: GuestSnapshot;
}): ReactNode {
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement | null>(null);
	const steer = steerState(snapshot);
	useLayoutEffect(() => autosize(ref.current, 220), [text]);
	const send = useCallback(() => {
		if (sendPrompt(client, snapshot, text)) setText("");
	}, [client, snapshot, text]);
	const keys = useEnterToSend(send);
	useEscape(() => client.sendAbort(), steer.canInterrupt && snapshot.uiRequest === null);

	const model = snapshot.state?.model?.name ?? null;
	const thinking = snapshot.state?.thinkingLevel ?? null;
	const hasText = text.trim().length > 0;

	if (steer.block === "view-only") {
		return (
			<div className="ch-composer ch-composer--readonly" data-shot="composer">
				<div className="ch-readonly">
					<Eye size={16} aria-hidden="true" />
					<span>{BLOCK_WORDS["view-only"]}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="ch-composer-wrap" data-shot="composer">
			{snapshot.uiRequest && steer.canSteer && (
				<QuestionCard key={snapshot.uiRequest.reqId} request={snapshot.uiRequest} client={client} />
			)}
			<div className="ch-composer">
				<textarea
					ref={ref}
					className="ch-input"
					value={text}
					rows={1}
					disabled={!steer.canSteer}
					aria-label="Message to the run"
					placeholder={
						steer.canSteer
							? steer.working
								? "Tell Oz something while it works"
								: "Ask Oz to change something"
							: BLOCK_WORDS["not-live"]
					}
					onChange={e => setText(e.target.value)}
					{...keys}
				/>
				<div className="ch-composer-foot">
					<div className="ch-chips">
						{model && (
							<span className="ch-chip" title="Model">
								<Sparkles size={13} aria-hidden="true" />
								<span className="ch-chip-text">{model}</span>
							</span>
						)}
						{thinking && (
							<span className="ch-chip ch-chip--muted" title="Thinking level">
								<Brain size={13} aria-hidden="true" />
								{thinking}
							</span>
						)}
						{steer.working && steer.queued > 0 && (
							<span className="ch-chip ch-chip--muted">{steer.queued} queued</span>
						)}
					</div>
					{steer.canInterrupt && !hasText ? (
						<button
							type="button"
							className="ch-send ch-send--stop"
							onClick={() => client.sendAbort()}
							aria-label="Stop the run (Esc)"
							title="Stop (Esc)"
						>
							<Square size={12} fill="currentColor" aria-hidden="true" />
						</button>
					) : (
						<button
							type="button"
							className="ch-send"
							onClick={send}
							disabled={!steer.canSteer || !hasText}
							aria-label="Send (Enter)"
							title="Send (Enter)"
						>
							<ArrowUp size={16} aria-hidden="true" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
});
