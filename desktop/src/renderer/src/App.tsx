import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleStop,
  FileText,
  ListPlus,
  Loader2,
  Mic,
  MicOff,
  PictureInPicture,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  Video,
  Wand2,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8010";
const ASR_CHUNK_SAMPLES = 960;
const ASR_TARGET_SAMPLE_RATE = 16000;
const FLOATING_VIDEO_WINDOW_NAME = "livetalking-floating-video";
const SCRIPT_MODEL_CONFIG_STORAGE_KEY = "livetalking.scriptModelConfig";
const SCRIPT_USER_PROMPT_STORAGE_KEY = "livetalking.scriptUserPromptTemplate";
const SCRIPT_FORBIDDEN_WORDS_STORAGE_KEY = "livetalking.scriptForbiddenWords";
const MAX_PENDING_SCRIPTS = 50;
const MAX_FORBIDDEN_WORD_RETRIES = 3;
const PRODUCT_DESCRIPTION_PLACEHOLDERS = ["{productDescription}", "{{productDescription}}", "{产品描述}", "{{产品描述}}"] as const;
const DEFAULT_SCRIPT_USER_PROMPT_TEMPLATE = [
  "根据下面的产品描述，生成一段 60 到 90 秒的智能体直播口播文稿。",
  "结构要自然包含：开场抓注意力、用户痛点、核心卖点、使用场景、互动引导、咨询转化。",
  "文稿要适合数字人直接播报，句子短一些，有停顿感，但不要写括号动作提示。",
  "",
  "产品描述：{productDescription}",
].join("\n");

type StatusTone = "idle" | "active" | "pending" | "error" | "success";
type LogLevel = "info" | "success" | "warn" | "error";
type RtcStatus = "idle" | "connecting" | "connected" | "error";
type AsrStatus = "idle" | "connecting" | "recording" | "recognizing" | "error";
type BackendStatus = "unknown" | "checking" | "online" | "offline";
type HumanMode = "echo" | "chat";
type AppPage = "control" | "script";
type HumanTextSource = "manual" | "asr" | "script";

interface ScriptModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface PendingScriptEntry {
  id: string;
  text: string;
  preview: string;
  createdAt: string;
}

interface PendingScriptContextMenu {
  entryId: string;
  x: number;
  y: number;
}

interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  message: string;
}

interface PostHumanTextOptions {
  modeOverride?: HumanMode;
  interruptOverride?: boolean;
}

interface WorkletAudioMessage {
  type: "audio";
  samples: Float32Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("后端地址必须以 http:// 或 https:// 开头");
  }

  return url.toString().replace(/\/+$/, "");
}

function makeHttpUrl(baseUrl: string, path: string): string {
  return new URL(path, `${normalizeBackendUrl(baseUrl)}/`).toString();
}

function makeAsrWebSocketUrl(baseUrl: string): string {
  const url = new URL("/api/asr", `${normalizeBackendUrl(baseUrl)}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function makeChatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBackendUrl(baseUrl);
  const pathname = new URL(normalized).pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/chat/completions")) {
    return normalized;
  }

  return new URL("chat/completions", `${normalized}/`).toString();
}

function normalizeScriptModelConfig(config: ScriptModelConfig): ScriptModelConfig {
  const baseUrl = config.baseUrl.trim();
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();

  if (!baseUrl) {
    throw new Error("请填写模型 Base URL。");
  }
  if (!apiKey) {
    throw new Error("请填写 API Key。");
  }
  if (!model) {
    throw new Error("请填写模型名称。");
  }

  return {
    baseUrl: normalizeBackendUrl(baseUrl),
    apiKey,
    model,
  };
}

function isScriptModelConfig(value: unknown): value is ScriptModelConfig {
  return (
    isRecord(value) &&
    typeof value.baseUrl === "string" &&
    typeof value.apiKey === "string" &&
    typeof value.model === "string"
  );
}

function readStoredScriptModelConfig(): ScriptModelConfig | null {
  try {
    const rawConfig = window.localStorage.getItem(SCRIPT_MODEL_CONFIG_STORAGE_KEY);
    if (!rawConfig) {
      return null;
    }

    const parsed: unknown = JSON.parse(rawConfig);
    if (!isScriptModelConfig(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeStoredScriptModelConfig(config: ScriptModelConfig): void {
  window.localStorage.setItem(SCRIPT_MODEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

function readStoredScriptUserPromptTemplate(): string | null {
  try {
    const value = window.localStorage.getItem(SCRIPT_USER_PROMPT_STORAGE_KEY);
    return value?.trim() ? value : null;
  } catch {
    return null;
  }
}

function writeStoredScriptUserPromptTemplate(template: string): void {
  window.localStorage.setItem(SCRIPT_USER_PROMPT_STORAGE_KEY, template);
}

function readStoredScriptForbiddenWordsText(): string | null {
  try {
    return window.localStorage.getItem(SCRIPT_FORBIDDEN_WORDS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredScriptForbiddenWordsText(value: string): void {
  window.localStorage.setItem(SCRIPT_FORBIDDEN_WORDS_STORAGE_KEY, value);
}

function isSdpType(value: unknown): value is RTCSdpType {
  return value === "offer" || value === "pranswer" || value === "answer" || value === "rollback";
}

function isWorkletAudioMessage(value: unknown): value is WorkletAudioMessage {
  return isRecord(value) && value.type === "audio" && value.samples instanceof Float32Array;
}

function clampAudioSample(sample: number): number {
  if (sample > 1) {
    return 1;
  }
  if (sample < -1) {
    return -1;
  }
  return sample;
}

function floatToPcm16(sample: number): number {
  const clamped = clampAudioSample(sample);
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function concatFloat32(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) {
    return right;
  }

  const result = new Float32Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

function concatInt16(left: Int16Array, right: Int16Array): Int16Array {
  if (left.length === 0) {
    return right;
  }

  const result = new Int16Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseJsonText(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function makePendingScriptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 26) {
    return normalized;
  }

  return `${normalized.slice(0, 26)}...`;
}

function parseForbiddenWords(value: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];

  for (const word of value.split(/\s+/)) {
    const trimmed = word.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }

    seen.add(key);
    words.push(trimmed);
  }

  return words;
}

function normalizeForbiddenWordsText(value: string): string {
  return parseForbiddenWords(value).join(" ");
}

function findForbiddenWordsInText(text: string, forbiddenWords: string[]): string[] {
  const normalizedText = text.toLocaleLowerCase();
  return forbiddenWords.filter((word) => normalizedText.includes(word.toLocaleLowerCase()));
}

function buildForbiddenWordsInstruction(forbiddenWords: string[]): string {
  if (forbiddenWords.length === 0) {
    return "";
  }

  return `硬性限制：输出文稿中严禁出现以下违禁词：${forbiddenWords
    .map((word) => `「${word}」`)
    .join("、")}。如果需要表达相关含义，必须换一种完全不包含这些词的说法。`;
}

function createPendingScriptEntry(text: string): PendingScriptEntry {
  const now = new Date();
  return {
    id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
    text,
    preview: makePendingScriptPreview(text),
    createdAt: now.toLocaleTimeString("zh-CN", { hour12: false }),
  };
}

function readPositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const numberValue = Number(trimmed);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function readOptionalPositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? readPositiveInteger(trimmed) : null;
}

function estimateAutoQueueDelayMs(text: string): number {
  const readableLength = text.replace(/\s+/g, "").length;
  const estimatedSpeechMs = Math.max(9000, readableLength * 230);
  return Math.min(45000, Math.max(6000, Math.floor(estimatedSpeechMs * 0.58)));
}

function buildAutoRefillDescription(description: string, pendingScripts: PendingScriptEntry[]): string {
  const recentScripts = pendingScripts
    .slice(-3)
    .map((entry, index) => `上一条${index + 1}：${entry.text.slice(0, 260)}`)
    .join("\n\n");

  if (!recentScripts) {
    return description;
  }

  return [
    description,
    "",
    "下面是已经生成过或即将播报的文稿片段，请生成下一条时换一个角度，避免重复开场和卖点表达：",
    recentScripts,
  ].join("\n");
}

function findNextAutoQueueEntry(
  pendingScripts: PendingScriptEntry[],
  queuedIds: string[],
  loopEnabled: boolean,
  loopLimit: number | null,
): { entry: PendingScriptEntry; resetLoop: boolean } | null {
  if (pendingScripts.length === 0) {
    return null;
  }

  if (!loopEnabled) {
    const entry = pendingScripts.find((item) => !queuedIds.includes(item.id));
    return entry ? { entry, resetLoop: false } : null;
  }

  const loopSize = loopLimit ?? pendingScripts.length;
  if (loopSize <= 0 || pendingScripts.length === 0) {
    return null;
  }

  if (loopLimit !== null && pendingScripts.length < loopLimit) {
    const entry = pendingScripts.find((item) => !queuedIds.includes(item.id));
    return entry ? { entry, resetLoop: false } : null;
  }

  const loopEntries = pendingScripts.slice(0, loopSize);
  const entry = loopEntries.find((item) => !queuedIds.includes(item.id));
  if (entry) {
    return { entry, resetLoop: false };
  }

  return { entry: loopEntries[0], resetLoop: true };
}

function splitProductDescription(description: string): string[] {
  return description
    .split(/[\n，。；;,.、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickProductName(description: string, parts: string[]): string {
  const namedMatch = description.match(/(?:产品名|产品名称|名称|品牌|商品)[:：]\s*([^\n，。；;,.]+)/);
  const matchedName = namedMatch?.[1]?.trim();

  if (matchedName) {
    return matchedName.slice(0, 24);
  }

  return (parts[0] ?? "这款产品").replace(/^(产品|名称|品牌)[:：]/, "").trim().slice(0, 24) || "这款产品";
}

function buildLiveScript(description: string): string {
  const cleaned = description.replace(/\s+/g, " ").trim();
  const parts = splitProductDescription(description);
  const productName = pickProductName(description, parts);
  const highlights = parts
    .filter((part) => part !== productName && !part.includes("产品名") && !part.includes("产品名称"))
    .slice(0, 5);
  const fallbackHighlights = [
    "使用门槛低，上手速度快",
    "适合日常高频场景，能节省时间和精力",
    "细节做得更稳定，体验更省心",
  ];
  const selectedHighlights = highlights.length > 0 ? highlights : fallbackHighlights;
  const firstPoint = selectedHighlights[0] ?? fallbackHighlights[0];
  const secondPoint = selectedHighlights[1] ?? fallbackHighlights[1];
  const thirdPoint = selectedHighlights[2] ?? fallbackHighlights[2];
  const extraPoint = selectedHighlights[3] ? `另外，${selectedHighlights[3]}，这也是很多用户复购和推荐的原因。` : "";

  return [
    `大家好，欢迎来到直播间。今天给大家介绍的是${productName}。`,
    `如果你正在关注${cleaned}，可以先听我用一分钟把重点讲清楚。`,
    `它最值得看的第一点是${firstPoint}。这能直接解决大家在选择同类产品时最关心的效率、体验和稳定性问题。`,
    `第二点是${secondPoint}。不管是自己用，还是给团队、家人、客户使用，都能更快看到实际效果。`,
    `第三点是${thirdPoint}。这不是只看参数的产品，而是能在真实使用中持续带来价值。`,
    extraPoint,
    "如果你还在对比，可以先把你的使用场景打在评论区，我会根据你的需求帮你判断适不适合。",
    `想进一步了解${productName}的朋友，可以现在咨询，我会把核心信息和适合人群给你讲清楚。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hasProductDescriptionPlaceholder(template: string): boolean {
  return PRODUCT_DESCRIPTION_PLACEHOLDERS.some((placeholder) => template.includes(placeholder));
}

function buildUserPromptFromTemplate(template: string, description: string): string {
  let prompt = template.trim();

  for (const placeholder of PRODUCT_DESCRIPTION_PLACEHOLDERS) {
    prompt = prompt.split(placeholder).join(description);
  }

  return prompt.trim();
}

function buildScriptGenerationMessages(
  userPromptTemplate: string,
  description: string,
  forbiddenWords: string[],
  retryForbiddenWords: string[] = [],
): Array<{ role: "system" | "user"; content: string }> {
  const forbiddenWordsInstruction = buildForbiddenWordsInstruction(forbiddenWords);
  const retryInstruction =
    retryForbiddenWords.length > 0
      ? `上一版文稿命中了违禁词：${retryForbiddenWords.map((word) => `「${word}」`).join("、")}。请重新生成，不要出现这些词。`
      : "";

  return [
    {
      role: "system",
      content: [
        "你是一个直播带货文案策划智能体。只输出可以直接让数字人播报的中文口播文稿，不要解释，不要标题，不要 Markdown，不要列表编号。语气自然、有直播互动感，避免虚假承诺。",
        forbiddenWordsInstruction,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: [buildUserPromptFromTemplate(userPromptTemplate, description), retryInstruction].filter(Boolean).join("\n\n"),
    },
  ];
}

function readOpenAiErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return null;
  }

  return readString(payload.error, "message");
}

function readMessageContent(message: unknown): string | null {
  if (!isRecord(message)) {
    return null;
  }

  const stringContent = readString(message, "content");
  if (stringContent) {
    return stringContent;
  }

  const structuredContent = message.content;
  if (!Array.isArray(structuredContent)) {
    return null;
  }

  const joinedContent = structuredContent
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      return readString(part, "text") ?? "";
    })
    .join("")
    .trim();

  return joinedContent || null;
}

