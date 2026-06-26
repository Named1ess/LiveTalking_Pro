export {};

declare global {
  interface DesktopBackendRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  interface DesktopBackendResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text: string;
  }

  interface DesktopDanmakuProxyInfo {
    httpBaseUrl: string;
    wsBaseUrl: string;
  }

  interface Window {
    desktopApi?: {
      platform: string;
      versions: {
        chrome: string;
        electron: string;
        node: string;
      };
      requestBackend?: (request: DesktopBackendRequest) => Promise<DesktopBackendResponse>;
      ensureDanmakuProxy?: () => Promise<DesktopDanmakuProxyInfo>;
    };

    byted_acrawler?: {
      frontierSign: (input: { "X-MS-STUB": string }) => { "X-Bogus"?: string };
    };
  }
}
