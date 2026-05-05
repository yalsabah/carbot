import {
  Award,
  Car,
  Check,
  Copy,
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
import { generateOrFetch3D, lookupCachedModel } from "../utils/model3d";
import { uploadVehicleImages } from "../utils/imageStorage";
import { compressImageFiles } from "../utils/imageCompress";
import { createCostAccumulator, FIXED_COSTS } from "../utils/pricing";
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

// True when regenerating the assistant response would replay all the same
// inputs the user originally provided. Files (images, PDFs) aren't persisted
// across page reloads, so a session loaded from the sidebar has the file
// names listed but no bytes — regenerating then would silently drop them and
// produce a degraded result. We disable the button in that case.
function canRegenerateFromUserMsg(userMsg) {
	if (!userMsg) return true;
	const files = Array.isArray(userMsg.files) ? userMsg.files : [];
	if (files.length === 0) return true; // text-only message, always reproducible
	const hadPdf = files.some((f) => typeof f === "string" && f.includes("📄"));
	const hadImage = files.some((f) => typeof f === "string" && f.includes("🖼"));
	if (hadPdf && !userMsg._carfaxText) return false;
	if (hadImage && !userMsg._img64) return false;
	return true;
}

// Note: there is intentionally no UI surface for `msg.totalCost`. Per-message
// cost breakdown is persisted to Firestore (users/{uid}/sessions/{sid}/messages/{mid})
// for developer review in the Firebase console only. If you ever want to
// surface it back in the UI, the data shape is { total, items: [...] }.

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
	canRetry = true,
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

				{/* Files indicator. When the user message has in-session image
				    data (msg._attachments with dataUrl), render real 56px thumbnails
				    that open the lightbox on click. History view (loaded from
				    Firestore where bytes are not persisted) falls back to a textual
				    chip. PDFs always show as a textual chip. */}
				{((msg._attachments && msg._attachments.length > 0) ||
					(msg.imageUrls && msg.imageUrls.length > 0) ||
					(msg.files && msg.files.length > 0)) && (() => {
					// Source priority for thumbnails:
					//   1. _attachments (in-session, data URLs) — fastest, fresh upload
					//   2. imageUrls (persisted to Firestore, Storage HTTPS URLs) +
					//      whatever PDF chips exist in `files`
					//   3. files (text-only fallback, e.g. older messages from before
					//      we wrote imageUrls)
					let items;
					if (Array.isArray(msg._attachments) && msg._attachments.length > 0) {
						items = msg._attachments;
					} else if (Array.isArray(msg.imageUrls) && msg.imageUrls.length > 0) {
						items = [];
						// PDFs aren't uploaded; surface them from the textual `files` array.
						for (const f of msg.files || []) {
							if (typeof f === "string" && f.includes("📄")) {
								items.push({
									kind: "pdf",
									name: f.replace(/^[^a-zA-Z0-9]*\s*/, ""),
								});
							}
						}
						for (const u of msg.imageUrls) {
							items.push({ kind: "image", name: u.name, dataUrl: u.url });
						}
					} else {
						items = (msg.files || []).map((f) => ({
							kind: typeof f === "string" && f.includes("📄") ? "pdf" : "image",
							name: typeof f === "string" ? f.replace(/^[^a-zA-Z0-9]*\s*/, "") : "file",
							dataUrl: null,
						}));
					}
					return (
						<div
							className={`flex flex-wrap gap-1.5 mt-2 ${isUser ? "justify-end" : ""}`}
						>
							{items.map((item, i) =>
								item.kind === "image" && item.dataUrl ? (
									<button
										key={i}
										onClick={() => msg._onPreview && msg._onPreview(item.dataUrl)}
										title={item.name}
										aria-label={`Preview ${item.name}`}
										className="rounded-lg overflow-hidden flex-shrink-0 transition-transform hover:scale-105"
										style={{
											width: 56,
											height: 56,
											border: "1px solid var(--color-border)",
											background: "var(--color-bg)",
											padding: 0,
											cursor: "zoom-in",
										}}
									>
										<img
											src={item.dataUrl}
											alt={item.name}
											style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
										/>
									</button>
								) : (
									<span
										key={i}
										className="text-xs px-2 py-1 rounded-lg inline-flex items-center gap-1"
										style={{
											background: "var(--color-bg)",
											border: "1px solid var(--color-border)",
											color: "var(--color-muted)",
										}}
										title={item.name}
									>
										{item.kind === "pdf" ? "📄" : "🖼"}{" "}
										{(item.name || "").replace(/^[^a-zA-Z0-9]*\s*/, "").slice(0, 28)}
									</span>
								),
							)}
						</div>
					);
				})()}

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

				{/* Cost breakdown is intentionally NOT rendered. The data still
				    persists on every assistant message via persistLastMessage /
				    updateMessage as `totalCost`, and is queryable in the Firebase
				    console at users/{uid}/sessions/{sid}/messages/{mid}. CostBadge
				    is kept exported so it can be re-enabled later if needed. */}

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
								onClick={canRetry ? onRetry : undefined}
								disabled={!canRetry}
								title={
									canRetry
										? "Regenerate"
										: "Re-attach files to regenerate — originals weren't preserved across the page reload"
								}
								className="p-1.5 rounded-lg transition-all"
								style={{
									color: "var(--color-muted)",
									opacity: canRetry ? 1 : 0.35,
									cursor: canRetry ? "pointer" : "not-allowed",
								}}
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

// Module-level cache of url → { base64, mediaType }. Populated lazily by
// fetchUrlAsBase64 so re-using the same Storage URL across many follow-up
// turns (or after a refresh) doesn't re-download the bytes every time.
const _imageBase64Cache = new Map();

async function fetchUrlAsBase64(url) {
	if (!url) return null;
	if (_imageBase64Cache.has(url)) return _imageBase64Cache.get(url);
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		const blob = await res.blob();
		const mediaType = blob.type || "image/jpeg";
		const base64 = await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				// strip "data:...;base64," prefix
				const s = String(reader.result || "");
				const i = s.indexOf(",");
				resolve(i >= 0 ? s.slice(i + 1) : s);
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
		const entry = { base64, mediaType };
		_imageBase64Cache.set(url, entry);
		return entry;
	} catch {
		return null;
	}
}