function readChatCompletionText(payload: unknown): string {
  const apiError = readOpenAiErrorMessage(payload);
  if (apiError) {
    throw new Error(apiError);
  }

  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("模型接口返回格式不是 chat/completions JSON。");
  }

  for (const choice of payload.choices) {
    if (!isRecord(choice)) {
      continue;
    }

    const messageContent = readMessageContent(choice.message);
    if (messageContent) {
      return messageContent;
    }

    const text = readString(choice, "text");
    if (text?.trim()) {
      return text.trim();
    }
  }

  throw new Error("模型接口没有返回可用文稿。");
}

async function generateLiveScriptWithModel(
  description: string,
  userPromptTemplate: string,
  config: ScriptModelConfig,
  forbiddenWords: string[] = [],
): Promise<string> {
  const normalizedConfig = normalizeScriptModelConfig(config);
  const normalizedForbiddenWords = parseForbiddenWords(forbiddenWords.join(" "));
  let lastForbiddenMatches: string[] = [];

  for (let attempt = 0; attempt <= MAX_FORBIDDEN_WORD_RETRIES; attempt += 1) {
    const payload = await fetchJson(makeChatCompletionsUrl(normalizedConfig.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${normalizedConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: normalizedConfig.model,
        messages: buildScriptGenerationMessages(userPromptTemplate, description, normalizedForbiddenWords, lastForbiddenMatches),
        temperature: 0.72,
        max_tokens: 900,
        stream: false,
      }),
    });

    const script = readChatCompletionText(payload);
    lastForbiddenMatches = findForbiddenWordsInText(script, normalizedForbiddenWords);
    if (lastForbiddenMatches.length === 0) {
      return script;
    }
  }

  throw new Error(`生成结果仍包含违禁词：${lastForbiddenMatches.join("、")}。请调整违禁词或提示词后重试。`);
}

function isFloatingWindowOpen(value: Window | null): value is Window {
  return Boolean(value && !value.closed);
}

function getFloatingVideoElement(popup: Window): HTMLVideoElement | null {
  const node = popup.document.getElementById("floating-video");
  if (node?.tagName === "VIDEO") {
    return node as HTMLVideoElement;
  }
  return null;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

function assertApiSuccess(payload: unknown): void {
  if (isRecord(payload)) {
    const code = readNumber(payload, "code");
    if (code !== null && code !== 0) {
      throw new Error(readString(payload, "msg") ?? `API returned code ${code}`);
    }
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  if (window.desktopApi?.requestBackend) {
    const body = typeof init?.body === "string" ? init.body : undefined;
    const response = await window.desktopApi.requestBackend({
      url,
      method: init?.method,
      headers: headersToRecord(init?.headers),
      body,
    });
    const payload = parseJsonText(response.text);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    assertApiSuccess(payload);
    return payload;
  }

  const response = await fetch(url, init);
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  assertApiSuccess(payload);
  return payload;
}

function waitForIceGatheringComplete(peerConnection: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === "complete") {
      resolve();
      return;
    }

    let timeoutId: number | undefined;
    const cleanup = (): void => {
      peerConnection.removeEventListener("icegatheringstatechange", checkState);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
    const checkState = (): void => {
      if (peerConnection.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };

    peerConnection.addEventListener("icegatheringstatechange", checkState);
    timeoutId = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 5000);
  });
}

class Pcm16Resampler {
  private pendingFloat = new Float32Array(0);
  private pendingPcm = new Int16Array(0);
  private nextSourceIndex = 0;

  constructor(
    private readonly sourceRate: number,
    private readonly targetRate: number,
    private readonly chunkSamples: number,
    private readonly onChunk: (chunk: Int16Array) => void,
  ) {}

  push(input: Float32Array): void {
    const combined = concatFloat32(this.pendingFloat, input);
    const ratio = this.sourceRate / this.targetRate;
    const output: number[] = [];
    let index = this.nextSourceIndex;

    while (index < combined.length) {
      const sampleIndex = Math.floor(index);
      output.push(floatToPcm16(combined[sampleIndex] ?? 0));
      index += ratio;
    }

    const consumed = Math.min(Math.floor(index), combined.length);
    this.pendingFloat = consumed < combined.length ? combined.slice(consumed) : new Float32Array(0);
    this.nextSourceIndex = index - consumed;

    if (output.length > 0) {
      this.pushPcm(Int16Array.from(output));
    }
  }

