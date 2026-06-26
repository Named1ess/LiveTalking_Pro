import { configureDanmakuProxy } from "./core/config";
import { DyCast } from "./core/dycast";

let sdkLoadPromise: Promise<void> | null = null;

function loadDanmakuSdk(): Promise<void> {
  if (window.byted_acrawler) {
    return Promise.resolve();
  }

  if (!sdkLoadPromise) {
    sdkLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("mssdk.js", window.location.href).toString();
      script.async = true;
      script.onload = () => {
        if (window.byted_acrawler) {
          resolve();
          return;
        }

        reject(new Error("抖音签名 SDK 加载失败。"));
      };
      script.onerror = () => reject(new Error("抖音签名 SDK 加载失败。"));
      document.head.appendChild(script);
    });
  }

  return sdkLoadPromise;
}

export async function createDanmakuClient(roomNumber: string): Promise<DyCast> {
  const api = window.desktopApi;
  if (!api?.ensureDanmakuProxy) {
    throw new Error("当前环境不支持弹幕代理。");
  }

  const proxy = await api.ensureDanmakuProxy();
  configureDanmakuProxy(proxy);
  await loadDanmakuSdk();
  return new DyCast(roomNumber);
}

export type { DyLiveInfo, DyMessage } from "./core/dycast";
export { CastMethod } from "./core/dycast";