// Walk the message list backwards looking for the most recent user-attached
// CARFAX text and image set. Returns the inputs we'd need to pass back into
// streamCarAnalysis() so a follow-up turn or a refresh-then-followup retains
// the visual + document context. Without this, "what color are the rims?"
// after refresh asks Claude with no images and gets a nonsense answer.
//
// Source priority for images:
//   1. _attachments[i].dataUrl  (in-session, no network)
//   2. imageUrls[i].url         (Firebase Storage; we fetch + base64 once,
//                                cached across calls)
async function collectHistoryAttachments(messages) {
	let carfaxText = "";
	let images = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (!carfaxText && typeof m.carfaxText === "string" && m.carfaxText) {
			carfaxText = m.carfaxText;
		}
		if (!carfaxText && typeof m._carfaxText === "string" && m._carfaxText) {
			carfaxText = m._carfaxText;
		}
		if (images.length === 0) {
			if (Array.isArray(m._attachments) && m._attachments.length) {
				const fromAtt = [];
				for (const a of m._attachments) {
					if (a.kind !== "image" || !a.dataUrl) continue;
					const [meta, data] = String(a.dataUrl).split(",");
					const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
					if (data) fromAtt.push({ base64: data, mediaType, name: a.name });
				}
				if (fromAtt.length) images = fromAtt;
			}
			if (images.length === 0 && Array.isArray(m.imageUrls) && m.imageUrls.length) {
				const fetched = await Promise.all(
					m.imageUrls.map(async (u) => {
						const e = await fetchUrlAsBase64(u.url);
						return e ? { base64: e.base64, mediaType: e.mediaType, name: u.name } : null;
					}),
				);
				images = fetched.filter(Boolean);
			}
		}
		// Stop once we've seen a user turn that had any attachment indicator.
		// Earlier turns are by definition older; we don't want to fall through.
		if (
			carfaxText ||
			images.length > 0 ||
			(Array.isArray(m.files) && m.files.length > 0)
		) {
			break;
		}
	}
	return { carfaxText, images };
}

