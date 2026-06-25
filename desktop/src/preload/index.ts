import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("desktopApi", {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  requestBackend: (request: BackendRequest): Promise<BackendResponse> =>
    ipcRenderer.invoke("backend:request", request) as Promise<BackendResponse>,
});
