import {
  Award,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  DollarSign,
  ExternalLink,
  Pencil,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useChat } from "../contexts/ChatContext";
import { parseReport, streamCarAnalysis } from "../utils/claudeApi";
import { generateOrFetch3D } from "../utils/model3d";
import { createCostAccumulator, FIXED_COSTS, formatUsd } from "../utils/pricing";
import { decodeVin } from "../utils/vinDecode";
import {
  extractTextFromPDF,
  fileToBase64,
  getDominantColor,
  getMediaType,
} from "../utils/pdfParser";
import {
  canAnonPrompt,
  canPromptFromDoc,
  canUserPrompt,
  incrementAnonUsage,
  incrementUserUsage,
  isAdmin,
} from "../utils/usage";
import ContextModal from "./ContextModal";
import ReportModal from "./ReportModal";
import ThinkingPanel from "./ThinkingPanel";
import UploadArea from "./UploadArea";

// ─── Lightweight markdown renderer ────────────────────────────────────────────
function renderMarkdown(text) {
	if (!text) return null;
	const lines = text.split("\n");
	const elements = [];
	let listBuffer = [];
	let listType = null;
	let key = 0;

	const flushList = () => {
		if (listBuffer.length === 0) return;
		const Tag = listType === "ol" ? "ol" : "ul";
		elements.push(
			<Tag
				key={key++}
				className={listType === "ol" ? "list-decimal" : "list-disc"}
				style={{ paddingLeft: "1.3em", margin: "0.3em 0" }}
			>
				{listBuffer.map((item, i) => (
					<li key={i}>{inlineMarkdown(item)}</li>
				))}
			</Tag>,
		);
		listBuffer = [];
		listType = null;
	};

	const inlineMarkdown = (str) => {
		const parts = [];
		let remaining = str;
		let idx = 0;
		const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
		let match;
		let lastIdx = 0;
		while ((match = re.exec(str)) !== null) {
			if (match.index > lastIdx)
				parts.push(<span key={idx++}>{str.slice(lastIdx, match.index)}</span>);
			if (match[0].startsWith("**"))
				parts.push(<strong key={idx++}>{match[2]}</strong>);
			else if (match[0].startsWith("*"))
				parts.push(<em key={idx++}>{match[3]}</em>);
			else if (match[0].startsWith("`"))
				parts.push(<code key={idx++}>{match[4]}</code>);
			lastIdx = match.index + match[0].length;
		}
		if (lastIdx < str.length)
			parts.push(<span key={idx++}>{str.slice(lastIdx)}</span>);
		// eslint-disable-next-line no-unused-vars
		remaining = "";
		return parts.length > 0 ? parts : str;
	};

	for (const line of lines) {
		if (/^### /.test(line)) {
			flushList();
			elements.push(
				<h3 key={key++} style={{ fontWeight: 700, margin: "0.6em 0 0.2em" }}>
					{inlineMarkdown(line.slice(4))}
				</h3>,
			);
		} else if (/^## /.test(line)) {
			flushList();
			elements.push(
				<h2 key={key++} style={{ fontWeight: 700, margin: "0.7em 0 0.25em" }}>
					{inlineMarkdown(line.slice(3))}
				</h2>,
			);
		} else if (/^[-*] /.test(line)) {
			if (listType !== "ul") {
				flushList();
				listType = "ul";
			}
			listBuffer.push(line.slice(2));
		} else if (/^\d+\. /.test(line)) {
			if (listType !== "ol") {
				flushList();
				listType = "ol";
			}
			listBuffer.push(line.replace(/^\d+\. /, ""));
		} else if (line.trim() === "") {
			flushList();
			elements.push(<br key={key++} />);
		} else {
			flushList();
			elements.push(
				<p key={key++} style={{ margin: "0.3em 0" }}>
					{inlineMarkdown(line)}
				</p>,
			);
		}
	}
	flushList();
	return <div className="message-md">{elements}</div>;
}

// ─── Assistant message — hidden while streaming, reveals when complete ────────
function AssistantText({ text, isStreaming }) {
	if (isStreaming || !text) {
		return (
			<span className="flex items-center gap-1.5">
				<span className="typing-dot" />
				<span className="typing-dot" />
				<span className="typing-dot" />
			</span>
		);
	}
	// Animate in when streaming just finished (key changes → remount → CSS animation)
	return (
		<div key="done" className="message-reveal">
			{renderMarkdown(text)}
		</div>
	);
}