// ─── Main ChatInterface ────────────────────────────────────────────────────────
export default function ChatInterface({ onShowUpgrade, onShowAuth, compactTriggerRef, onCompactingChange }) {
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
	// Multiple images supported. Each entry is a File object. Append/remove
	// via setVehicleImages; runAnalysis flattens to base64+mediaType array
	// before sending to Claude / Tripo3D.
	const [vehicleImages, setVehicleImages] = useState([]);
	// Lightbox preview for clicking on a thumbnail. null when closed.
	const [previewImageUrl, setPreviewImageUrl] = useState(null);
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

	// Paste image(s) from clipboard. Appends to the current list rather than
	// replacing — the user can paste several screenshots in succession.
	useEffect(() => {
		const handlePaste = (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			const pasted = [];
			for (const item of items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) {
						const ext = item.type.split("/")[1] || "png";
						pasted.push(
							new File([file], `screenshot-${Date.now()}-${pasted.length}.${ext}`, {
								type: item.type,
							}),
						);
					}
				}
			}
			if (pasted.length) {
				setVehicleImages((prev) => [...prev, ...pasted]);
				e.preventDefault();
			}
		};
		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, []);

	useEffect(() => {
		if (carfaxFile && vehicleImages.length > 0 && !isAnalyzing)
			setShowContextModal(true);
	}, [carfaxFile, vehicleImages.length, isAnalyzing]);

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
			userImages = [], // [{ kind:'image', name, dataUrl }]
		) => {
			// Replace state cleanly — never carry over a previous report's glbUrl.
			// Carrying it over caused the previous car's GLB to render briefly while
			// the new car's 3D was still generating. The cache lookup below (and
			// startRodinJob's onProgress callback) re-populates glbUrl as soon as
			// it's available, so a brief procedural fallback flash on switch is
			// the right behavior.
			setActiveReport({
				report,
				vehicleColor,
				vehicleLabel,
				imageBase64,
				imageMediaType,
				glbUrl,
				modelStatus,
				userImages,
			});
			setShowReportModal(true);

			// Cache rehydration on history view: when the user re-opens an old
			// report after a page reload, glbUrl isn't in component state and
			// isn't persisted on the message doc — but the trim's GLB lives in
			// R2 + Firestore (models3d/{slug}). One Firestore read tells us if
			// it's ready, in which case we surface it immediately without
			// re-running Tripo3D. Fresh analyses skip this — they have their
			// own startRodinJob path that handles cache hits there.
			if (!glbUrl && report?.vehicle) {
				lookupCachedModel(report.vehicle).then((cached) => {
					if (cached?.glbUrl) {
						setActiveReport((prev) =>
							prev
								? { ...prev, glbUrl: cached.glbUrl, modelStatus: "CacheHit" }
								: prev,
						);
					}
				});
			}
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
		async (imageBase64, imageMediaType, _prompt, vehicle = null, cost = null, sessionId = null, messageId = null, images = null) => {
			rodinAbort.current?.abort();
			const controller = new AbortController();
			rodinAbort.current = controller;
			const isDev =
				typeof window !== "undefined" && process.env.NODE_ENV !== "production";
			if (isDev) console.log("%c[3d]", "color:#2563eb;font-weight:bold", "startRodinJob fired", { vehicle, imageCount: images?.length || (imageBase64 ? 1 : 0) });
			try {
				const result = await generateOrFetch3D({
					vehicle,
					images: images && images.length ? images : undefined,
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
				if (controller.signal.aborted) {
					if (isDev) console.log("%c[3d]", "color:#dc2626;font-weight:bold", "startRodinJob aborted before result applied");
					return;
				}
				if (isDev) console.log("%c[3d]", "color:#2563eb;font-weight:bold", "startRodinJob got result", result);
				if (result?.glbUrl) {
					setActiveReport((prev) => {
						if (!prev) {
							if (isDev) console.log("%c[3d]", "color:#dc2626;font-weight:bold", "activeReport is null — modal closed before GLB landed; will still stamp on message so reopen works");
							return prev;
						}
						return { ...prev, glbUrl: result.glbUrl, modelStatus: "Done" };
					});
					// In-memory always: lets close-and-reopen of the modal in the
					// CURRENT session keep showing the GLB without re-fetching.
					updateLastMessage((prev) => ({
						...prev,
						_glbUrl: result.glbUrl,
						_modelStatus: "Done",
					}));

					// What we persist to Firestore depends on the URL origin:
					//
					//   - R2 URL (production happy path): persist freely. R2 URLs
					//     don't expire and the bucket has CORS configured.
					//
					//   - Tripo CDN URL (dev — no R2 binding): persist the RAW
					//     Tripo URL (the unproxied form so the expiry check
					//     stays meaningful). The display path re-proxies it
					//     through /dev-glb-proxy. Set glbUrlExpiresAt 22h out so
					//     refresh-within-the-day still hits the cache; expired
					//     entries are filtered out on read.
					//
					//   - Tripo URL in PRODUCTION: never persist. That would
					//     mean R2 is misconfigured (MODELS_PUBLIC_BASE missing)
					//     and persisting a no-CORS URL guarantees the modal
					//     hard-errors on refresh.
					const isTripoCdn = /tripo3d\.com\//.test(result.glbUrl);
					const isProxied = result.glbUrl.startsWith('/dev-glb-proxy');
					// In dev, result.glbUrl is the proxied form; recover the raw
					// Tripo URL out of it for persistence.
					const rawUrl = isProxied
						? decodeURIComponent(result.glbUrl.split("url=")[1] || "")
						: result.glbUrl;
					const rawIsTripo = /tripo3d\.com\//.test(rawUrl);

					if (rawIsTripo) {
						if (isDev && sessionId && messageId) {
							const patch = {
								glbUrl: rawUrl,
								glbUrlSource: "tripo",
								glbUrlExpiresAt: Date.now() + 22 * 60 * 60 * 1000,
							};
							updateLastMessage((prev) => ({ ...prev, ...patch }));
							updateMessage(sessionId, messageId, patch);
						} else if (!isDev) {
							console.warn(
								"[3d] R2 returned a Tripo URL in production — MODELS_PUBLIC_BASE likely not set. Not persisting.",
								{ sample: result.glbUrl.slice(0, 80) },
							);
						}
					} else if (!isTripoCdn && !isProxied && sessionId && messageId) {
						// R2 URL — production happy path.
						const patch = { glbUrl: result.glbUrl, glbUrlSource: "r2" };
						updateLastMessage((prev) => ({ ...prev, ...patch }));
						updateMessage(sessionId, messageId, patch);
					}
				} else {
					updateLastMessage((prev) => ({
						...prev,
						_modelStatus: "Failed",
					}));
				}
			} catch (err) {
				if (isDev) console.warn("%c[3d]", "color:#dc2626;font-weight:bold", "startRodinJob threw", err);
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

			// Compress photos up-front. 1568px JPEG q≈0.82 keeps them well under
			// 300KB each, so 6 photos + carfax stays inside both Anthropic's
			// per-image policy and the Cloudflare Pages function body limit.
			// The originals were causing /api/claude to return 500 on multi-image
			// uploads. Same compressed Files are reused for the in-message
			// _attachments preview AND the Firebase Storage upload, so we do
			// the work once.
			const compressedImages = await compressImageFiles(vehicleImages);

			const userFiles = [];
			if (carfaxFile) userFiles.push(`📄 ${carfaxFile.name}`);
			for (const img of compressedImages) userFiles.push(`🖼 ${img.name}`);

			// Build _attachments — in-session-only structured representation
			// so MessageBubble can render real thumbnails (not just "🖼 name.jpg").
			// PDFs stay as kind:'pdf' chips. Images carry a data URL for preview.
			const userAttachments = [];
			if (carfaxFile) {
				// Carry a data URL on the PDF chip so the sidebar can open it
				// in a new tab (native browser PDF viewer). Only kept in-session;
				// after refresh the dataUrl is gone and the chip becomes a label.
				let pdfDataUrl = null;
				try {
					pdfDataUrl = await new Promise((resolve, reject) => {
						const r = new FileReader();
						r.onload = () => resolve(r.result);
						r.onerror = reject;
						r.readAsDataURL(carfaxFile);
					});
				} catch {
					pdfDataUrl = null;
				}
				userAttachments.push({
					kind: "pdf",
					name: carfaxFile.name,
					dataUrl: pdfDataUrl,
				});
			}
			for (const img of compressedImages) {
				try {
					const dataUrl = await new Promise((resolve, reject) => {
						const r = new FileReader();
						r.onload = () => resolve(r.result);
						r.onerror = reject;
						r.readAsDataURL(img);
					});
					userAttachments.push({ kind: "image", name: img.name, dataUrl });
				} catch {
					userAttachments.push({ kind: "image", name: img.name, dataUrl: null });
				}
			}

			const userText = extraText || input || "Analyze this vehicle deal.";
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";

			// Extract CARFAX text up-front so we can persist it on the user
			// message. Doing it here (rather than in the analyze step below)
			// means follow-up turns can read it from the message history
			// without re-parsing, and refresh-then-follow-up still works.
			let userCarfaxText = "";
			if (carfaxFile) {
				try {
					userCarfaxText = await extractTextFromPDF(carfaxFile);
				} catch {
					userCarfaxText = "";
				}
			}

			const userMessageId = await addMessage(sessionId, {
				role: "user",
				text: userText,
				files: userFiles,
				// `carfaxText` (no underscore) — persisted to Firestore so
				// follow-up turns / regenerates can re-include the document
				// after a refresh. Typical sizes are 5-15KB; well under the
				// Firestore 1MB-per-doc limit.
				carfaxText: userCarfaxText || null,
				_attachments: userAttachments,
			});

			// Background-upload the vehicle photos to Firebase Storage so they
			// survive a page refresh / chat-switch round-trip. The user message
			// already saved with its in-memory _attachments (data URLs) so the
			// UI is responsive immediately; once the uploads finish we patch
			// `imageUrls` onto the same Firestore doc. If upload fails we leave
			// the message untouched — the next refresh will fall back to the
			// textual chips, same as before this change.
			if (user && userMessageId && compressedImages.length > 0) {
				uploadVehicleImages(user.uid, sessionId, compressedImages)
					.then((uploaded) => {
						if (uploaded.length === 0) return;
						const imageUrls = uploaded.map((u) => ({ url: u.url, name: u.name }));
						updateMessage(sessionId, userMessageId, { imageUrls });
					})
					.catch(() => {});
			}

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

			// CARFAX was already extracted up-front (so it could be persisted
			// on the user message). Just surface progress for the user.
			let carfaxText = userCarfaxText || "";
			// Multi-image: array of { base64, mediaType, name } sent to Claude.
			// imageBase64 / imageMediaType remain populated with the FIRST image
			// for back-compat with the rest of the pipeline (Tripo3D, modal preview).
			const processedImages = [];
			let imageBase64 = null;
			let imageMediaType = null;
			let vehicleColorRef = null;

			if (carfaxFile) {
				pushStep(`Reading CARFAX PDF: ${carfaxFile.name}`);
				if (carfaxText) {
					const vinMatch = carfaxText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
					doneStep(
						steps.length - 1,
						`CARFAX extracted${vinMatch ? ` · VIN: ${vinMatch[0]}` : ""} · ${Math.round(carfaxText.length / 1000)}k chars`,
					);
				} else {
					carfaxText = "[PDF parsing failed]";
					failStep(
						steps.length - 1,
						"PDF parsing failed — will use manual description",
					);
				}
			}

			if (compressedImages.length > 0) {
				const labelMany = compressedImages.length > 1 ? `${compressedImages.length} images` : compressedImages[0].name;
				pushStep(`Processing ${labelMany}`);
				try {
					for (const file of compressedImages) {
						const b64 = await fileToBase64(file);
						const mt = getMediaType(file);
						processedImages.push({ base64: b64, mediaType: mt, name: file.name });
					}
					// First image is the reference for downstream things that still
					// expect a single image (Tripo3D job, modal preview color sample).
					imageBase64 = processedImages[0]?.base64 || null;
					imageMediaType = processedImages[0]?.mediaType || null;
					vehicleColorRef = await getDominantColor(compressedImages[0]);
					const totalKB = processedImages.reduce(
						(sum, p) => sum + Math.round((p.base64.length * 0.75) / 1024),
						0,
					);
					doneStep(
						steps.length - 1,
						`${processedImages.length} image${processedImages.length > 1 ? "s" : ""} ready · ${totalKB}KB · color sampled`,
					);
				} catch {
					failStep(steps.length - 1, "Image processing failed");
				}
			}

			// Mirror file refs onto the user message in local state so in-session
			// reload/regenerate replays the same inputs. These fields are NOT
			// persisted to Firestore (image bytes are too large; CARFAX text is
			// also kept session-local for symmetry). Once the page reloads or
			// the user opens an old session from the sidebar, the regenerate
			// button is disabled — see canRegenerate() in the render path.
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
					images: processedImages,
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
					// Pass user-uploaded photos (as { name, dataUrl }) into the modal
					// so the new "Car Images" tab can show them. Each entry is
					// data-URL-encoded so the report still renders if the user
					// swaps the underlying File reference.
					const userImagesForReport = userAttachments.filter(
						(a) => a.kind === "image" && a.dataUrl,
					);
					// Stamp the in-session image data + (later) the glbUrl onto the
					// assistant message itself, so closing and re-opening the report
					// preserves both. sanitizeForFirestore strips _-prefixed fields,
					// so this stays in memory only — no Firestore bloat.
					updateLastMessage((prev) => ({
						...prev,
						_userImages: userImagesForReport,
						_vehicleLabel: vLabel,
					}));
					openReport(
						report,
						vehicleColorRef,
						vLabel,
						imageBase64,
						imageMediaType,
						null,
						null,
						userImagesForReport,
					);
					// Kick off 3D model generation in background. Pass the cost
					// accumulator + persisted message ID so VinAudit/Tripo costs
					// land on the same message once they fire.
					const prompt = `${vLabel} exterior, realistic car`;
					startRodinJob(imageBase64, imageMediaType, prompt, report.vehicle, cost, sessionId, persistedId, processedImages);
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
			setVehicleImages([]);
			setIsAnalyzing(false);
		},
		[
			activeSessionId,
			carfaxFile,
			vehicleImages,
			input,
			messages,
			checkQuota,
			consumeQuota,
			createSession,
			addMessage,
			persistLastMessage,
			updateLastMessage,
			updateMessage,
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

	// /compact — collapse the conversation into a summary so subsequent turns
	// fit comfortably in Claude's context. Replaces the visible message list
	// with a single assistant note containing the summary, keeps the original
	// messages in Firestore (we just stop sending them as context).
	const compactConversation = useCallback(async () => {
		if (isAnalyzing) return;
		const visible = messages.filter(
			(m) => (m.role === "user" || m.role === "assistant") && (m.text || m.content),
		);
		if (visible.length === 0) return;
		onCompactingChange?.(true);
		try {
			const transcript = visible
				.map((m) => `${m.role.toUpperCase()}: ${(m.text || m.content || "").slice(0, 4000)}`)
				.join("\n\n");

			let summary = "";
			const stream = streamCarAnalysis({
				carfaxText: "",
				messages: [
					{
						role: "user",
						text:
							`Summarize this car-deal-analysis conversation into a compact running context. ` +
							`Keep: vehicle (year/make/model/VIN), CARFAX highlights, asking price, financing terms, ` +
							`final verdict + key reasoning, and any user preferences expressed. Drop pleasantries, ` +
							`drop streamed tool steps. Output a single dense paragraph of 6-10 sentences. Do NOT ` +
							`emit a <REPORT> block.\n\n--- TRANSCRIPT ---\n${transcript}`,
					},
				],
				userMemory: buildUserMemory(),
				vinDecode: null,
			});
			for await (const chunk of stream) {
				if (typeof chunk === "string") summary += chunk;
			}
			summary = summary.replace(/<REPORT>[\s\S]*?<\/REPORT>/g, "").trim();
			if (!summary) summary = "(Compaction returned an empty summary; the original conversation is preserved in your session history.)";

			setMessages([
				{
					id: `compact-${Date.now()}`,
					role: "assistant",
					text: `📎 **Conversation compacted** — earlier turns summarized below to free context space.\n\n${summary}`,
					_compacted: true,
				},
			]);
		} catch (err) {
			console.error("compactConversation failed", err);
		} finally {
			onCompactingChange?.(false);
		}
	}, [isAnalyzing, messages, buildUserMemory, setMessages, onCompactingChange]);

	// Expose the compact trigger to App.js so the right sidebar's button can
	// fire it without going through the chat input.
	useEffect(() => {
		if (compactTriggerRef) compactTriggerRef.current = compactConversation;
		return () => {
			if (compactTriggerRef) compactTriggerRef.current = null;
		};
	}, [compactTriggerRef, compactConversation]);

	const handleSend = async () => {
		const text = input.trim();
		if (!text && !carfaxFile && vehicleImages.length === 0) return;
		if (isAnalyzing) return;

		// Slash commands — handled before the regular chat path.
		if (text === "/compact") {
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";
			await compactConversation();
			return;
		}

		if (carfaxFile || vehicleImages.length > 0) {
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

			// Re-attach the most recent CARFAX + photos to this follow-up turn
			// so questions like "what color are the rims?" can actually look at
			// the photos. fetchUrlAsBase64 caches per-URL, so the second
			// follow-up doesn't re-download.
			const history = await collectHistoryAttachments(messages);

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: history.carfaxText || "",
					images: history.images,
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
			// These only exist for messages from the current session — once the page
			// reloads, they're gone, and the regenerate button is disabled upstream
			// to prevent half-input replays. See canRegenerate() in the render path.
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

			// Pull attachments from the truncated history so a re-analyze still
			// has the visual context, even after a refresh (where in-memory
			// _carfaxText / _img64 are gone but persisted carfaxText / imageUrls
			// remain). The msg object itself is preferred over collectHistory…
			// because edit always re-uses the EDITED message's own attachments.
			let editCarfaxText = carfaxText;
			let editImages = imageBase64 && imageMediaType
				? [{ base64: imageBase64, mediaType: imageMediaType }]
				: [];
			if (!editCarfaxText && typeof msg.carfaxText === "string") editCarfaxText = msg.carfaxText;
			if (editImages.length === 0) {
				const recovered = await collectHistoryAttachments([msg]);
				if (recovered.images.length) editImages = recovered.images;
				if (!editCarfaxText && recovered.carfaxText) editCarfaxText = recovered.carfaxText;
			}

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: editCarfaxText || "",
					images: editImages,
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
						{messages.map((msg, i) => {
							const isLast = i === messages.length - 1;
							// canRetry only matters for the last assistant message — that's
							// where the regenerate button renders. Look back to find the
							// previous user message and check whether its file bytes are
							// still available in memory.
							let canRetry = true;
							if (isLast && msg.role === "assistant") {
								for (let j = i - 1; j >= 0; j--) {
									if (messages[j].role === "user") {
										canRetry = canRegenerateFromUserMsg(messages[j]);
										break;
									}
								}
							}
							// Inject the _onPreview callback so MessageBubble's image
							// thumbnails can open the lightbox without needing the
							// component to know about ChatInterface state.
							const msgWithPreview = msg._attachments
								? { ...msg, _onPreview: (url) => setPreviewImageUrl(url) }
								: msg;
							return (
								<MessageBubble
									key={msg.id || i}
									msg={msgWithPreview}
									onEdit={handleEdit}
									onRetry={handleRetry}
									onViewReport={(m) => {
										// Pull every cached field straight off the assistant message
										// so close-then-reopen of the report restores the same vehicle
										// photos and the same generated GLB. Falls back to the previous
										// user message's _attachments when the assistant message itself
										// does not carry _userImages.
										const label = m.report
											? `${m.report.vehicle?.year || ""} ${m.report.vehicle?.make || ""} ${m.report.vehicle?.model || ""}`.trim()
											: null;
										// Resolve userImages with cascading fallbacks:
										//   1. _userImages on the assistant message (in-session)
										//   2. _attachments on the prior user message (in-session)
										//   3. imageUrls on the prior user message (Firestore-persisted,
										//      Storage HTTPS URLs — survives refresh / chat-switch)
										let userImages = Array.isArray(m._userImages) ? m._userImages : null;
										if (!userImages || userImages.length === 0) {
											const idx = messages.lastIndexOf(m);
											for (let j = idx - 1; j >= 0; j--) {
												const prevM = messages[j];
												if (prevM.role !== "user") continue;
												if (Array.isArray(prevM._attachments) && prevM._attachments.some((a) => a.dataUrl)) {
													userImages = prevM._attachments.filter((a) => a.kind === "image" && a.dataUrl);
													break;
												}
												if (Array.isArray(prevM.imageUrls) && prevM.imageUrls.length > 0) {
													userImages = prevM.imageUrls.map((u) => ({ kind: "image", name: u.name, dataUrl: u.url }));
													break;
												}
												break;
											}
										}
										// glbUrl resolution:
										//   - in-memory _glbUrl is always preferred (already proxied
										//     for dev, R2-direct in prod).
										//   - Firestore glbUrl: in dev, route Tripo URLs through
										//     /dev-glb-proxy (browser CORS bypass). In prod, refuse
										//     them — Tripo CDN serves no CORS headers, so loading
										//     directly hard-errors. lookupCachedModel inside openReport
										//     can still recover an R2 URL from models3d/{slug}.
										//   - glbUrlExpiresAt: ignore the persisted URL if past
										//     expiry (Tripo's CloudFront signatures last ~24h).
										const isTripoUrl = (u) =>
											typeof u === "string" && /tripo3d\.com\//.test(u);
										const isDevEnv = process.env.NODE_ENV !== "production";
										let resolvedGlbUrl = m._glbUrl || null;
										if (!resolvedGlbUrl && m.glbUrl) {
											const expiresAt = m.glbUrlExpiresAt;
											const expired =
												typeof expiresAt === "number" && Date.now() > expiresAt;
											if (!expired) {
												if (isTripoUrl(m.glbUrl)) {
													if (isDevEnv) {
														resolvedGlbUrl = `/dev-glb-proxy?url=${encodeURIComponent(m.glbUrl)}`;
													}
													// prod: leave null — fall through to lookupCachedModel
												} else {
													resolvedGlbUrl = m.glbUrl;
												}
											}
										}
										openReport(
											m.report,
											m._vehicleColor || null,
											label || m._vehicleLabel || activeReport?.vehicleLabel,
											m._img64,
											m._imgMt,
											resolvedGlbUrl,
											m._modelStatus || (resolvedGlbUrl ? "Done" : null),
											userImages || [],
										);
									}}
									isLast={isLast}
									isAnalyzing={isAnalyzing}
									canRetry={canRetry}
									onFeedback={(m, value) =>
										recordFeedback(activeSessionId, m.id, value)
									}
								/>
							);
						})}
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
							carfaxFile || vehicleImages.length > 0
								? "Add context (asking price, APR, loan term…) or press Enter to analyze"
								: "Ask about a vehicle, upload a CARFAX & photos, or paste a screenshot…"
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
					<div className="flex items-center justify-between px-3 pb-3 gap-2">
						<UploadArea
							carfaxFile={carfaxFile}
							vehicleImages={vehicleImages}
							onCarfaxChange={setCarfaxFile}
							onVehicleImagesChange={setVehicleImages}
							onPreviewImage={(url) => setPreviewImageUrl(url)}
						/>
						<button
							onClick={handleSend}
							disabled={
								isAnalyzing ||
								(!input.trim() && !carfaxFile && vehicleImages.length === 0)
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

			{previewImageUrl && (
				<div
					onClick={() => setPreviewImageUrl(null)}
					className="fixed inset-0 z-[60] flex items-center justify-center cursor-zoom-out"
					style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)" }}
					role="dialog"
					aria-label="Image preview"
				>
					<img
						src={previewImageUrl}
						alt="Attached vehicle"
						className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
						style={{ objectFit: "contain" }}
					/>
				</div>
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
					userImages={activeReport.userImages || []}
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
