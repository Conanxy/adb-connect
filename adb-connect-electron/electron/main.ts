import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";

const isDev = !app.isPackaged;

type NativeRequest = {
  command: string;
  payload?: Record<string, unknown>;
};

let mainWindow: BrowserWindow | null = null;

function nativeBinaryPath() {
  const binary = process.platform === "win32" ? "adb-native.exe" : "adb-native";
  if (isDev) {
    return path.resolve(__dirname, "..", "native-adb", "target", "debug", binary);
  }

  return path.join(process.resourcesPath, "native-adb", binary);
}

function runNative<T>(request: NativeRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeBinaryPath(), [], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`无法启动 Rust ADB 服务：${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Rust ADB 服务退出码：${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(new Error(`Rust ADB 服务返回无效 JSON：${String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "ADB Connect",
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#eef2f6",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:1420");
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("native:run", async (_event, request: NativeRequest) => runNative(request));

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
