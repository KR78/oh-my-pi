import { ArrowRight, Lock } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { BrandMark, useBrandName } from "../../directions/kit/brand";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

export function ConnectScreen({ defaultName, error, onConnect }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError("Paste a join link first.");
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || "guest");
	};

	const shown = localError ?? error;
	const brand = useBrandName();

	return (
		<div className="sh-connect">
			<div className="sh-ambient" />
			<div className="sh-connect-top">
				<div className="sh-brand">
					<BrandMark size={22} className="sh-mark" />
					<span>{brand}</span>
				</div>
				<ThemeToggle />
			</div>
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<h1 className="sh-connect-title">Watch {brand} work</h1>
					<p className="sh-connect-sub">
						Follow a run as it happens: what {brand} reads, runs and changes. With a steer link you can tell it
						something too.
					</p>
				</div>
				<label className="sh-field">
					<span className="sh-field-label">Join link</span>
					<input
						className="sh-input sh-input-mono"
						type="text"
						value={link}
						onChange={e => setLink(e.target.value)}
						placeholder="Paste the link from Slack"
						spellCheck={false}
						autoComplete="off"
						autoFocus
					/>
					<span className="sh-field-hint">
						The "Watch or steer live" button in Slack opens this page with the link filled in.
					</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">Display name</span>
					<input
						className="sh-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="guest"
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</label>
				{shown && <div className="sh-connect-error">{shown}</div>}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					Join the run <ArrowRight size={14} />
				</button>
				<div className="sh-connect-foot">
					<Lock size={12} />
					Encrypted end to end. The key stays in your link and never reaches the server.
				</div>
			</form>
		</div>
	);
}
