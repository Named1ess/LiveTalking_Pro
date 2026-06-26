export interface DanmakuProxyConfig {
  httpBaseUrl: string;
  wsBaseUrl: string;
}

let proxyConfig: DanmakuProxyConfig | null = null;

export function configureDanmakuProxy(config: DanmakuProxyConfig): void {
  proxyConfig = {
    httpBaseUrl: config.httpBaseUrl.replace(/\/+$/, ""),
    wsBaseUrl: config.wsBaseUrl.replace(/\/+$/, ""),
  };
}

function requireProxyConfig(): DanmakuProxyConfig {
  if (!proxyConfig) {
    throw new Error("弹幕代理尚未启动。");
  }

  return proxyConfig;
}

export function makeDanmakuHttpUrl(path: string): string {
  const config = requireProxyConfig();
  return new URL(path, `${config.httpBaseUrl}/`).toString();
}

export function makeDanmakuSocketUrl(path: string): string {
  const config = requireProxyConfig();
  return new URL(path, `${config.wsBaseUrl}/`).toString();
}
