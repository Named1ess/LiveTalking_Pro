import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleStop,
  FileText,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8010";
const ASR_CHUNK_SAMPLES = 960;
const ASR_TARGET_SAMPLE_RATE = 16000;
const FLOATING_VIDEO_WINDOW_NAME = "livetalking-floating-video";
const SCRIPT_MODEL_CONFIG_STORAGE_KEY = "livetalking.scriptModelConfig";

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

interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  message: string;
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

function buildScriptGenerationMessages(description: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "你是一个直播带货文案策划智能体。只输出可以直接让数字人播报的中文口播文稿，不要解释，不要标题，不要 Markdown，不要列表编号。语气自然、有直播互动感，避免虚假承诺。",
    },
    {
      role: "user",
      content: [
        "根据下面的产品描述，生成一段 60 到 90 秒的智能体直播口播文稿。",
        "结构要自然包含：开场抓注意力、用户痛点、核心卖点、使用场景、互动引导、咨询转化。",
        "文稿要适合数字人直接播报，句子短一些，有停顿感，但不要写括号动作提示。",
        "",
        `产品描述：${description}`,
      ].join("\n"),
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

async function generateLiveScriptWithModel(description: string, config: ScriptModelConfig): Promise<string> {
  const normalizedConfig = normalizeScriptModelConfig(config);
  const payload = await fetchJson(makeChatCompletionsUrl(normalizedConfig.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${normalizedConfig.apiKey}`,
    },
    body: JSON.stringify({
      model: normalizedConfig.model,
      messages: buildScriptGenerationMessages(description),
      temperature: 0.72,
      max_tokens: 900,
      stream: false,
    }),
  });

  return readChatCompletionText(payload);
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
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("unknown");
  const [rtcStatus, setRtcStatus] = useState<RtcStatus>("idle");
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");
  const [sessionId, setSessionId] = useState("");
  const [manualText, setManualText] = useState("你好，欢迎使用 LiveTalking。");
  const [productDescription, setProductDescription] = useState("");
  const [generatedScript, setGeneratedScript] = useState("");
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
  const asrSocketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);
  const resamplerRef = useRef<Pcm16Resampler | null>(null);
  const asrTimeoutRef = useRef<number | null>(null);
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
    async (text: string, source: HumanTextSource, modeOverride?: HumanMode): Promise<boolean> => {
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
        type: modeOverride ?? humanModeRef.current,
        interrupt: interruptOnSendRef.current,
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
        if (event.track.kind === "video" && videoRef.current) {
          videoRef.current.srcObject = stream;
          syncFloatingVideoWindow(stream);
        }
        if (event.track.kind === "audio" && audioRef.current) {
          audioRef.current.srcObject = stream;
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
  }, [appendLog, backendUrl, rtcStatus, stopRtc, syncFloatingVideoWindow, useStun]);

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

  const generateScript = useCallback(async (): Promise<void> => {
    const description = productDescription.trim();

    if (!description) {
      appendLog("warn", "请先输入产品描述。");
      return;
    }

    setScriptGenerating(true);
    try {
      const script = await generateLiveScriptWithModel(description, scriptModelConfig);
      setGeneratedScript(script);
      appendLog("success", "大模型直播文稿已生成。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("error", `大模型生成失败：${message}`);
    } finally {
      setScriptGenerating(false);
    }
  }, [appendLog, productDescription, scriptModelConfig]);

  const sendGeneratedScript = useCallback(async (): Promise<void> => {
    const sent = await postHumanText(generatedScript, "script", "echo");
    if (sent) {
      setCurrentPage("control");
    }
  }, [generatedScript, postHumanText]);

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
      closeFloatingVideoWindow(false);
      peerConnectionRef.current?.close();
      closeAsrSocket();
      void stopAudioGraph();
    };
  }, [appendLog, closeAsrSocket, closeFloatingVideoWindow, stopAudioGraph]);

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
  const canGenerateScript = Boolean(productDescription.trim()) && !scriptGenerating;
  const canSendGeneratedScript = Boolean(sessionId && generatedScript.trim());
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
            <audio ref={audioRef} autoPlay />
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

            <label className="text-area-label">
              <span>产品描述</span>
              <textarea
                rows={9}
                value={productDescription}
                onChange={(event) => setProductDescription(event.target.value)}
                placeholder="例如：产品名称、核心卖点、适合人群、价格活动、使用场景"
              />
            </label>

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
          </div>
        </section>
      )}

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
