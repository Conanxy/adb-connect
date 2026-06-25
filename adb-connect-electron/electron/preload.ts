import { contextBridge, ipcRenderer } from "electron";

type NativeRequest = {
  command: string;
  payload?: Record<string, unknown>;
};

contextBridge.exposeInMainWorld("adbNative", {
  run<T>(request: NativeRequest): Promise<T> {
    return ipcRenderer.invoke("native:run", request) as Promise<T>;
  }
});