  flush(): void {
    if (this.pendingPcm.length > 0) {
      this.onChunk(this.pendingPcm);
      this.pendingPcm = new Int16Array(0);
    }
  }

  private pushPcm(input: Int16Array): void {
    let combined = concatInt16(this.pendingPcm, input);

    while (combined.length >= this.chunkSamples) {
      const chunk = combined.slice(0, this.chunkSamples);
      this.onChunk(chunk);
      combined = combined.slice(this.chunkSamples);
    }

    this.pendingPcm = new Int16Array(combined);
  }
}

function StatusPill({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone: StatusTone;
}): JSX.Element {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      {icon}
      {label}
    </span>
  );
}

function LogLine({ entry }: { entry: LogEntry }): JSX.Element {
  return (
    <div className={`log-line log-line--${entry.level}`}>
      <span>{entry.at}</span>
      <p>{entry.message}</p>
    </div>
  );
}

export function App(): JSX.Element {
  const [currentPage, setCurrentPage] = useState<AppPage>("control");
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [scriptModelConfig, setScriptModelConfig] = useState<ScriptModelConfig>(
    () =>
      readStoredScriptModelConfig() ?? {
        baseUrl: "",
        apiKey: "",
        model: "",
      },
  );
  const [scriptModelConfigSaved, setScriptModelConfigSaved] = useState(() => readStoredScriptModelConfig() !== null);
  const [scriptUserPromptTemplate, setScriptUserPromptTemplate] = useState(
    () => readStoredScriptUserPromptTemplate() ?? DEFAULT_SCRIPT_USER_PROMPT_TEMPLATE,
  );
  const [scriptUserPromptTemplateSaved, setScriptUserPromptTemplateSaved] = useState(true);
  const [scriptForbiddenWordsText, setScriptForbiddenWordsText] = useState(() => readStoredScriptForbiddenWordsText() ?? "");
  const [scriptForbiddenWordsSaved, setScriptForbiddenWordsSaved] = useState(true);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("unknown");
  const [rtcStatus, setRtcStatus] = useState<RtcStatus>("idle");
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");
  const [sessionId, setSessionId] = useState("");
  const [manualText, setManualText] = useState("你好，欢迎使用 LiveTalking。");
  const [productDescription, setProductDescription] = useState("");
  const [generatedScript, setGeneratedScript] = useState("");
  const [pendingScripts, setPendingScripts] = useState<PendingScriptEntry[]>([]);
  const [pendingScriptMenu, setPendingScriptMenu] = useState<PendingScriptContextMenu | null>(null);
  const [loopPlaybackEnabled, setLoopPlaybackEnabled] = useState(false);
  const [loopPlaybackLimit, setLoopPlaybackLimit] = useState("");
  const [autoRefillEnabled, setAutoRefillEnabled] = useState(false);
  const [autoRefillThreshold, setAutoRefillThreshold] = useState("2");
  const [autoQueueEnabled, setAutoQueueEnabled] = useState(false);
  const [autoQueuedScriptIds, setAutoQueuedScriptIds] = useState<string[]>([]);
  const [autoRefillBusy, setAutoRefillBusy] = useState(false);
  const [autoQueueBusy, setAutoQueueBusy] = useState(false);
  const [scriptGenerating, setScriptGenerating] = useState(false);
  const [floatingVideoActive, setFloatingVideoActive] = useState(false);
  const [humanMode, setHumanMode] = useState<HumanMode>("chat");
  const [interruptOnSend, setInterruptOnSend] = useState(true);
  const [autoSendAsr, setAutoSendAsr] = useState(true);
  const [useStun, setUseStun] = useState(false);
  const [useItn, setUseItn] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const floatingVideoWindowRef = useRef<Window | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const asrSocketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);
  const resamplerRef = useRef<Pcm16Resampler | null>(null);
  const asrTimeoutRef = useRef<number | null>(null);
  const autoQueueTimerRef = useRef<number | null>(null);
  const autoQueueBusyRef = useRef(false);
  const autoRefillBusyRef = useRef(false);
  const pendingScriptsRef = useRef(pendingScripts);
  const autoQueuedScriptIdsRef = useRef(autoQueuedScriptIds);
  const autoQueueEnabledRef = useRef(autoQueueEnabled);
  const loopPlaybackEnabledRef = useRef(loopPlaybackEnabled);
  const loopPlaybackLimitRef = useRef(loopPlaybackLimit);
  const pumpAutoQueueRef = useRef<() => Promise<void>>(async () => {});
  const sessionIdRef = useRef(sessionId);
  const humanModeRef = useRef(humanMode);
  const interruptOnSendRef = useRef(interruptOnSend);
  const autoSendAsrRef = useRef(autoSendAsr);
  const asrStatusRef = useRef<AsrStatus>(asrStatus);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    humanModeRef.current = humanMode;
  }, [humanMode]);

  useEffect(() => {
    interruptOnSendRef.current = interruptOnSend;
  }, [interruptOnSend]);

  useEffect(() => {
    autoSendAsrRef.current = autoSendAsr;
  }, [autoSendAsr]);

  useEffect(() => {
    asrStatusRef.current = asrStatus;
  }, [asrStatus]);

  useEffect(() => {
    pendingScriptsRef.current = pendingScripts;
  }, [pendingScripts]);

  useEffect(() => {
    autoQueuedScriptIdsRef.current = autoQueuedScriptIds;
  }, [autoQueuedScriptIds]);

  useEffect(() => {
    autoQueueEnabledRef.current = autoQueueEnabled;
  }, [autoQueueEnabled]);

  useEffect(() => {
    loopPlaybackEnabledRef.current = loopPlaybackEnabled;
  }, [loopPlaybackEnabled]);

  useEffect(() => {
    loopPlaybackLimitRef.current = loopPlaybackLimit;
  }, [loopPlaybackLimit]);

  const appendLog = useCallback((level: LogLevel, message: string): void => {
    const now = new Date();
    const entry: LogEntry = {
      id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
      at: now.toLocaleTimeString("zh-CN", { hour12: false }),
      level,
      message,
    };
    setLogs((current) => [entry, ...current].slice(0, 80));
  }, []);

  const desktopInfo = useMemo(() => {
    const api = window.desktopApi;
    if (!api) {
      return "Browser preview";
    }
    return `Electron ${api.versions.electron} / Chrome ${api.versions.chrome} / ${api.platform}`;
  }, []);

  const normalizedBackendUrl = useMemo(() => {
    try {
      return normalizeBackendUrl(backendUrl);
    } catch {
      return backendUrl.trim();
    }
  }, [backendUrl]);

  const stopAudioGraph = useCallback(async (): Promise<void> => {
    workletNodeRef.current?.port.close();
    workletNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    monitorGainRef.current?.disconnect();

    workletNodeRef.current = null;
    sourceNodeRef.current = null;
    monitorGainRef.current = null;
    resamplerRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    mediaStreamRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      await audioContextRef.current.close();
    }
    audioContextRef.current = null;
  }, []);

  const closeAsrSocket = useCallback((): void => {
    if (asrTimeoutRef.current !== null) {
      window.clearTimeout(asrTimeoutRef.current);
      asrTimeoutRef.current = null;
    }

    const socket = asrSocketRef.current;
    asrSocketRef.current = null;

    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
  }, []);

  const postHumanText = useCallback(
    async (text: string, source: HumanTextSource, options: PostHumanTextOptions = {}): Promise<boolean> => {
      const trimmedText = text.trim();
      const activeSessionId = sessionIdRef.current;

      if (!trimmedText) {
        appendLog("warn", "发送文本为空，已跳过。");
        return false;
      }
      if (!activeSessionId) {
        appendLog("warn", "没有 WebRTC sessionid，先连接数字人再发送文本。");
        return false;
      }

      const payload = {
        sessionid: activeSessionId,
        text: trimmedText,
        type: options.modeOverride ?? humanModeRef.current,
        interrupt: options.interruptOverride ?? interruptOnSendRef.current,
      };
      const sourceLabel =
        source === "asr" ? "语音识别文本" : source === "script" ? "直播文稿" : "手动文本";

      try {
        await fetchJson(makeHttpUrl(backendUrl, "/human"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        appendLog("success", `${sourceLabel}已发送给数字人。`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("error", `数字人播报失败：${message}`);
        return false;
      }
    },
    [appendLog, backendUrl],
  );

  const clearAutoQueueTimer = useCallback((): void => {
    if (autoQueueTimerRef.current !== null) {
      window.clearTimeout(autoQueueTimerRef.current);
      autoQueueTimerRef.current = null;
    }
  }, []);

  const scheduleAutoQueuePump = useCallback(
    (delayMs = 0): void => {
      if (!autoQueueEnabledRef.current || autoQueueTimerRef.current !== null) {
        return;
      }

      autoQueueTimerRef.current = window.setTimeout(() => {
        autoQueueTimerRef.current = null;
        void pumpAutoQueueRef.current();
      }, delayMs);
    },
    [],
  );

  const pumpAutoQueue = useCallback(async (): Promise<void> => {
    if (!autoQueueEnabledRef.current || autoQueueBusyRef.current) {
      return;
    }

    if (!sessionIdRef.current) {
      appendLog("warn", "自动队列播稿已开启，请先连接数字人。");
      return;
    }

    const queuedIds = autoQueuedScriptIdsRef.current.filter((id) =>
      pendingScriptsRef.current.some((entry) => entry.id === id),
    );
    const loopLimit = readOptionalPositiveInteger(loopPlaybackLimitRef.current);
    const next = findNextAutoQueueEntry(
      pendingScriptsRef.current,
      queuedIds,
      loopPlaybackEnabledRef.current,
      loopLimit,
    );

    if (!next) {
      return;
    }

    autoQueueBusyRef.current = true;
    setAutoQueueBusy(true);

    try {
      const sent = await postHumanText(next.entry.text, "script", {
        modeOverride: "echo",
        interruptOverride: false,
      });

      if (!sent) {
        setAutoQueueEnabled(false);
        appendLog("warn", "自动队列播稿已暂停，请检查数字人连接。");
        return;
      }

      setAutoQueuedScriptIds((current) => {
        const cleanCurrent = current.filter((id) => pendingScriptsRef.current.some((entry) => entry.id === id));
        const base = next.resetLoop ? [] : cleanCurrent;
        return base.includes(next.entry.id) ? base : [...base, next.entry.id];
      });
      appendLog("success", `已自动加入后端播报队列：${next.entry.preview}`);
      scheduleAutoQueuePump(estimateAutoQueueDelayMs(next.entry.text));
    } finally {
      autoQueueBusyRef.current = false;
      setAutoQueueBusy(false);
    }
  }, [appendLog, postHumanText, scheduleAutoQueuePump]);

  useEffect(() => {
    pumpAutoQueueRef.current = pumpAutoQueue;
  }, [pumpAutoQueue]);

  const writeFloatingWindowDocument = useCallback((popup: Window): void => {
    popup.document.open();
    popup.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>LiveTalking Floating Video</title>
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #000;
        cursor: none !important;
        user-select: none;
      }

      body * {
        pointer-events: none;
        cursor: none !important;
        user-select: none;
      }

      video {
        display: block;
        width: 100vw;
        height: 100vh;
        object-fit: cover;
        background: #000;
      }
    </style>
  </head>
  <body>
    <video id="floating-video" autoplay playsinline muted></video>
    <script>
      document.addEventListener("contextmenu", function (event) {
        event.preventDefault();
      });
      document.addEventListener("keydown", function (event) {
        event.preventDefault();
      });
      document.addEventListener("mousemove", function () {
        document.body.style.cursor = "none";
      });
    </script>
  </body>
</html>`);
    popup.document.close();
  }, []);

  const syncFloatingVideoWindow = useCallback(
    (stream: MediaStream): void => {
      const popup = floatingVideoWindowRef.current;

      if (!isFloatingWindowOpen(popup)) {
        return;
      }

      const node = getFloatingVideoElement(popup);
      if (!node) {
        appendLog("warn", "浮窗播放器未准备好。");
        return;
      }

      if (node.srcObject !== stream) {
        node.srcObject = stream;
      }
      node.muted = true;
      node.controls = false;
      void node.play().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("warn", `浮窗视频播放失败：${message}`);
      });
    },
    [appendLog],
  );

  const playMediaElement = useCallback(
    (element: HTMLMediaElement | null, label: string): void => {
      if (!element) {
        return;
      }

      void element.play().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("warn", `${label}播放未自动启动：${message}`);
      });
    },
    [appendLog],
  );

  const attachRemoteMediaStreams = useCallback((): void => {
    const videoStream = remoteVideoStreamRef.current;
    if (videoStream && videoRef.current) {
      if (videoRef.current.srcObject !== videoStream) {
        videoRef.current.srcObject = videoStream;
      }
      playMediaElement(videoRef.current, "数字人画面");
      syncFloatingVideoWindow(videoStream);
    }

    const audioStream = remoteAudioStreamRef.current;
    if (audioStream && audioRef.current) {
      if (audioRef.current.srcObject !== audioStream) {
        audioRef.current.srcObject = audioStream;
      }
      playMediaElement(audioRef.current, "数字人声音");
    }
  }, [playMediaElement, syncFloatingVideoWindow]);

  const closeFloatingVideoWindow = useCallback((shouldLog = true): void => {
    const popup = floatingVideoWindowRef.current;
    floatingVideoWindowRef.current = null;

    if (isFloatingWindowOpen(popup)) {
      const node = getFloatingVideoElement(popup);
      if (node) {
        node.pause();
        node.srcObject = null;
      }
      popup.close();
    }

    setFloatingVideoActive(false);
    if (shouldLog) {
      appendLog("info", "数字人浮窗已关闭。");
    }
  }, [appendLog]);

  const stopRtc = useCallback((): void => {
    closeFloatingVideoWindow(false);

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    remoteVideoStreamRef.current = null;
    remoteAudioStreamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }

    setSessionId("");
    setRtcStatus("idle");
    appendLog("info", "WebRTC 已断开。");
  }, [appendLog, closeFloatingVideoWindow]);

  const toggleFloatingVideo = useCallback(async (): Promise<void> => {
    const video = videoRef.current;

    try {
      if (isFloatingWindowOpen(floatingVideoWindowRef.current)) {
        closeFloatingVideoWindow();
        return;
      }

      const stream = video?.srcObject;
      if (!(stream instanceof MediaStream)) {
        appendLog("warn", "请先连接数字人，再打开浮窗播放。");
        return;
      }

      const popup = window.open(
        "",
        FLOATING_VIDEO_WINDOW_NAME,
        "width=405,height=720,resizable=yes,menubar=no,toolbar=no,location=no,status=no",
      );

      if (!popup) {
        appendLog("error", "浮窗创建失败，请检查系统是否阻止弹窗。");
        return;
      }

      floatingVideoWindowRef.current = popup;
      writeFloatingWindowDocument(popup);
      popup.addEventListener("beforeunload", () => {
        floatingVideoWindowRef.current = null;
        setFloatingVideoActive(false);
      });
      syncFloatingVideoWindow(stream);
      window.focus();
      setFloatingVideoActive(true);
      appendLog("success", "数字人无控件浮窗已打开。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("error", `浮窗播放失败：${message}`);
    }
  }, [appendLog, closeFloatingVideoWindow, syncFloatingVideoWindow, writeFloatingWindowDocument]);

  const checkBackend = useCallback(async (): Promise<void> => {
    setBackendStatus("checking");
    try {
      const normalized = normalizeBackendUrl(backendUrl);
      setBackendUrl(normalized);
      await fetchJson(makeHttpUrl(normalized, "/api/admin/config"));
      setBackendStatus("online");
      appendLog("success", `后端可访问：${normalized}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBackendStatus("offline");
      appendLog("error", `后端检查失败：${message}`);
    }
  }, [appendLog, backendUrl]);

  const connectRtc = useCallback(async (): Promise<void> => {
    if (rtcStatus === "connecting") {
      return;
    }

    stopRtc();
    setRtcStatus("connecting");

    try {
      const normalized = normalizeBackendUrl(backendUrl);
      setBackendUrl(normalized);

      const config: RTCConfiguration = useStun
        ? {
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
          }
        : {};
      const peerConnection = new RTCPeerConnection(config);
      peerConnectionRef.current = peerConnection;

      peerConnection.addEventListener("track", (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (event.track.kind === "video") {
          remoteVideoStreamRef.current = stream;
          attachRemoteMediaStreams();
        }
        if (event.track.kind === "audio") {
          remoteAudioStreamRef.current = stream;
          attachRemoteMediaStreams();
        }
      });

      peerConnection.addEventListener("connectionstatechange", () => {
        if (peerConnection.connectionState === "connected") {
          setRtcStatus("connected");
          appendLog("success", "WebRTC 媒体连接已建立。");
        }
        if (peerConnection.connectionState === "failed") {
          setRtcStatus("error");
          appendLog("error", "WebRTC 连接失败。");
        }
        if (peerConnection.connectionState === "disconnected") {
          setRtcStatus("idle");
          appendLog("warn", "WebRTC 连接已断开。");
        }
      });

      peerConnection.addTransceiver("video", { direction: "recvonly" });
      peerConnection.addTransceiver("audio", { direction: "recvonly" });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIceGatheringComplete(peerConnection);

      if (!peerConnection.localDescription) {
        throw new Error("浏览器没有生成 localDescription");
      }

      const payload = await fetchJson(makeHttpUrl(normalized, "/offer"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sdp: peerConnection.localDescription.sdp,
          type: peerConnection.localDescription.type,
        }),
      });

      if (!isRecord(payload)) {
        throw new Error("/offer 返回格式不是 JSON 对象");
      }

      const sdp = readString(payload, "sdp");
      const answerTypeRaw = payload.type;
      const answerType: RTCSdpType = isSdpType(answerTypeRaw) ? answerTypeRaw : "answer";
      const nextSessionId = readString(payload, "sessionid");

      if (!sdp) {
        throw new Error("/offer 返回中没有 SDP");
      }

      await peerConnection.setRemoteDescription({ type: answerType, sdp });
      setSessionId(nextSessionId ?? "");
      setRtcStatus("connected");
      appendLog("success", `WebRTC offer 已交换，sessionid=${nextSessionId ?? "-"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      setRtcStatus("error");
      setSessionId("");
      appendLog("error", `WebRTC 连接失败：${message}`);
    }
  }, [appendLog, attachRemoteMediaStreams, backendUrl, rtcStatus, stopRtc, useStun]);

  const handleAsrResult = useCallback(
    async (text: string): Promise<void> => {
      const cleaned = text.replace(/ +/g, "").trim();
      if (!cleaned) {
        appendLog("warn", "ASR 返回空文本。");
        return;
      }

      setTranscript((current) => `${cleaned}\n${current}`.trim());
      appendLog("success", `ASR 识别完成：${cleaned}`);

      if (autoSendAsrRef.current) {
        await postHumanText(cleaned, "asr");
      }
    },
    [appendLog, postHumanText],
  );

  const startAudioCapture = useCallback(
    async (socket: WebSocket): Promise<void> => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule(new URL("./asr-worklet.js", window.location.href).toString());

      const sourceNode = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "livetalking-asr-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const monitorGain = audioContext.createGain();
      monitorGain.gain.value = 0;

      const resampler = new Pcm16Resampler(
        audioContext.sampleRate,
        ASR_TARGET_SAMPLE_RATE,
        ASR_CHUNK_SAMPLES,
        (chunk) => {
          if (socket.readyState === WebSocket.OPEN) {
            const payload = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            socket.send(payload);
          }
        },
      );

      workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        if (isWorkletAudioMessage(event.data)) {
          resampler.push(event.data.samples);
        }
      };

      sourceNode.connect(workletNode);
      workletNode.connect(monitorGain);
      monitorGain.connect(audioContext.destination);

      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceNodeRef.current = sourceNode;
      workletNodeRef.current = workletNode;
      monitorGainRef.current = monitorGain;
      resamplerRef.current = resampler;

      setAsrStatus("recording");
      appendLog("success", `麦克风已开始采集，输入采样率 ${audioContext.sampleRate}Hz，输出 16k PCM16。`);
    },
    [appendLog],
  );

  const startAsr = useCallback(async (): Promise<void> => {
    if (asrStatus === "connecting" || asrStatus === "recording" || asrStatus === "recognizing") {
      return;
    }

    if (!sessionIdRef.current) {
      appendLog("warn", "建议先连接 WebRTC，ASR 结果需要 sessionid 才能驱动数字人。");
    }

    setAsrStatus("connecting");

    try {
      const normalized = normalizeBackendUrl(backendUrl);
      setBackendUrl(normalized);
      const socket = new WebSocket(makeAsrWebSocketUrl(normalized));
      socket.binaryType = "arraybuffer";
      asrSocketRef.current = socket;

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            chunk_size: [5, 10, 5],
            wav_name: "h5",
            is_speaking: true,
            chunk_interval: 10,
            itn: useItn,
            mode: "2pass",
          }),
        );
        appendLog("success", "ASR WebSocket 已连接。");
        void startAudioCapture(socket).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setAsrStatus("error");
          appendLog("error", `麦克风启动失败：${message}`);
          socket.close();
        });
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const payload: unknown = JSON.parse(event.data);
          if (!isRecord(payload)) {
            return;
          }
          const text = readString(payload, "text") ?? "";
          const isFinal = payload.is_final === true;
          if (isFinal) {
            void handleAsrResult(text);
            closeAsrSocket();
            void stopAudioGraph();
            setAsrStatus("idle");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendLog("error", `ASR 消息解析失败：${message}`);
        }
      };

      socket.onerror = () => {
        setAsrStatus("error");
        appendLog("error", "ASR WebSocket 连接错误。");
      };

      socket.onclose = () => {
        if (asrStatusRef.current !== "idle" && asrStatusRef.current !== "error") {
          setAsrStatus("idle");
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAsrStatus("error");
      appendLog("error", `ASR 启动失败：${message}`);
    }
  }, [appendLog, asrStatus, backendUrl, closeAsrSocket, handleAsrResult, startAudioCapture, stopAudioGraph, useItn]);

  const finishAsrRecording = useCallback(async (): Promise<void> => {
    if (asrStatus === "recognizing") {
      closeAsrSocket();
      await stopAudioGraph();
      setAsrStatus("idle");
      appendLog("warn", "ASR 等待已取消。");
      return;
    }

    if (asrStatus !== "recording" && asrStatus !== "connecting") {
      return;
    }

    const socket = asrSocketRef.current;
    resamplerRef.current?.flush();
    await stopAudioGraph();

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          chunk_size: [5, 10, 5],
          wav_name: "h5",
          is_speaking: false,
          chunk_interval: 10,
          mode: "2pass",
        }),
      );
      setAsrStatus("recognizing");
      appendLog("info", "音频已发送，等待 ASR 最终结果。");
      asrTimeoutRef.current = window.setTimeout(() => {
        closeAsrSocket();
        setAsrStatus("error");
        appendLog("error", "ASR 等待超时。");
      }, 20000);
    } else {
      closeAsrSocket();
      setAsrStatus("idle");
      appendLog("warn", "ASR WebSocket 未连接，录音已停止。");
    }
  }, [appendLog, asrStatus, closeAsrSocket, stopAudioGraph]);

  const sendManualText = useCallback(async (): Promise<void> => {
    const sent = await postHumanText(manualText, "manual");
    if (sent) {
      setManualText("");
    }
  }, [manualText, postHumanText]);

  const updateScriptModelConfig = useCallback((field: keyof ScriptModelConfig, value: string): void => {
    setScriptModelConfig((current) => ({
      ...current,
      [field]: value,
    }));
    setScriptModelConfigSaved(false);
  }, []);

  const saveScriptModelSettings = useCallback((): void => {
    try {
      const normalizedConfig = normalizeScriptModelConfig(scriptModelConfig);
      writeStoredScriptModelConfig(normalizedConfig);
      setScriptModelConfig(normalizedConfig);
      setScriptModelConfigSaved(true);
      appendLog("success", "大模型配置已保存到本机。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("error", `模型配置保存失败：${message}`);
    }
  }, [appendLog, scriptModelConfig]);

  const updateScriptUserPromptTemplate = useCallback((value: string): void => {
    setScriptUserPromptTemplate(value);
    setScriptUserPromptTemplateSaved(false);
  }, []);

  const restoreDefaultScriptUserPromptTemplate = useCallback((): void => {
    setScriptUserPromptTemplate(DEFAULT_SCRIPT_USER_PROMPT_TEMPLATE);
    setScriptUserPromptTemplateSaved(false);
    appendLog("info", "User Prompt 模板已恢复默认，保存后下次打开生效。");
  }, [appendLog]);

  const saveScriptUserPromptTemplate = useCallback((): void => {
    const template = scriptUserPromptTemplate.trim();
    if (!template) {
      appendLog("warn", "User Prompt 模板为空，未保存。");
      return;
    }

    writeStoredScriptUserPromptTemplate(template);
    setScriptUserPromptTemplate(template);
    setScriptUserPromptTemplateSaved(true);
    appendLog("success", "User Prompt 模板已保存到本机。");
  }, [appendLog, scriptUserPromptTemplate]);

  const updateScriptForbiddenWordsText = useCallback((value: string): void => {
    setScriptForbiddenWordsText(value);
    setScriptForbiddenWordsSaved(false);
  }, []);

  const saveScriptForbiddenWordsText = useCallback((): void => {
    const normalizedWords = normalizeForbiddenWordsText(scriptForbiddenWordsText);
    writeStoredScriptForbiddenWordsText(normalizedWords);
    setScriptForbiddenWordsText(normalizedWords);
    setScriptForbiddenWordsSaved(true);
    appendLog("success", normalizedWords ? "违禁词列表已保存到本机。" : "违禁词列表已清空并保存。");
  }, [appendLog, scriptForbiddenWordsText]);

  const generateScript = useCallback(async (): Promise<void> => {
    const description = productDescription.trim();
    const userPromptTemplate = scriptUserPromptTemplate.trim();
    const forbiddenWords = parseForbiddenWords(scriptForbiddenWordsText);

    if (!userPromptTemplate) {
      appendLog("warn", "请先填写 User Prompt 模板。");
      return;
    }

    if (hasProductDescriptionPlaceholder(userPromptTemplate) && !description) {
      appendLog("warn", "请先输入产品描述。");
      return;
    }

    setScriptGenerating(true);
    try {
      const script = await generateLiveScriptWithModel(description, userPromptTemplate, scriptModelConfig, forbiddenWords);
      setGeneratedScript(script);
      appendLog("success", forbiddenWords.length > 0 ? "大模型直播文稿已生成，并通过违禁词检查。" : "大模型直播文稿已生成。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("error", `大模型生成失败：${message}`);
    } finally {
      setScriptGenerating(false);
    }
  }, [appendLog, productDescription, scriptForbiddenWordsText, scriptModelConfig, scriptUserPromptTemplate]);

  const autoGeneratePendingScript = useCallback(async (): Promise<void> => {
    if (autoRefillBusyRef.current) {
      return;
    }

    const loopLimit = loopPlaybackEnabled ? readOptionalPositiveInteger(loopPlaybackLimit) : null;
    if (loopLimit !== null && pendingScriptsRef.current.length >= loopLimit) {
      return;
    }

    const userPromptTemplate = scriptUserPromptTemplate.trim();
    if (!userPromptTemplate) {
      setAutoRefillEnabled(false);
      appendLog("warn", "自动补生成已暂停：请先填写 User Prompt 模板。");
      return;
    }

    const description = productDescription.trim();
    const forbiddenWords = parseForbiddenWords(scriptForbiddenWordsText);
    if (hasProductDescriptionPlaceholder(userPromptTemplate) && !description) {
      setAutoRefillEnabled(false);
      appendLog("warn", "自动补生成已暂停：请先输入产品描述。");
      return;
    }

    autoRefillBusyRef.current = true;
    setAutoRefillBusy(true);

    try {
      const autoDescription = buildAutoRefillDescription(description, pendingScriptsRef.current);
      const script = await generateLiveScriptWithModel(autoDescription, userPromptTemplate, scriptModelConfig, forbiddenWords);
      const entry = createPendingScriptEntry(script.trim());

      setPendingScripts((current) => {
        const activeLoopLimit = loopPlaybackEnabled ? readOptionalPositiveInteger(loopPlaybackLimit) : null;
        if (activeLoopLimit !== null && current.length >= activeLoopLimit) {
          return current;
        }

        return [...current, entry].slice(0, MAX_PENDING_SCRIPTS);
      });
      appendLog("success", "已自动补生成 1 条待播稿。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAutoRefillEnabled(false);
      appendLog("error", `自动补生成失败，已暂停：${message}`);
    } finally {
      autoRefillBusyRef.current = false;
      setAutoRefillBusy(false);
    }
  }, [
    appendLog,
    loopPlaybackEnabled,
    loopPlaybackLimit,
    productDescription,
    scriptForbiddenWordsText,
    scriptModelConfig,
    scriptUserPromptTemplate,
  ]);

  const sendGeneratedScript = useCallback(async (): Promise<void> => {
    const sent = await postHumanText(generatedScript, "script", { modeOverride: "echo" });
    if (sent) {
      setCurrentPage("control");
    }
  }, [generatedScript, postHumanText]);

  const addGeneratedScriptToPendingList = useCallback((): void => {
    const text = generatedScript.trim();
    if (!text) {
      appendLog("warn", "没有可添加的直播文稿。");
      return;
    }

    const loopLimit = loopPlaybackEnabled ? readOptionalPositiveInteger(loopPlaybackLimit) : null;
    if (loopPlaybackEnabled && loopPlaybackLimit.trim() && loopLimit === null) {
      appendLog("warn", "循环条数必须是大于 0 的整数，或留空。");
      return;
    }

    if (loopLimit !== null && pendingScripts.length >= loopLimit) {
      appendLog("warn", `已达到循环上限 ${loopLimit} 条，未继续添加。`);
      return;
    }

    const entry = createPendingScriptEntry(text);

    setPendingScripts((current) => [entry, ...current].slice(0, MAX_PENDING_SCRIPTS));
    appendLog("success", "已添加到待播稿列表。");
  }, [appendLog, generatedScript, loopPlaybackEnabled, loopPlaybackLimit, pendingScripts.length]);

  const loadPendingScript = useCallback(
    (entry: PendingScriptEntry): void => {
      setGeneratedScript(entry.text);
      appendLog("info", "待播稿已载入生成结果。");
    },
    [appendLog],
  );

  const openPendingScriptMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>, entry: PendingScriptEntry): void => {
    event.preventDefault();

    const menuWidth = 132;
    const menuHeight = 48;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));

    setPendingScriptMenu({ entryId: entry.id, x, y });
  }, []);

  const deletePendingScript = useCallback(
    (entryId: string): void => {
      setPendingScripts((current) => current.filter((entry) => entry.id !== entryId));
      setAutoQueuedScriptIds((current) => current.filter((id) => id !== entryId));
      setPendingScriptMenu(null);
      appendLog("info", "待播稿已删除。");
    },
    [appendLog],
  );

  useEffect(() => {
    if (!pendingScriptMenu) {
      return;
    }

    const closeMenu = (): void => {
      setPendingScriptMenu(null);
    };

    const closeMenuOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [pendingScriptMenu]);

  useEffect(() => {
    setAutoQueuedScriptIds((current) => current.filter((id) => pendingScripts.some((entry) => entry.id === id)));
  }, [pendingScripts]);

  useEffect(() => {
    if (!autoQueueEnabled) {
      clearAutoQueueTimer();
      return;
    }

    if (!sessionId) {
      appendLog("warn", "自动队列播稿已开启，连接数字人后会开始投喂。");
      return;
    }

    scheduleAutoQueuePump(0);
  }, [
    appendLog,
    autoQueueEnabled,
    autoQueuedScriptIds,
    clearAutoQueueTimer,
    loopPlaybackEnabled,
    loopPlaybackLimit,
    pendingScripts,
    scheduleAutoQueuePump,
    sessionId,
  ]);

  useEffect(() => {
    if (!autoRefillEnabled || autoRefillBusy) {
      return;
    }

    const threshold = readPositiveInteger(autoRefillThreshold);
    if (threshold === null) {
      return;
    }

    const loopLimit = loopPlaybackEnabled ? readOptionalPositiveInteger(loopPlaybackLimit) : null;
    if (loopLimit !== null && pendingScripts.length >= loopLimit) {
      return;
    }

    const remainingUnqueued = pendingScripts.filter((entry) => !autoQueuedScriptIds.includes(entry.id)).length;
    if (remainingUnqueued < threshold) {
      void autoGeneratePendingScript();
    }
  }, [
    autoGeneratePendingScript,
    autoQueuedScriptIds,
    autoRefillBusy,
    autoRefillEnabled,
    autoRefillThreshold,
    loopPlaybackEnabled,
    loopPlaybackLimit,
    pendingScripts,
  ]);

  const useGeneratedScriptInConsole = useCallback((): void => {
    const trimmedScript = generatedScript.trim();
    if (!trimmedScript) {
      appendLog("warn", "没有可使用的直播文稿。");
      return;
    }

    setManualText(trimmedScript);
    setCurrentPage("control");
    appendLog("info", "直播文稿已放入对话控制输入框。");
  }, [appendLog, generatedScript]);

  const handleBackendBlur = useCallback((): void => {
    try {
      setBackendUrl(normalizeBackendUrl(backendUrl));
    } catch {
      appendLog("warn", "后端地址格式暂未通过校验。");
    }
  }, [appendLog, backendUrl]);

  useEffect(() => {
    appendLog("info", "桌面客户端已加载。先启动 Python 后端，再检查后端或连接 WebRTC。");

    return () => {
      clearAutoQueueTimer();
      closeFloatingVideoWindow(false);
      peerConnectionRef.current?.close();
      closeAsrSocket();
      void stopAudioGraph();
    };
  }, [appendLog, clearAutoQueueTimer, closeAsrSocket, closeFloatingVideoWindow, stopAudioGraph]);

  useEffect(() => {
    attachRemoteMediaStreams();
  }, [attachRemoteMediaStreams, currentPage]);

  const backendTone: StatusTone =
    backendStatus === "online"
      ? "success"
      : backendStatus === "offline"
        ? "error"
        : backendStatus === "checking"
          ? "pending"
          : "idle";
  const rtcTone: StatusTone =
    rtcStatus === "connected" ? "success" : rtcStatus === "connecting" ? "pending" : rtcStatus === "error" ? "error" : "idle";
  const asrTone: StatusTone =
    asrStatus === "recording"
      ? "active"
      : asrStatus === "connecting" || asrStatus === "recognizing"
        ? "pending"
        : asrStatus === "error"
          ? "error"
          : "idle";
  const canSendText = Boolean(sessionId && manualText.trim());
  const userPromptNeedsProductDescription = hasProductDescriptionPlaceholder(scriptUserPromptTemplate);
  const canGenerateScript =
    Boolean(scriptUserPromptTemplate.trim()) &&
    (!userPromptNeedsProductDescription || Boolean(productDescription.trim())) &&
    !scriptGenerating;
  const canSendGeneratedScript = Boolean(sessionId && generatedScript.trim());
  const loopPlaybackLimitNumber = readOptionalPositiveInteger(loopPlaybackLimit);
  const loopPlaybackLimitInvalid =
    loopPlaybackEnabled && Boolean(loopPlaybackLimit.trim()) && loopPlaybackLimitNumber === null;
  const autoRefillThresholdNumber = readPositiveInteger(autoRefillThreshold);
  const autoRefillThresholdInvalid = autoRefillEnabled && autoRefillThresholdNumber === null;
  const pendingUnqueuedCount = pendingScripts.filter((entry) => !autoQueuedScriptIds.includes(entry.id)).length;
  const loopCapReached =
    loopPlaybackEnabled && loopPlaybackLimitNumber !== null && pendingScripts.length >= loopPlaybackLimitNumber;
  const canStartAsr = asrStatus === "idle" || asrStatus === "error";
  const canStopAsr = asrStatus === "connecting" || asrStatus === "recording" || asrStatus === "recognizing";
  const canToggleFloatingVideo = floatingVideoActive || Boolean(sessionId);
  const backendLabel =
    backendStatus === "online"
      ? "服务正常"
      : backendStatus === "checking"
        ? "服务检查中"
        : backendStatus === "offline"
          ? "服务异常"
          : "服务未检查";
  const rtcLabel =
    rtcStatus === "connected"
      ? "数字人已连接"
      : rtcStatus === "connecting"
        ? "数字人连接中"
        : rtcStatus === "error"
          ? "数字人连接失败"
          : "数字人未连接";
  const asrLabel =
    asrStatus === "recording"
      ? "正在听你说话"
      : asrStatus === "recognizing"
        ? "正在识别"
        : asrStatus === "connecting"
          ? "麦克风启动中"
          : asrStatus === "error"
            ? "麦克风异常"
            : "麦克风关闭";
  const hasError = backendStatus === "offline" || rtcStatus === "error" || asrStatus === "error";
  const latestEvent = logs[0]?.message ?? "桌面端已就绪";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>LiveTalking Desktop</h1>
          <p>连接数字人后，可以输入文字或直接说话驱动回应。</p>
        </div>
        <div className="topbar-actions">
          <div className="page-tabs" aria-label="页面切换">
            <button
              className={currentPage === "control" ? "selected" : ""}
              type="button"
              onClick={() => setCurrentPage("control")}
            >
              <Video size={15} />
              控制台
            </button>
            <button
              className={currentPage === "script" ? "selected" : ""}
              type="button"
              onClick={() => setCurrentPage("script")}
            >
              <FileText size={15} />
              文案生成
            </button>
          </div>
          <StatusPill icon={<CheckCircle2 size={14} />} label={backendLabel} tone={backendTone} />
          <StatusPill icon={<Video size={14} />} label={rtcLabel} tone={rtcTone} />
          <StatusPill icon={<Mic size={14} />} label={asrLabel} tone={asrTone} />
          <button className="icon-button" type="button" title="检查服务" onClick={() => void checkBackend()}>
            {backendStatus === "checking" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
        </div>
      </header>

      <details className="connection-strip settings-panel">
        <summary>
          <Settings2 size={16} />
          连接设置
        </summary>
        <label className="backend-field">
          <span>服务地址</span>
          <input
            value={backendUrl}
            onBlur={handleBackendBlur}
            onChange={(event) => setBackendUrl(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button className="icon-button" type="button" title="检查服务" onClick={() => void checkBackend()}>
          {backendStatus === "checking" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
        </button>
        <span className="runtime">{desktopInfo}</span>
      </details>

      <audio ref={audioRef} className="remote-audio" autoPlay />

      {currentPage === "control" ? (
        <section className="workspace">
          <div className="video-panel">
          <div className="panel-head">
            <div>
              <h2>数字人画面</h2>
              <p>连接后这里会显示实时画面和声音。</p>
            </div>
            <div className="panel-actions">
              <label className="check-row">
                <input type="checkbox" checked={useStun} onChange={(event) => setUseStun(event.target.checked)} />
                <span>使用公网辅助连接</span>
              </label>
              <button
                className={`ghost-button floating-video-button ${floatingVideoActive ? "floating-video-button--active" : ""}`}
                type="button"
                disabled={!canToggleFloatingVideo}
                title={floatingVideoActive ? "从主页面关闭数字人浮窗" : "打开无控件数字人浮窗"}
                onClick={() => void toggleFloatingVideo()}
              >
                <PictureInPicture size={17} />
                {floatingVideoActive ? "关闭浮窗" : "浮窗播放"}
              </button>
              {rtcStatus === "connected" || rtcStatus === "connecting" ? (
                <button className="danger-button" type="button" onClick={stopRtc}>
                  <CircleStop size={17} />
                  断开
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={() => void connectRtc()}>
                  <Play size={17} />
                  连接数字人
                </button>
              )}
            </div>
          </div>

          <div className="video-frame">
            <video ref={videoRef} autoPlay playsInline muted controls />
            {!sessionId && (
              <div className="video-empty">
                <Video size={32} />
                <span>等待连接数字人</span>
              </div>
            )}
          </div>

          <div className="session-row">
            <span>会话详情</span>
            <code>{sessionId || "-"}</code>
          </div>
        </div>

        <div className="control-panel">
          <div className="panel-head compact">
            <div>
              <h2>对话控制</h2>
              <p>选择回复方式，然后发送内容给数字人。</p>
            </div>
            <div className="panel-tools">
              <button className="ghost-button" type="button" onClick={() => setCurrentPage("script")}>
                <FileText size={15} />
                文案生成
              </button>
              <Settings2 size={18} />
            </div>
          </div>

          <div className="segmented">
            <button className={humanMode === "chat" ? "selected" : ""} type="button" onClick={() => setHumanMode("chat")}>
              <Bot size={15} />
              智能回复
            </button>
            <button className={humanMode === "echo" ? "selected" : ""} type="button" onClick={() => setHumanMode("echo")}>
              <Activity size={15} />
              直接复述
            </button>
          </div>

          <label className="text-area-label">
            <span>输入内容</span>
            <textarea
              rows={4}
              value={manualText}
              onChange={(event) => setManualText(event.target.value)}
              placeholder="输入要让数字人说的话"
            />
          </label>

          <div className="form-row">
            <label className="check-row">
              <input
                type="checkbox"
                checked={interruptOnSend}
                onChange={(event) => setInterruptOnSend(event.target.checked)}
              />
              <span>发送时打断当前播报</span>
            </label>
            <button className="primary-button" type="button" disabled={!canSendText} onClick={() => void sendManualText()}>
              <Send size={16} />
              发送
            </button>
          </div>

          <div className="divider" />

          <div className="asr-toolbar">
            <div>
              <h2>语音输入</h2>
              <p>{asrLabel}</p>
            </div>
            {canStartAsr && (
              <button className="primary-button" type="button" onClick={() => void startAsr()}>
                <Mic size={16} />
                开始说话
              </button>
            )}
            {canStopAsr && (
              <button className="danger-button" type="button" onClick={() => void finishAsrRecording()}>
                {asrStatus === "recognizing" ? <Square size={16} /> : <MicOff size={16} />}
                {asrStatus === "recognizing" ? "取消等待" : "停止识别"}
              </button>
            )}
          </div>

          <div className="form-row">
            <label className="check-row">
              <input type="checkbox" checked={autoSendAsr} onChange={(event) => setAutoSendAsr(event.target.checked)} />
              <span>识别后自动让数字人回应</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={useItn} onChange={(event) => setUseItn(event.target.checked)} />
              <span>智能整理文本</span>
            </label>
          </div>

          <div className="transcript-box">
            <div className="transcript-head">
              <span>识别结果</span>
              {transcript ? <CheckCircle2 size={15} /> : <WifiOff size={15} />}
            </div>
            <pre>{transcript || "说话后会显示识别文本"}</pre>
          </div>
        </div>
        </section>
      ) : (
        <section className="script-workspace">
          <div className="script-panel script-input-panel">
            <div className="panel-head">
              <div>
                <h2>智能体直播文稿</h2>
                <p>配置 OpenAI 兼容模型后，输入产品信息生成直播话术。</p>
              </div>
              <button className="ghost-button" type="button" onClick={() => setCurrentPage("control")}>
                <ArrowLeft size={16} />
                返回控制台
              </button>
            </div>

            <div className="model-config-card">
              <div className="model-config-head">
                <div>
                  <strong>大模型 API</strong>
                  <span>{scriptModelConfigSaved ? "已保存，本机自动读取" : "未保存"}</span>
                </div>
                <button className="ghost-button" type="button" onClick={saveScriptModelSettings}>
                  {scriptModelConfigSaved ? <CheckCircle2 size={16} /> : <Settings2 size={16} />}
                  确定保存
                </button>
              </div>

              <div className="model-config-grid">
                <label className="model-field model-field--wide">
                  <span>Base URL</span>
                  <input
                    type="url"
                    value={scriptModelConfig.baseUrl}
                    onChange={(event) => updateScriptModelConfig("baseUrl", event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    spellCheck={false}
                  />
                </label>
                <label className="model-field">
                  <span>API Key</span>
                  <input
                    type="password"
                    value={scriptModelConfig.apiKey}
                    onChange={(event) => updateScriptModelConfig("apiKey", event.target.value)}
                    placeholder="sk-..."
                    spellCheck={false}
                  />
                </label>
                <label className="model-field">
                  <span>模型</span>
                  <input
                    type="text"
                    value={scriptModelConfig.model}
                    onChange={(event) => updateScriptModelConfig("model", event.target.value)}
                    placeholder="gpt-4o-mini"
                    spellCheck={false}
                  />
                </label>
              </div>
            </div>

            <div className="text-area-label prompt-template-label">
              <div className="prompt-template-head">
                <span>User Prompt 模板</span>
                <div className="prompt-template-actions">
                  <em>{scriptUserPromptTemplateSaved ? "已保存" : "未保存"}</em>
                  <button className="ghost-button compact-button" type="button" onClick={restoreDefaultScriptUserPromptTemplate}>
                    <RefreshCw size={15} />
                    恢复默认
                  </button>
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    disabled={scriptUserPromptTemplateSaved}
                    onClick={saveScriptUserPromptTemplate}
                  >
                    <CheckCircle2 size={15} />
                    保存模板
                  </button>
                </div>
              </div>
              <textarea
                aria-label="User Prompt 模板"
                rows={7}
                value={scriptUserPromptTemplate}
                onChange={(event) => updateScriptUserPromptTemplate(event.target.value)}
                placeholder="输入完整 user prompt，可用 {productDescription} 引用下面的产品描述"
                spellCheck={false}
              />
            </div>

            <label className="text-area-label">
              <span>产品描述</span>
              <textarea
                rows={9}
                value={productDescription}
                onChange={(event) => setProductDescription(event.target.value)}
                placeholder="例如：产品名称、核心卖点、适合人群、价格活动、使用场景"
              />
            </label>

            <div className="text-area-label forbidden-words-label">
              <div className="prompt-template-head">
                <span>违禁词列表</span>
                <div className="prompt-template-actions">
                  <em>{scriptForbiddenWordsSaved ? "已保存" : "未保存"}</em>
                  <button
                    className="ghost-button compact-button"
                    type="button"
                    disabled={scriptForbiddenWordsSaved}
                    onClick={saveScriptForbiddenWordsText}
                  >
                    <CheckCircle2 size={15} />
                    保存违禁词
                  </button>
                </div>
              </div>
              <input
                aria-label="违禁词列表"
                type="text"
                value={scriptForbiddenWordsText}
                onChange={(event) => updateScriptForbiddenWordsText(event.target.value)}
                placeholder="多个词用空格分隔"
                spellCheck={false}
              />
            </div>

            <div className="script-command-row">
              <button className="primary-button" type="button" disabled={!canGenerateScript} onClick={() => void generateScript()}>
                {scriptGenerating ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
                生成文稿
              </button>
              <button className="ghost-button" type="button" disabled={!generatedScript.trim()} onClick={useGeneratedScriptInConsole}>
                <FileText size={16} />
                放入对话框
              </button>
            </div>

            <div className="script-signal-card">
              <Sparkles size={18} />
              <div>
                <strong>{generatedScript ? "文稿已就绪" : "等待产品描述"}</strong>
                <span>{generatedScript ? "可以编辑后直接播报" : "生成后会出现在右侧"}</span>
              </div>
            </div>
          </div>

          <div className="script-panel script-output-panel">
            <div className="panel-head">
              <div>
                <h2>直播文稿</h2>
                <p>播报前可以继续微调语气和节奏。</p>
              </div>
              <StatusPill icon={<Video size={14} />} label={rtcLabel} tone={rtcTone} />
            </div>

            <label className="text-area-label script-output-label">
              <span>生成结果</span>
              <textarea
                rows={16}
                value={generatedScript}
                onChange={(event) => setGeneratedScript(event.target.value)}
                placeholder="生成后的直播文稿会显示在这里"
              />
            </label>

            <div className="script-command-row script-command-row--end">
              <button
                className="ghost-button pending-add-button"
                type="button"
                disabled={!generatedScript.trim()}
                onClick={addGeneratedScriptToPendingList}
              >
                <ListPlus size={16} />
                添加到待播稿列表
              </button>
              <button className="ghost-button" type="button" onClick={() => setCurrentPage("control")}>
                <ArrowLeft size={16} />
                返回控制台
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={!canSendGeneratedScript}
                title={sessionId ? "让数字人直接播报文稿" : "请先返回控制台连接数字人"}
                onClick={() => void sendGeneratedScript()}
              >
                <Send size={16} />
                让数字人播报
              </button>
            </div>

            <div className="pending-script-list">
              <div className="pending-script-head">
                <span>待播稿列表</span>
                <em>{pendingScripts.length} 条</em>
              </div>
              {pendingScripts.length === 0 ? (
                <p className="pending-script-empty">暂无待播稿</p>
              ) : (
                <div className="pending-script-items">
                  {pendingScripts.map((entry) => (
                    <div
                      key={entry.id}
                      className="pending-script-row-wrap"
                      onContextMenu={(event) => openPendingScriptMenu(event, entry)}
                    >
                      <button className="pending-script-row" type="button" onClick={() => loadPendingScript(entry)}>
                        <span>{entry.preview}</span>
                        <time>{autoQueuedScriptIds.includes(entry.id) ? "已入队" : entry.createdAt}</time>
                      </button>
                      <div className="pending-script-popover">{entry.text}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="auto-script-panel">
                <label className="auto-script-row">
                  <input
                    type="checkbox"
                    checked={loopPlaybackEnabled}
                    onChange={(event) => setLoopPlaybackEnabled(event.target.checked)}
                  />
                  <span>开启在第</span>
                  <input
                    className={loopPlaybackLimitInvalid ? "invalid" : ""}
                    type="number"
                    min={1}
                    step={1}
                    value={loopPlaybackLimit}
                    onChange={(event) => setLoopPlaybackLimit(event.target.value)}
                  />
                  <span>条之后开始循环</span>
                </label>
                {loopPlaybackLimitInvalid ? <em>循环条数必须大于 0，或留空。</em> : null}

                <label className="auto-script-row">
                  <input
                    type="checkbox"
                    checked={autoRefillEnabled}
                    onChange={(event) => setAutoRefillEnabled(event.target.checked)}
                  />
                  <span>剩余待播稿不足</span>
                  <input
                    className={autoRefillThresholdInvalid ? "invalid" : ""}
                    type="number"
                    min={1}
                    step={1}
                    value={autoRefillThreshold}
                    onChange={(event) => setAutoRefillThreshold(event.target.value)}
                  />
                  <span>条时自动补生成</span>
                </label>
                {autoRefillThresholdInvalid ? <em>补生成阈值必须大于 0。</em> : null}

                <label className="auto-script-row">
                  <input
                    type="checkbox"
                    checked={autoQueueEnabled}
                    onChange={(event) => setAutoQueueEnabled(event.target.checked)}
                  />
                  <span>开启自动队列播稿</span>
                </label>

                <div className="auto-script-status">
                  <span>未入队 {pendingUnqueuedCount} 条</span>
                  <span>{autoQueueBusy ? "正在加入播报队列" : autoQueueEnabled ? "自动队列待命" : "自动队列关闭"}</span>
                  <span>{autoRefillBusy ? "正在补生成" : autoRefillEnabled ? "自动补生成待命" : "自动补生成关闭"}</span>
                  {loopCapReached ? <span>已到循环上限</span> : null}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {pendingScriptMenu ? (
        <div
          className="pending-script-context-menu"
          style={{ left: pendingScriptMenu.x, top: pendingScriptMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => deletePendingScript(pendingScriptMenu.entryId)}>
            删除
          </button>
        </div>
      ) : null}

      <details className={`log-panel diagnostic-panel ${hasError ? "diagnostic-panel--error" : ""}`}>
        <summary>
          <span>
            <Terminal size={17} />
            问题诊断
          </span>
          <strong>{hasError ? "发现异常" : "暂无异常"}</strong>
          <em>{latestEvent}</em>
        </summary>
        <div className="panel-head compact">
          <div>
            <h2>运行日志</h2>
          </div>
          <Terminal size={18} />
        </div>
        <div className="log-list">
          {logs.length === 0 ? <p className="empty-log">暂无日志</p> : logs.map((entry) => <LogLine key={entry.id} entry={entry} />)}
        </div>
      </details>
    </main>
  );
}
