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
import { submitRodinJob, submitRodinJobFromVehicle, waitForRodinModel } from "../utils/hyper3d";
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

// ─── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({
	msg,
	onEdit,
	onCopy,
	onRetry,
	onViewReport,
	isLast,
	isAnalyzing,
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
									title="Good response"
									className="p-1.5 rounded-lg transition-all"
									style={{ color: "var(--color-muted)" }}
								>
									<ThumbsUp size={13} />
								</button>
								<button
									title="Bad response"
									className="p-1.5 rounded-lg transition-all"
									style={{ color: "var(--color-muted)" }}
								>
									<ThumbsDown size={13} />
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
		setMessages,
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

	// Start Hyper3D model generation in background after analysis completes
	const startRodinJob = useCallback(
		async (imageBase64, imageMediaType, prompt, vehicleFallback = null) => {
			rodinAbort.current?.abort();
			const controller = new AbortController();
			rodinAbort.current = controller;
			try {
				const job = imageBase64
					? await submitRodinJob(imageBase64, imageMediaType, prompt)
					: await submitRodinJobFromVehicle(vehicleFallback);
				if (!job || controller.signal.aborted) return;
				setActiveReport((prev) =>
					prev ? { ...prev, modelStatus: "Pending" } : prev,
				);
				const glbUrl = await waitForRodinModel(
					job.taskUuid,
					job.jobUuid,
					(status) =>
						setActiveReport((prev) =>
							prev ? { ...prev, modelStatus: status } : prev,
						),
					controller.signal,
				);
				if (glbUrl && !controller.signal.aborted) {
					setActiveReport((prev) =>
						prev ? { ...prev, glbUrl, modelStatus: "Done" } : prev,
					);
				}
			} catch {
				// Hyper3D not configured or failed — silent
			}
		},
		[],
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
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
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
					// Kick off Hyper3D 3D model generation in background.
					// If the user attached a photo, use it. Otherwise fall back to
					// text-to-3D using the decoded vehicle data (VIN path).
					const prompt = `${vLabel} exterior, realistic car`;
					startRodinJob(imageBase64, imageMediaType, prompt, report.vehicle);
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
			user,
			onShowAuth,
			onShowUpgrade,
			buildUserMemory,
			openReport,
			startRodinJob,
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

			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession(text.slice(0, 50));
			await addMessage(sessionId, { role: "user", text });
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "";
			await consumeQuota();

			const streamMsg = { role: "assistant", text: "", isStreaming: true };
			await addMessage(sessionId, streamMsg);

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: "",
					messages: [...messages, { role: "user", text }],
					userMemory: buildUserMemory(),
				});
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						fullText += chunk;
						const _ft = fullText;
						updateLastMessage((prev) => ({ ...prev, text: _ft }));
					}
				}
				const report = parseReport(fullText);
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
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
			let sessionId = activeSessionId;
			if (!sessionId) sessionId = await createSession(newText.slice(0, 50));
			await addMessage(sessionId, {
				role: "user",
				text: newText,
				files: msg.files,
			});
			await consumeQuota();

			const streamMsg = { role: "assistant", text: "", isStreaming: true };
			await addMessage(sessionId, streamMsg);

			let fullText = "";
			try {
				const stream = streamCarAnalysis({
					carfaxText: "",
					messages: [...truncated, { role: "user", text: newText }],
					userMemory: buildUserMemory(),
				});
				for await (const chunk of stream) {
					if (typeof chunk === "string") {
						fullText += chunk;
						const _ft = fullText;
						updateLastMessage((prev) => ({ ...prev, text: _ft }));
					}
				}
				const report = parseReport(fullText);
				updateLastMessage((prev) => ({
					...prev,
					isStreaming: false,
					text: fullText,
					report,
				}));
				persistLastMessage(sessionId, {
					role: "assistant",
					text: fullText,
					report: report || null,
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
							CarBot
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
					CarBot provides estimates for informational purposes only. Always
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
					onClose={() => setShowReportModal(false)}
				/>
			)}
		</div>
	);
}
