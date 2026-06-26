import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { DanmakuProxyServer, type DanmakuProxyInfo } from "./danmakuProxy";

const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL);
const iconPath = isDevelopment ? join(process.cwd(), "build/icon.ico") : join(process.resourcesPath, "icon.ico");
const floatingVideoWindowName = "livetalking-floating-video";
const floatingVideoAspectRatio = 9 / 16;
const danmakuProxyServer = new DanmakuProxyServer();

interface BackendRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface BackendResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBackendRequest(value: unknown): value is BackendRequest {
  if (!isRecord(value) || typeof value.url !== "string") {
    return false;
  }

  if (value.method !== undefined && typeof value.method !== "string") {
    return false;
  }

  if (value.body !== undefined && typeof value.body !== "string") {
    return false;
  }

  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) {
      return false;
    }

    for (const [key, headerValue] of Object.entries(value.headers)) {
      if (typeof key !== "string" || typeof headerValue !== "string") {
        return false;
      }
    }
  }

  return true;
}

function validateBackendUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) backend requests are allowed");
  }
  return url.toString();
}

ipcMain.handle("backend:request", async (_event, input: unknown): Promise<BackendResponse> => {
  if (!isBackendRequest(input)) {
    throw new Error("Invalid backend request payload");
  }

  const response = await fetch(validateBackendUrl(input.url), {
    method: input.method ?? "GET",
    headers: input.headers,
    body: input.body,
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: await response.text(),
  };
});

ipcMain.handle("danmaku:proxy-start", async (): Promise<DanmakuProxyInfo> => danmakuProxyServer.start());

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0f172a",
    icon: iconPath,
    title: "数字人直播助手",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === floatingVideoWindowName && url === "about:blank") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 405,
          height: 720,
          minWidth: 180,
          minHeight: 320,
          frame: false,
          title: "数字人直播助手浮窗",
          backgroundColor: "#000000",
          alwaysOnTop: false,
          autoHideMenuBar: true,
          resizable: true,
          movable: true,
          focusable: false,
          skipTaskbar: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: false,
          },
        },
      };
    }

    if (url !== "about:blank") {
      shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("did-create-window", (childWindow, details) => {
    if (details.frameName === floatingVideoWindowName) {
      childWindow.setAspectRatio(floatingVideoAspectRatio);
    }
  });

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId("ai.livetalking.desktop");
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void danmakuProxyServer.stop();
});
