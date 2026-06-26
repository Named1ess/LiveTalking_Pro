import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

export interface DanmakuProxyInfo {
  httpBaseUrl: string;
  wsBaseUrl: string;
}

const DOUYIN_HTTP_ORIGIN = "https://live.douyin.com";
const DOUYIN_WS_ORIGIN = "wss://webcast100-ws-web-lq.douyin.com";
const DOUYIN_REFERER = "https://live.douyin.com/";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0";

class CookieJar {
  private readonly cookies = new Map<string, string>();

  update(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const [pair] = header.split(";");
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function readSetCookieHeaders(headers: Headers): string[] {
  const headersList = headers.getSetCookie();
  if (headersList.length > 0) {
    return headersList;
  }

  const header = headers.get("set-cookie");
  return header ? [header] : [];
}

function makeCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-secsdk-csrf-request, x-secsdk-csrf-version",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  };
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    ...makeCorsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function makeForwardHeaders(request: IncomingMessage, cookieJar: CookieJar): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": DESKTOP_USER_AGENT,
    Referer: DOUYIN_REFERER,
    Accept: String(request.headers.accept ?? "*/*"),
  };

  const cookie = cookieJar.toHeader();
  if (cookie) {
    headers.Cookie = cookie;
  }

  const csrfRequest = request.headers["x-secsdk-csrf-request"];
  if (typeof csrfRequest === "string") {
    headers["X-Secsdk-Csrf-Request"] = csrfRequest;
  }

  const csrfVersion = request.headers["x-secsdk-csrf-version"];
  if (typeof csrfVersion === "string") {
    headers["X-Secsdk-Csrf-Version"] = csrfVersion;
  }

  return headers;
}

function makeDouyinHttpUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (!url.pathname.startsWith("/dylive")) {
    return null;
  }

  const targetPath = url.pathname.replace(/^\/dylive/, "") || "/";
  return new URL(`${targetPath}${url.search}`, DOUYIN_HTTP_ORIGIN).toString();
}

function makeDouyinWebSocketUrl(requestUrl: string): string | null {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (!url.pathname.startsWith("/socket")) {
    return null;
  }

  const targetPath = url.pathname.replace(/^\/socket/, "") || "/";
  return new URL(`${targetPath}${url.search}`, DOUYIN_WS_ORIGIN).toString();
}

export class DanmakuProxyServer {
  private server: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private proxyInfo: DanmakuProxyInfo | null = null;
  private readonly cookieJar = new CookieJar();

  async start(): Promise<DanmakuProxyInfo> {
    if (this.proxyInfo) {
      return this.proxyInfo;
    }

    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const webSocketServer = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      const targetUrl = makeDouyinWebSocketUrl(request.url ?? "");
      if (!targetUrl) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        this.handleWebSocketConnection(client, targetUrl);
      });
    });

    this.server = server;
    this.webSocketServer = webSocketServer;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    this.proxyInfo = {
      httpBaseUrl: `http://127.0.0.1:${address.port}`,
      wsBaseUrl: `ws://127.0.0.1:${address.port}`,
    };
    return this.proxyInfo;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = null;
    this.webSocketServer = null;
    this.proxyInfo = null;

    webSocketServer?.clients.forEach((client) => client.close());
    webSocketServer?.close();

    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, makeCorsHeaders());
      response.end();
      return;
    }

    const targetUrl = makeDouyinHttpUrl(request.url ?? "");
    if (!targetUrl) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers: makeForwardHeaders(request, this.cookieJar),
      });

      this.cookieJar.update(readSetCookieHeaders(upstream.headers));

      const responseHeaders: Record<string, string> = {
        ...makeCorsHeaders(),
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      };

      response.writeHead(upstream.status, responseHeaders);
      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());
      response.end(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 502, { error: message });
    }
  }

  private handleWebSocketConnection(client: WebSocket, targetUrl: string): void {
    const headers: Record<string, string> = {
      "User-Agent": DESKTOP_USER_AGENT,
      Origin: DOUYIN_HTTP_ORIGIN,
      Referer: DOUYIN_REFERER,
    };

    const cookie = this.cookieJar.toHeader();
    if (cookie) {
      headers.Cookie = cookie;
    }

    const upstream = new WebSocket(targetUrl, { headers });

    const closeBoth = (): void => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };

    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });

    client.on("close", closeBoth);
    client.on("error", closeBoth);
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
  }
}