// ─── Verdict mini badge for chat bubble ───────────────────────────────────────
function MiniVerdict({ rating }) {
	const cls =
		{
			Great: "verdict-great",
			Good: "verdict-good",
			Fair: "verdict-fair",
			Bad: "verdict-bad",
		}[rating] || "verdict-gray";
	return (
		<span
			className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${cls}`}
		>
			<Award size={11} /> {rating}
		</span>
	);
}

const USER_MSG_COLLAPSE_THRESHOLD = 400;

// ─── Dev-only cost badge ──────────────────────────────────────────────────────
// Renders a small "$0.0432" pill under the assistant message; click expands a
// per-line breakdown of every paid API call that contributed to the response
// (Claude tokens, Vincario, VinAudit image lookup, Tripo3D, etc.). Only shown
// to admin users — see isAdmin() in utils/usage.js.
function CostBadge({ totalCost }) {
	const [open, setOpen] = useState(false);
	if (!totalCost || typeof totalCost.total !== "number") return null;
	const items = Array.isArray(totalCost.items) ? totalCost.items : [];
	return (
		<div className="mt-1.5">
			<button
				onClick={() => setOpen((o) => !o)}
				title="Developer cost breakdown"
				className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono transition-all hover:opacity-80"
				style={{
					background: "var(--color-bg)",
					border: "1px dashed var(--color-border)",
					color: "var(--color-muted)",
				}}
			>
				<DollarSign size={10} />
				{formatUsd(totalCost.total)}
				<span className="opacity-60 ml-1">dev</span>
				{open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
			</button>
			{open && (
				<div
					className="mt-1.5 rounded-lg p-2 text-[11px] font-mono"
					style={{
						background: "var(--color-bg)",
						border: "1px solid var(--color-border)",
						color: "var(--color-text)",
						maxWidth: 380,
					}}
				>
					{items.length === 0 ? (
						<div style={{ color: "var(--color-muted)" }}>No paid items recorded.</div>
					) : (
						<div className="space-y-0.5">
							{items.map((it, i) => (
								<div key={i} className="flex items-baseline justify-between gap-3">
									<span className="truncate">
										{it.label}
										{it.detail && (
											<span className="opacity-60"> · {it.detail}</span>
										)}
									</span>
									<span style={{ color: "var(--color-muted)" }}>
										{formatUsd(it.amount)}
									</span>
								</div>
							))}
							<div
								className="flex items-baseline justify-between pt-1 mt-1 font-bold"
								style={{ borderTop: "1px solid var(--color-border)" }}
							>
								<span>Total</span>
								<span>{formatUsd(totalCost.total)}</span>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({
	msg,
	onEdit,
	onCopy,
	onRetry,
	onViewReport,
	onFeedback,
	isLast,
	isAnalyzing,
	isDev,
}) {
	const isUser = msg.role === "user";
	const [hovered, setHovered] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [copied, setCopied] = useState(false);
	const [userExpanded, setUserExpanded] = useState(false);
	const editRef = useRef(null);

	const textContent = msg.text || msg.content || "";
	const cleanText = textContent
		.replace(/<REPORT>[\s\S]*?<\/REPORT>/g, "")
		.replace(/<REPORT>[\s\S]*$/, "") // hide partial <REPORT> block while streaming
		.trim();

	const startEdit = () => {
		setEditText(cleanText);
		setEditing(true);
		setTimeout(() => editRef.current?.focus(), 50);
	};

	const submitEdit = () => {
		const trimmed = editText.trim();
		if (trimmed && trimmed !== cleanText) onEdit(msg, trimmed);
		setEditing(false);
	};

	const handleCopy = () => {
		navigator.clipboard.writeText(cleanText);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
		onCopy?.();
	};

	return (
		<div
			className={`flex gap-3 mb-4 group ${isUser ? "flex-row-reverse" : "flex-row"}`}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{!isUser && (
				<div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
					<Car size={14} className="text-white" />
				</div>
			)}

			<div className={`max-w-2xl ${isUser ? "ml-12" : "mr-12"} flex flex-col`}>
				{editing ? (
					<div
						className="rounded-2xl overflow-hidden"
						style={{
							border: "2px solid var(--color-accent)",
							background: "var(--color-surface)",
						}}
					>
						<textarea
							ref={editRef}
							value={editText}
							onChange={(e) => setEditText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									submitEdit();
								}
								if (e.key === "Escape") setEditing(false);
							}}
							className="w-full px-4 pt-3 pb-2 text-sm resize-none outline-none"
							style={{
								background: "transparent",
								color: "var(--color-text)",
								minHeight: 80,
							}}
							rows={3}
						/>
						<div className="flex items-center justify-end gap-2 px-3 pb-3">
							<button
								onClick={() => setEditing(false)}
								className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
								style={{
									border: "1px solid var(--color-border)",
									color: "var(--color-muted)",
								}}
							>
								Cancel
							</button>
							<button
								onClick={submitEdit}
								disabled={!editText.trim()}
								className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-all"
							>
								<Check size={12} /> Send
							</button>
						</div>
					</div>
				) : (
					<div
						className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
						style={{
							background: isUser
								? "var(--color-accent)"
								: "var(--color-surface)",
							border: isUser ? "none" : "1px solid var(--color-border)",
							color: isUser ? "#fff" : "var(--color-text)",
							whiteSpace: isUser ? "pre-wrap" : undefined,
						}}
					>
						{isUser ? (
							<>
								{userExpanded || cleanText.length <= USER_MSG_COLLAPSE_THRESHOLD
									? cleanText
									: cleanText.slice(0, USER_MSG_COLLAPSE_THRESHOLD) + "…"}
								{cleanText.length > USER_MSG_COLLAPSE_THRESHOLD && (
									<button
										onClick={() => setUserExpanded((e) => !e)}
										className="block mt-2 text-xs font-semibold underline opacity-70 hover:opacity-100"
										style={{ color: "inherit" }}
									>
										{userExpanded ? "Show less" : "Show more"}
									</button>
								)}
							</>
						) : (
							<AssistantText text={cleanText} isStreaming={!!msg.isStreaming} />
						)}
					</div>
				)}

				{/* Files indicator */}
				{msg.files && msg.files.length > 0 && (
					<div
						className={`flex flex-wrap gap-1.5 mt-2 ${isUser ? "justify-end" : ""}`}
					>
						{msg.files.map((f, i) => (
							<span
								key={i}
								className="text-xs px-2 py-1 rounded-lg"
								style={{
									background: "var(--color-bg)",
									border: "1px solid var(--color-border)",
									color: "var(--color-muted)",
								}}
							>
								{f}
							</span>
						))}
					</div>
				)}

				{/* Thinking panel */}
				{msg.steps && msg.steps.length > 0 && (
					<ThinkingPanel steps={msg.steps} done={!msg.isStreaming} />
				)}

				{/* Compact report badge */}
				{msg.report && !msg.isStreaming && (
					<div className="mt-2 flex items-center gap-2 flex-wrap">
						<MiniVerdict rating={msg.report.verdict?.rating} />
						<button
							onClick={() => onViewReport(msg)}
							className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all hover:opacity-80"
							style={{
								background: "var(--color-surface)",
								border: "1px solid var(--color-border)",
								color: "var(--color-text)",
							}}
						>
							<ExternalLink size={11} /> View Full Report
						</button>
					</div>
				)}

				{/* Dev-only cost breakdown */}
				{!isUser && isDev && msg.totalCost && !msg.isStreaming && (
					<CostBadge totalCost={msg.totalCost} />
				)}

				{/* Action buttons */}
				{!editing && !msg.isStreaming && hovered && (
					<div
						className={`flex items-center gap-1 mt-1.5 ${isUser ? "justify-end" : "justify-start"}`}
					>
						{isUser && (
							<button
								onClick={startEdit}
								title="Edit message"
								className="p-1.5 rounded-lg transition-all hover:opacity-80"
								style={{ color: "rgba(255,255,255,0.6)" }}
							>
								<Pencil size={13} />
							</button>
						)}
						<button
							onClick={handleCopy}
							title="Copy"
							className="p-1.5 rounded-lg transition-all"
							style={{ color: "var(--color-muted)" }}
						>
							{copied ? (
								<Check size={13} style={{ color: "#16a34a" }} />
							) : (
								<Copy size={13} />
							)}
						</button>
						{!isUser && isLast && !isAnalyzing && (
							<button
								onClick={onRetry}
								title="Regenerate"
								className="p-1.5 rounded-lg transition-all"
								style={{ color: "var(--color-muted)" }}
							>
								<RotateCcw size={13} />
							</button>
						)}
						{!isUser && (
							<>
								<button
									onClick={() => onFeedback?.(msg, msg.feedback === "up" ? null : "up")}
									title={msg.feedback === "up" ? "Remove rating" : "Good response"}
									className="p-1.5 rounded-lg transition-all hover:opacity-80"
									style={{
										color: msg.feedback === "up" ? "#16a34a" : "var(--color-muted)",
										background: msg.feedback === "up" ? "rgba(22,163,74,0.12)" : "transparent",
									}}
								>
									<ThumbsUp size={13} fill={msg.feedback === "up" ? "currentColor" : "none"} />
								</button>
								<button
									onClick={() => onFeedback?.(msg, msg.feedback === "down" ? null : "down")}
									title={msg.feedback === "down" ? "Remove rating" : "Bad response"}
									className="p-1.5 rounded-lg transition-all hover:opacity-80"
									style={{
										color: msg.feedback === "down" ? "#dc2626" : "var(--color-muted)",
										background: msg.feedback === "down" ? "rgba(220,38,38,0.12)" : "transparent",
									}}
								>
									<ThumbsDown size={13} fill={msg.feedback === "down" ? "currentColor" : "none"} />
								</button>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Main ChatInterface ────────────────────────────────────────────────────────
export default function ChatInterface({ onShowUpgrade, onShowAuth }) {
	const { user, userDoc } = useAuth();
	const {
		messages,
		activeSessionId,
		createSession,
		addMessage,
		persistLastMessage,
		updateLastMessage,
		updateMessage,
		setMessages,
		recordFeedback,
	} = useChat();
	const [input, setInput] = useState("");
	const [carfaxFile, setCarfaxFile] = useState(null);
	const [vehicleImage, setVehicleImage] = useState(null);
	const [isAnalyzing, setIsAnalyzing] = useState(false);
	const [showContextModal, setShowContextModal] = useState(false);
	const [activeReport, setActiveReport] = useState(null);
	const [showReportModal, setShowReportModal] = useState(false);
	const rodinAbort = useRef(null);
	const bottomRef = useRef(null);
	const textareaRef = useRef(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// Paste image from clipboard
	useEffect(() => {
		const handlePaste = (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) {
						const ext = item.type.split("/")[1] || "png";
						setVehicleImage(
							new File([file], `screenshot.${ext}`, { type: item.type }),
						);
						e.preventDefault();
					}
				}
			}
		};
		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, []);

	useEffect(() => {
		if (carfaxFile && vehicleImage && !isAnalyzing) setShowContextModal(true);
	}, [carfaxFile, vehicleImage, isAnalyzing]);

	const checkQuota = useCallback(async () => {
		if (!user) return canAnonPrompt();
		if (userDoc) return canPromptFromDoc(userDoc, user.email);
		return canUserPrompt(user.uid, user.email);
	}, [user, userDoc]);

	const consumeQuota = useCallback(async () => {
		if (!user) {
			incrementAnonUsage();
			return;
		}
		if (isAdmin(user.email)) return;
		await incrementUserUsage(user.uid, user.email);
	}, [user]);

	// Extract the first 17-char VIN from any of the given strings, then fetch
	// a ground-truth decode block (Vincario → NHTSA fallback) for prompt
	// injection. Returns null if no VIN found or both decoders failed.
	// Returns { block, source } — source is 'vincario' | 'nhtsa' so callers
	// can attribute paid-API costs correctly. Returns null when no VIN found
	// or both decoders fail.
	const resolveVinDecode = useCallback(async (...sources) => {
		const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;
		let vin = null;
		for (const s of sources) {
			if (typeof s !== "string") continue;
			const m = s.match(VIN_RE);
			if (m) { vin = m[0]; break; }
		}
		if (!vin) return null;
		try {
			const decoded = await decodeVin(vin);
			if (!decoded?.block) return null;
			return { block: decoded.block, source: decoded.source || 'unknown' };
		} catch {
			return null;
		}
	}, []);

	const buildUserMemory = useCallback(() => {
		if (!userDoc) return "";
		const prefs = userDoc.preferences || {};
		const parts = [];
		if (prefs.preferredBrands?.length)
			parts.push(`Preferred brands: ${prefs.preferredBrands.join(", ")}`);
		if (prefs.budgetRange) parts.push(`Budget: ${prefs.budgetRange}`);
		if (prefs.pastRatings)
			parts.push(`Past deal ratings: ${JSON.stringify(prefs.pastRatings)}`);
		return parts.join("\n");
	}, [userDoc]);

	const openReport = useCallback(
		(
			report,
			vehicleColor,
			vehicleLabel,
			imageBase64 = null,
			imageMediaType = null,
			glbUrl = null,
			modelStatus = null,
		) => {
			setActiveReport((prev) => ({
				report,
				vehicleColor,
				vehicleLabel,
				imageBase64,
				imageMediaType,
				glbUrl: glbUrl ?? prev?.glbUrl,
				modelStatus: modelStatus ?? prev?.modelStatus,
			}));
			setShowReportModal(true);
		},
		[],
	);

	// Kick off 3D pipeline. Trim-cache-first via the asset library:
	//   - If models3d/{slug} is ready in Firestore → instant cache hit, no Tripo cost.
	//   - Else this client claims, generates via Tripo3D, persists to R2.
	//   - Concurrent clients on the same trim wait for the first one's result.
	//
	// Costs accrued here (VinAudit image lookup, Tripo3D generation) are pushed
	// through `cost` and re-persisted to the assistant message via `messageId`,
	// since startRodinJob runs *after* the message has already been saved.
	const startRodinJob = useCallback(
		async (imageBase64, imageMediaType, _prompt, vehicle = null, cost = null, sessionId = null, messageId = null) => {
			rodinAbort.current?.abort();
			const controller = new AbortController();
			rodinAbort.current = controller;
			try {
				const result = await generateOrFetch3D({
					vehicle,
					imageBase64,
					imageMediaType,
					vin: vehicle?.vin ?? null,
					onProgress: ({ status }) => {
						if (controller.signal.aborted) return;
						setActiveReport((prev) =>
							prev ? { ...prev, modelStatus: status } : prev,
						);
					},
					onCost: (item) => {
						if (!cost) return;
						cost.add(item.label, item.amount, item.detail);
						const snap = cost.snapshot();
						updateLastMessage((prev) => ({ ...prev, totalCost: snap }));
						if (sessionId && messageId) {
							updateMessage(sessionId, messageId, { totalCost: snap });
						}
					},
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				if (result?.glbUrl) {
					setActiveReport((prev) =>
						prev ? { ...prev, glbUrl: result.glbUrl, modelStatus: "Done" } : prev,
					);
				}
			} catch {
				// 3D API not configured or failed — procedural fallback stays
			}
		},
		[updateLastMessage, updateMessage],
	);

	const runAnalysis = useCallback(
		async (extraText = "") => {
			setShowContextModal(false);
			setIsAnalyzing(true);

			const allowed = await checkQuota();
			if (!allowed) {
				setIsAnalyzing(false);
				if (!user) onShowAuth();
				else onShowUpgrade();
				return;
			}

			// Per-analysis cost accumulator. Items get pushed as paid APIs fire
			// (Vincario decode, Claude streaming, VinAudit lookup, Tripo3D job).
			// Final snapshot is persisted on the assistant message; the dev-only
			// CostBadge in MessageBubble reads from there.
			const cost = createCostAccumulator();

			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession("Vehicle Assessment");

			const userFiles = [];
			if (carfaxFile) userFiles.push(`📄 ${carfaxFile.name}`);
			if (vehicleImage) userFiles.push(`🖼 ${vehicleImage.name}`);

			const userText = extraText || input || "Analyze this vehicle deal.";
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";

			await addMessage(sessionId, {
				role: "user",
				text: userText,
				files: userFiles,
			});
			const streamMsg = {
				role: "assistant",
				text: "",
				isStreaming: true,
				steps: [],
			};
			await addMessage(sessionId, streamMsg);

			let steps = [];
			const pushStep = (text, status = "running") => {
				steps = [...steps, { text, status }];
				updateLastMessage((prev) => ({ ...prev, steps: [...steps] }));
			};
			const doneStep = (idx, text) => {
				steps = steps.map((s, i) =>
					i === idx ? { ...s, text, status: "done" } : s,
				);
				updateLastMessage((prev) => ({ ...prev, steps: [...steps] }));
			};
			const failStep = (idx, text) => {
				steps = steps.map((s, i) =>
					i === idx ? { ...s, text, status: "error" } : s,
				);
				updateLastMessage((prev) => ({ ...prev, steps: [...steps] }));
			};

			let carfaxText = "";
			let imageBase64 = null;
			let imageMediaType = null;
			let vehicleColorRef = null;

			if (carfaxFile) {
				pushStep(`Reading CARFAX PDF: ${carfaxFile.name}`);
				try {
					carfaxText = await extractTextFromPDF(carfaxFile);
					const vinMatch = carfaxText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
					doneStep(
						steps.length - 1,
						`CARFAX extracted${vinMatch ? ` · VIN: ${vinMatch[0]}` : ""} · ${Math.round(carfaxText.length / 1000)}k chars`,
					);
				} catch {
					carfaxText = "[PDF parsing failed]";
					failStep(
						steps.length - 1,
						"PDF parsing failed — will use manual description",
					);
				}
			}

			if (vehicleImage) {
				pushStep(`Processing image: ${vehicleImage.name}`);
				try {
					imageBase64 = await fileToBase64(vehicleImage);
					imageMediaType = getMediaType(vehicleImage);
					vehicleColorRef = await getDominantColor(vehicleImage);
					doneStep(
						steps.length - 1,
						`Image ready · ${Math.round((imageBase64.length * 0.75) / 1024)}KB · color sampled`,
					);
				} catch {
					failStep(steps.length - 1, "Image processing failed");
				}
			}

			// Attach extracted inputs to the user message (in-memory only) so
			// regenerate/edit can replay the same analysis with the same files.
			setMessages((prev) => {
				const copy = [...prev];
				for (let i = copy.length - 1; i >= 0; i--) {
					if (copy[i].role === "user") {
						copy[i] = {
							...copy[i],
							_carfaxText: carfaxText,
							_img64: imageBase64,
							_imgMt: imageMediaType,
						};
						break;
					}
				}
				return copy;
			});

			// Ground-truth VIN decode (Vincario → NHTSA) injected into the prompt
			// so Claude can't hallucinate the wrong trim (e.g. A4 vs S5).
			const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;
			const vinCandidate =
				carfaxText.match(VIN_RE)?.[0] || userText.match(VIN_RE)?.[0] || null;
			let vinDecodeBlock = null;
			let vinDecodeSource = null;
			if (vinCandidate) {
				pushStep(`Decoding VIN: ${vinCandidate}`);
				const vinResult = await resolveVinDecode(carfaxText, userText);
				if (vinResult) {
					vinDecodeBlock = vinResult.block;
					vinDecodeSource = vinResult.source;
					if (vinDecodeSource === 'vincario') {
						cost.add('Vincario decode', FIXED_COSTS.vincario_decode, 'paid VIN decode');
					}
					// First line of the block is "(source: X)"; second is year make model
					const short = vinDecodeBlock.split("\n")[1] || "decoded";
					doneStep(steps.length - 1, `VIN decoded · ${short}`);
				} else {
					failStep(steps.length - 1, "VIN decode failed — proceeding without");
				}
			}

			pushStep("Connecting to Claude…");
			await consumeQuota();

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText,
					imageBase64,
					imageMediaType,
					messages: [...messages, { role: "user", text: userText }],
					userMemory: buildUserMemory(),
					vinDecode: vinDecodeBlock,
				});

				let streamStarted = false;
				let charCount = 0;
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						if (!streamStarted) {
							doneStep(steps.length - 1, "Connected · streaming response");
							pushStep("Generating deal analysis…");
							streamStarted = true;
						}
						fullText += chunk;
						charCount += chunk.length;
						const _ft = fullText;
						const _cc = charCount;
						if (_cc % 200 < chunk.length) {
							const _prevSteps = steps;
							steps = _prevSteps.map((s, i) =>
								i === _prevSteps.length - 1
									? { ...s, text: `Generating deal analysis… (${_cc} chars)` }
									: s,
							);
							const _steps = steps;
							updateLastMessage((prev) => ({
								...prev,
								text: _ft,
								steps: [..._steps],
							}));
						} else {
							updateLastMessage((prev) => ({ ...prev, text: _ft }));
						}
					} else if (chunk?.type === "usage") {
						// Anthropic message_delta carries token usage at the end of the stream.
						// Translate into priced line items via the accumulator.
						cost.addClaudeUsage(chunk.usage);
					}
				}

				const report = parseReport(fullText);

				if (report) {
					doneStep(
						steps.length - 1,
						`Analysis complete · ${charCount} chars · verdict: ${report.verdict?.rating || "—"}`,
					);
					if (report.vehicle?.vin) {
						pushStep(
							`VIN decoded: ${report.vehicle.vin} → ${report.vehicle.year} ${report.vehicle.make} ${report.vehicle.model}`,
						);
						steps = steps.map((s, i) =>
							i === steps.length - 1 ? { ...s, status: "done" } : s,
						);
					}
				} else {
					doneStep(steps.length - 1, `Response complete · ${charCount} chars`);
				}

				// Snapshot the cost so far (Vincario + Claude). 3D costs are added
				// later by startRodinJob via updateMessage.
				const costSnapshot = cost.snapshot();

				// Store image refs and vehicleColor in message so "View Full Report" works from history
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
					steps: [...steps],
					_img64: imageBase64,
					_imgMt: imageMediaType,
					_vehicleColor: vehicleColorRef,
					totalCost: costSnapshot,
				}));
				const persistedId = await persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
					_vehicleColor: vehicleColorRef || null,
					totalCost: costSnapshot,
				});

				if (report) {
					const label =
						`${report.vehicle?.year || ""} ${report.vehicle?.make || ""} ${report.vehicle?.model || ""}`.trim();
					const vLabel = label || "Vehicle Assessment";
					openReport(
						report,
						vehicleColorRef,
						vLabel,
						imageBase64,
						imageMediaType,
					);
					// Kick off 3D model generation in background. Pass the cost
					// accumulator + persisted message ID so VinAudit/Tripo costs
					// land on the same message once they fire.
					const prompt = `${vLabel} exterior, realistic car`;
					startRodinJob(imageBase64, imageMediaType, prompt, report.vehicle, cost, sessionId, persistedId);
				}
			} catch (err) {
				failStep(steps.length - 1, `Failed: ${err.message}`);
				const errMsg = err.message.includes("401")
					? "Invalid API key. Please check your .env configuration."
					: `Analysis failed: ${err.message}`;
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: errMsg,
					steps: [...steps],
				}));
				persistLastMessage(sessionId, { role: "assistant", text: errMsg });
			}

			setCarfaxFile(null);
			setVehicleImage(null);
			setIsAnalyzing(false);
		},
		[
			activeSessionId,
			carfaxFile,
			vehicleImage,
			input,
			messages,
			checkQuota,
			consumeQuota,
			createSession,
			addMessage,
			persistLastMessage,
			updateLastMessage,
			setMessages,
			user,
			onShowAuth,
			onShowUpgrade,
			buildUserMemory,
			openReport,
			startRodinJob,
			resolveVinDecode,
		],
	);

	const handleSend = async () => {
		const text = input.trim();
		if (!text && !carfaxFile && !vehicleImage) return;
		if (isAnalyzing) return;

		if (carfaxFile || vehicleImage) {
			await runAnalysis(text);
		} else {
			const allowed = await checkQuota();
			if (!allowed) {
				if (!user) onShowAuth();
				else onShowUpgrade();
				return;
			}

			const cost = createCostAccumulator();

			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession(text.slice(0, 50));
			await addMessage(sessionId, { role: "user", text });
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";
			await consumeQuota();

			const streamMsg = { role: "assistant", text: "", isStreaming: true };
			await addMessage(sessionId, streamMsg);

			// Also decode any VIN in the free-text path so the model gets ground truth.
			const vinResult = await resolveVinDecode(text);
			const vinDecodeBlock = vinResult?.block || null;
			if (vinResult?.source === 'vincario') {
				cost.add('Vincario decode', FIXED_COSTS.vincario_decode, 'paid VIN decode');
			}

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: "",
					messages: [...messages, { role: "user", text }],
					userMemory: buildUserMemory(),
					vinDecode: vinDecodeBlock,
				});
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						fullText += chunk;
						const _ft = fullText;
						updateLastMessage((prev) => ({ ...prev, text: _ft }));
					} else if (chunk?.type === "usage") {
						cost.addClaudeUsage(chunk.usage);
					}
				}
				const report = parseReport(fullText);
				const costSnapshot = cost.snapshot();
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
					totalCost: costSnapshot,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
					totalCost: costSnapshot,
				});
				if (report) {
					const label =
						`${report.vehicle?.year || ""} ${report.vehicle?.make || ""} ${report.vehicle?.model || ""}`.trim();
					openReport(report, null, label || "Vehicle Assessment");
				}
			} catch (err) {
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: `Error: ${err.message}`,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: `Error: ${err.message}`,
				});
			}
		}
	};

	const handleEdit = useCallback(
		async (msg, newText) => {
			if (isAnalyzing) return;
			const idx = messages.findIndex((m) => m === msg || m.id === msg.id);
			if (idx === -1) return;

			const truncated = messages.slice(0, idx);
			setMessages(truncated);

			const allowed = await checkQuota();
			if (!allowed) {
				if (!user) onShowAuth();
				else onShowUpgrade();
				return;
			}

			setIsAnalyzing(true);
			const cost = createCostAccumulator();
			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession(newText.slice(0, 50));

			// Preserve original CARFAX/image refs so regenerate re-sends the same inputs.
			const carfaxText = msg._carfaxText || "";
			const imageBase64 = msg._img64 || null;
			const imageMediaType = msg._imgMt || null;

			await addMessage(sessionId, {
				role: "user",
				text: newText,
				files: msg.files,
				_carfaxText: carfaxText,
				_img64: imageBase64,
				_imgMt: imageMediaType,
			});
			await consumeQuota();

			const streamMsg = { role: "assistant", text: "", isStreaming: true };
			await addMessage(sessionId, streamMsg);

			const vinResult = await resolveVinDecode(carfaxText, newText);
			const vinDecodeBlock = vinResult?.block || null;
			if (vinResult?.source === 'vincario') {
				cost.add('Vincario decode', FIXED_COSTS.vincario_decode, 'paid VIN decode');
			}

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText,
					imageBase64,
					imageMediaType,
					messages: [...truncated, { role: "user", text: newText }],
					userMemory: buildUserMemory(),
					vinDecode: vinDecodeBlock,
				});
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						fullText += chunk;
						const _ft = fullText;
						updateLastMessage((prev) => ({ ...prev, text: _ft }));
					} else if (chunk?.type === "usage") {
						cost.addClaudeUsage(chunk.usage);
					}
				}
				const report = parseReport(fullText);
				const costSnapshot = cost.snapshot();
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
					totalCost: costSnapshot,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
					totalCost: costSnapshot,
				});
				if (report) {
					const label =
						`${report.vehicle?.year || ""} ${report.vehicle?.make || ""} ${report.vehicle?.model || ""}`.trim();
					openReport(report, null, label || "Vehicle Assessment");
				}
			} catch (err) {
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: `Error: ${err.message}`,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: `Error: ${err.message}`,
				});
			}
			setIsAnalyzing(false);
		},
		[
			isAnalyzing,
			messages,
			checkQuota,
			user,
			onShowAuth,
			onShowUpgrade,
			activeSessionId,
			createSession,
			addMessage,
			persistLastMessage,
			consumeQuota,
			buildUserMemory,
			updateLastMessage,
			setMessages,
			openReport,
			resolveVinDecode,
		],
	);

	const handleRetry = useCallback(async () => {
		if (isAnalyzing || messages.length < 2) return;
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		if (!lastUser) return;
		const idx = messages.lastIndexOf(lastUser);
		setMessages(messages.slice(0, idx + 1).slice(0, -1));
		await handleEdit(lastUser, lastUser.text || lastUser.content || "");
	}, [isAnalyzing, messages, handleEdit, setMessages]);

	const handleKey = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const isEmpty = messages.length === 0;

	return (
		<div
			className="flex flex-col h-full"
			style={{ background: "var(--color-bg)" }}
		>
			{/* Messages */}
			<div className="flex-1 overflow-y-auto px-4 py-6">
				{isEmpty ? (
					<div className="h-full flex flex-col items-center justify-center text-center px-4">
						<div className="w-16 h-16 rounded-3xl bg-blue-600 flex items-center justify-center mb-4 shadow-lg">
							<Car size={28} className="text-white" />
						</div>
						<h1
							className="text-2xl font-bold mb-2"
							style={{ color: "var(--color-text)" }}
						>
							VinCritiq
						</h1>
						<p
							className="text-base mb-1"
							style={{ color: "var(--color-muted)" }}
						>
							AI-powered vehicle deal analysis
						</p>
						<p
							className="text-sm max-w-md"
							style={{ color: "var(--color-muted)" }}
						>
							Upload a CARFAX PDF and/or a vehicle photo to get a professional
							assessment — pricing, financing, depreciation, and a deal verdict.
						</p>
						<div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-lg w-full">
							{[
								{
									title: "Deal Rating",
									desc: "Great / Good / Fair / Bad classification",
								},
								{ title: "Price Analysis", desc: "vs. KBB & market average" },
								{ title: "Depreciation", desc: "1, 3, and 5 year projections" },
							].map((c) => (
								<div
									key={c.title}
									className="rounded-xl p-3 text-left"
									style={{
										background: "var(--color-surface)",
										border: "1px solid var(--color-border)",
									}}
								>
									<div
										className="font-semibold text-sm mb-0.5"
										style={{ color: "var(--color-text)" }}
									>
										{c.title}
									</div>
									<div
										className="text-xs"
										style={{ color: "var(--color-muted)" }}
									>
										{c.desc}
									</div>
								</div>
							))}
						</div>
					</div>
				) : (
					<div className="max-w-3xl mx-auto">
						{messages.map((msg, i) => (
							<MessageBubble
								key={msg.id || i}
								msg={msg}
								onEdit={handleEdit}
								onRetry={handleRetry}
								onViewReport={(msg) =>
									openReport(
										msg.report,
										msg._vehicleColor || activeReport?.vehicleColor,
										activeReport?.vehicleLabel,
										msg._img64,
										msg._imgMt,
										activeReport?.glbUrl,
										activeReport?.modelStatus,
									)
								}
								isLast={i === messages.length - 1}
								isAnalyzing={isAnalyzing}
								isDev={isAdmin(user?.email)}
								onFeedback={(m, value) => recordFeedback(activeSessionId, m.id, value)}
							/>
						))}
						<div ref={bottomRef} />
					</div>
				)}
			</div>

			{/* Input area */}
			<div className="px-4 pb-6 pt-2">
				<div
					className="max-w-3xl mx-auto rounded-2xl overflow-hidden"
					style={{
						border: "1px solid var(--color-border)",
						background: "var(--color-surface)",
						boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
					}}
				>
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							const el = textareaRef.current;
							if (el) {
								el.style.height = "auto";
								el.style.height = Math.min(el.scrollHeight, 220) + "px";
							}
						}}
						onKeyDown={handleKey}
						placeholder={
							carfaxFile || vehicleImage
								? "Add context (asking price, APR, loan term…) or press Enter to analyze"
								: "Ask about a vehicle, upload a CARFAX & photo, or paste a screenshot…"
						}
						rows={1}
						disabled={isAnalyzing}
						className="w-full px-4 pt-4 pb-2 text-sm resize-none outline-none disabled:opacity-60"
						style={{
							background: "transparent",
							color: "var(--color-text)",
							minHeight: 52,
							maxHeight: 220,
							overflowY: "auto",
						}}
					/>
					<div className="flex items-center justify-between px-3 pb-3">
						<UploadArea
							carfaxFile={carfaxFile}
							vehicleImage={vehicleImage}
							onCarfaxChange={setCarfaxFile}
							onVehicleImageChange={setVehicleImage}
						/>
						<button
							onClick={handleSend}
							disabled={
								isAnalyzing || (!input.trim() && !carfaxFile && !vehicleImage)
							}
							className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-30"
							style={{ background: "var(--color-accent)" }}
						>
							<Send size={16} className="text-white" />
						</button>
					</div>
				</div>
				<p
					className="text-center text-xs mt-2"
					style={{ color: "var(--color-muted)" }}
				>
					VinCritiq provides estimates for informational purposes only. Always
					verify with a licensed dealer.
				</p>
			</div>

			{showContextModal && (
				<ContextModal
					onAddContext={() => setShowContextModal(false)}
					onBeginAnalysis={() => runAnalysis("")}
					onClose={() => setShowContextModal(false)}
				/>
			)}

			{showReportModal && activeReport && (
				<ReportModal
					report={activeReport.report}
					vehicleColor={activeReport.vehicleColor}
					vehicleLabel={activeReport.vehicleLabel}
					imageBase64={activeReport.imageBase64}
					imageMediaType={activeReport.imageMediaType}
					glbUrl={activeReport.glbUrl}
					modelStatus={activeReport.modelStatus}
					isReanalyzing={isAnalyzing}
					onClose={() => setShowReportModal(false)}
					onConfirmEdits={(edits) => {
						// Keep the modal open — activeReport will be swapped in place
						// when the new <REPORT> streams back (openReport re-sets it).
						const msg =
							`Re-analyze this deal with these updated financing terms and give me a fresh <REPORT> using these exact numbers:\n` +
							`- Sale Price: $${Math.round(edits.price).toLocaleString()}\n` +
							`- Down Payment: $${Math.round(edits.downPayment).toLocaleString()}\n` +
							`- APR: ${edits.apr}%\n` +
							`- Term: ${edits.termMonths} months\n` +
							`Computed on the client: monthly ≈ $${Math.round(edits.monthly).toLocaleString()}, total interest ≈ $${Math.round(edits.totalInterest).toLocaleString()}, total cost ≈ $${Math.round(edits.totalCost).toLocaleString()}.\n` +
							`Re-evaluate the deal rating (Great/Good/Fair/Bad) given these terms and the same vehicle. Keep the vehicle, depreciation, and market values the same; only the financing block and verdict should change.`;
						runAnalysis(msg);
					}}
				/>
			)}
		</div>
	);
}
