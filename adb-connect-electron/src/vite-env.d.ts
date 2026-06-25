/// <reference types="vite/client" />

type NativeRequest = {
  command: string;
  payload?: Record<string, unknown>;
};

interface Window {
  adbNative: {
    run<T>(request: NativeRequest): Promise<T>;
  };
}
