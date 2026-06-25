import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import {
  Cable,
  CheckCircle2,
  PlugZap,
  QrCode as QrCodeIcon,
  Radar,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings,
  Smartphone,
  Unplug,
  Wifi,
  XCircle
} from "lucide-react";
import "./styles.css";

type Device = {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  transport: "usb" | "wireless" | string;
  displayName: string;
};

type AdbStatus = {
  available: boolean;
  source: string;
  path: string;
  version?: string;
  error?: string;
};

type CommandResult = {
  success: boolean;
  message: string;
  rawOutput: string;
};

type SettingsState = {
  adbPath?: string;
};

type WirelessCandidate = {
  address: string;
  source: string;
  confidence: string;
};

type QrPairingSession = {
  serviceName: string;
  password: string;
  pairingString: string;
};

type ConnectionLog = {
  id: string;
  time: string;
  commandType: string;
  target: string;
  success: boolean;
  message: string;
  rawOutput: string;
};

const REFRESH_INTERVAL_MS = 3000;

function App() {
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [adbStatus, setAdbStatus] = React.useState<AdbStatus | null>(null);
  const [settings, setSettings] = React.useState<SettingsState>({});
  const [wirelessAddress, setWirelessAddress] = React.useState("");
  const [pairAddress, setPairAddress] = React.useState("");
  const [pairingCode, setPairingCode] = React.useState("");
  const [adbPathInput, setAdbPathInput] = React.useState("");
  const [qrSession, setQrSession] = React.useState<QrPairingSession | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = React.useState("");
  const [qrPairingStatus, setQrPairingStatus] = React.useState("生成二维码后会自动等待手机扫码");
  const [toolMode, setToolMode] = React.useState<"connect" | "code" | "qr" | "discover" | "settings">("connect");
  const [candidates, setCandidates] = React.useState<WirelessCandidate[]>([]);
  const [logs, setLogs] = React.useState<ConnectionLog[]>([]);
  const [loading, setLoading] = React.useState({
    refresh: false,
    connect: false,
    pair: false,
    qrPair: false,
    discover: false,
    restart: false,
    savePath: false
  });
  const qrPairingRunId = React.useRef(0);

  const addLog = React.useCallback((entry: Omit<ConnectionLog, "id" | "time">) => {
    setLogs((current) => [
      {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        ...entry
      },
      ...current
    ].slice(0, 80));
  }, []);

  const refreshAll = React.useCallback(async () => {
    setLoading((current) => ({ ...current, refresh: true }));
    try {
      const [status, nextDevices, nextSettings] = await Promise.all([
        invoke<AdbStatus>("get_adb_status"),
        invoke<Device[]>("list_devices"),
        invoke<SettingsState>("get_settings")
      ]);
      setAdbStatus(status);
      setDevices(nextDevices);
      setSettings(nextSettings);
      setAdbPathInput(nextSettings.adbPath ?? "");
    } catch (error) {
      const message = formatError(error);
      addLog({
        commandType: "刷新设备",
        target: "adb devices -l",
        success: false,
        message,
        rawOutput: message
      });
    } finally {
      setLoading((current) => ({ ...current, refresh: false }));
    }
  }, [addLog]);

  React.useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => void refreshAll(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      qrPairingRunId.current += 1;
    };
  }, [refreshAll]);

  function cancelQrPairing(resetView = false) {
    qrPairingRunId.current += 1;
    setLoading((current) => ({ ...current, qrPair: false }));

    if (resetView) {
      setQrSession(null);
      setQrCodeUrl("");
      setQrPairingStatus("生成二维码后会自动等待手机扫码");
    }
  }

  function switchToolMode(mode: typeof toolMode) {
    if (mode !== "qr") {
      cancelQrPairing(true);
    }
    setToolMode(mode);
  }

  async function runCommand(
    loadingKey: keyof typeof loading,
    commandType: string,
    target: string,
    action: () => Promise<CommandResult>
  ) {
    setLoading((current) => ({ ...current, [loadingKey]: true }));
    try {
      const result = await action();
      addLog({
        commandType,
        target,
        success: result.success,
        message: result.message,
        rawOutput: result.rawOutput
      });
      await refreshAll();
    } catch (error) {
      const message = formatError(error);
      addLog({
        commandType,
        target,
        success: false,
        message,
        rawOutput: message
      });
    } finally {
      setLoading((current) => ({ ...current, [loadingKey]: false }));
    }
  }

  async function connectWireless(address = wirelessAddress) {
    const target = address.trim();
    if (!target) {
      addLog({
        commandType: "无线连接",
        target: "空地址",
        success: false,
        message: "请输入设备 IP 或 IP:端口",
        rawOutput: ""
      });
      return;
    }

    await runCommand("connect", "无线连接", target, () =>
      invoke<CommandResult>("connect_wireless", { address: target })
    );
  }

  async function pairWireless() {
    const target = pairAddress.trim();
    await runCommand("pair", "无线配对", target, () =>
      invoke<CommandResult>("pair_wireless", {
        address: target,
        pairingCode
      })
    );
  }

  async function createQrPairingSession() {
    cancelQrPairing(false);
    const runId = qrPairingRunId.current;
    setLoading((current) => ({ ...current, qrPair: true }));
    try {
      const session = await invoke<QrPairingSession>("create_qr_pairing_session");
      const url = await QRCode.toDataURL(session.pairingString, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 220,
        color: {
          dark: "#1d2733",
          light: "#ffffff"
        }
      });
      setQrSession(session);
      setQrCodeUrl(url);
      setQrPairingStatus("等待手机扫码，扫码后将自动配对");
      void pollQrPairing(session, runId);
      addLog({
        commandType: "二维码配对",
        target: session.serviceName,
        success: true,
        message: "二维码已生成，请在手机无线调试页面扫码",
        rawOutput: session.pairingString
      });
    } catch (error) {
      const message = formatError(error);
      addLog({
        commandType: "二维码配对",
        target: "生成二维码",
        success: false,
        message,
        rawOutput: message
      });
    } finally {
      setLoading((current) => ({ ...current, qrPair: false }));
    }
  }

  async function pollQrPairing(session: QrPairingSession, runId: number) {
    for (let attempt = 1; attempt <= 90; attempt += 1) {
      await wait(1000);
      if (qrPairingRunId.current !== runId) {
        return;
      }
      setQrPairingStatus(`等待手机扫码或配对服务... ${attempt}/90`);

      try {
        const result = await invoke<CommandResult>("complete_qr_pairing", {
          serviceName: session.serviceName,
          password: session.password
        });

        if (qrPairingRunId.current !== runId) {
          return;
        }

        if (result.success) {
          setQrPairingStatus("配对成功，正在刷新设备列表");
          addLog({
            commandType: "二维码配对",
            target: session.serviceName,
            success: true,
            message: result.message,
            rawOutput: result.rawOutput
          });
          await refreshAll();
          return;
        }

        if (attempt % 5 === 0) {
          addLog({
            commandType: "二维码配对",
            target: session.serviceName,
            success: false,
            message: result.message,
            rawOutput: result.rawOutput
          });
        }
      } catch (error) {
        const message = formatError(error);
        setQrPairingStatus(message);
        addLog({
          commandType: "二维码配对",
          target: session.serviceName,
          success: false,
          message,
          rawOutput: message
        });
      }
    }

    if (qrPairingRunId.current === runId) {
      setQrPairingStatus("未发现扫码后的配对服务，请重新生成二维码再试");
    }
  }

  async function disconnectDevice(serial: string) {
    await runCommand("connect", "断开设备", serial, () =>
      invoke<CommandResult>("disconnect_device", { serial })
    );
  }

  async function restartAdbServer() {
    await runCommand("restart", "重启 ADB", "adb server", () =>
      invoke<CommandResult>("restart_adb_server")
    );
  }

  async function discoverCandidates() {
    setLoading((current) => ({ ...current, discover: true }));
    try {
      const result = await invoke<WirelessCandidate[]>("discover_wireless_candidates");
      setCandidates(result);
      addLog({
        commandType: "自动发现",
        target: "局域网",
        success: true,
        message: result.length > 0 ? `发现 ${result.length} 个候选设备` : "未发现候选设备",
        rawOutput: JSON.stringify(result, null, 2)
      });
    } catch (error) {
      const message = formatError(error);
      addLog({
        commandType: "自动发现",
        target: "局域网",
        success: false,
        message,
        rawOutput: message
      });
    } finally {
      setLoading((current) => ({ ...current, discover: false }));
    }
  }

  async function saveAdbPath() {
    setLoading((current) => ({ ...current, savePath: true }));
    try {
      const result = await invoke<SettingsState>("update_adb_path", {
        payload: { path: adbPathInput }
      });
      setSettings(result);
      addLog({
        commandType: "保存设置",
        target: adbPathInput || "默认 adb",
        success: true,
        message: "ADB 路径已保存",
        rawOutput: JSON.stringify(result)
      });
      await refreshAll();
    } catch (error) {
      const message = formatError(error);
      addLog({
        commandType: "保存设置",
        target: adbPathInput,
        success: false,
        message,
        rawOutput: message
      });
    } finally {
      setLoading((current) => ({ ...current, savePath: false }));
    }
  }

  const usbCount = devices.filter((device) => device.transport === "usb").length;
  const wirelessCount = devices.filter((device) => device.transport === "wireless").length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ADB Connect</h1>
          <p>设备连接管理台</p>
        </div>
        <div className={`adb-status ${adbStatus?.available ? "is-ok" : "is-error"}`}>
          {adbStatus?.available ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <strong>{adbStatus?.available ? "ADB 可用" : "ADB 不可用"}</strong>
            <span>{adbStatus?.source ?? "检测中"} · {adbStatus?.path ?? "adb"}</span>
          </div>
        </div>
      </header>

      <section className="metrics">
        <Metric icon={<Smartphone />} label="当前设备" value={devices.length.toString()} />
        <Metric icon={<Cable />} label="USB" value={usbCount.toString()} />
        <Metric icon={<Wifi />} label="无线" value={wirelessCount.toString()} />
        <Metric icon={<Server />} label="ADB 来源" value={adbStatus?.source ?? "-"} />
      </section>

      <section className="workspace">
        <div className="primary-column">
          <section className="panel devices-panel">
            <div className="panel-heading">
              <div>
                <h2>设备列表</h2>
                <p>每 {REFRESH_INTERVAL_MS / 1000} 秒自动刷新</p>
              </div>
              <div className="heading-actions">
                <button className="icon-button" onClick={() => void refreshAll()} title="刷新设备">
                  <RefreshCw size={18} className={loading.refresh ? "spin" : ""} />
                </button>
                <button className="secondary-button" onClick={() => void restartAdbServer()} disabled={loading.restart}>
                  <RotateCcw size={16} />
                  重启 ADB
                </button>
              </div>
            </div>

            <div className="device-list">
              {devices.length === 0 ? (
                <div className="empty-state">
                  <Smartphone size={34} />
                  <strong>暂无设备</strong>
                  <span>插入 USB 设备，或通过右侧无线连接加入设备。</span>
                </div>
              ) : (
                devices.map((device) => (
                  <article className="device-row" key={device.serial}>
                    <div className="device-icon">
                      {device.transport === "wireless" ? <Wifi size={22} /> : <Cable size={22} />}
                    </div>
                    <div className="device-main">
                      <div className="device-title">
                        <strong>{device.displayName}</strong>
                        <span className={`state-pill state-${device.state}`}>{stateLabel(device.state)}</span>
                      </div>
                      <div className="device-meta">
                        <span>{device.serial}</span>
                        <span>{device.transport === "wireless" ? "无线连接" : "USB 连接"}</span>
                        {device.product ? <span>{device.product}</span> : null}
                      </div>
                    </div>
                    {canDisconnectDevice(device) ? (
                      <button className="ghost-button" onClick={() => void disconnectDevice(device.serial)}>
                        <Unplug size={16} />
                        断开
                      </button>
                    ) : device.transport === "wireless" ? (
                      <span className="readonly-pill">自动连接</span>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="panel log-panel">
            <div className="panel-heading">
              <div>
                <h2>操作日志</h2>
                <p>保留最近 80 条 adb 操作结果</p>
              </div>
            </div>
            <div className="log-list">
              {logs.length === 0 ? (
                <div className="log-empty">暂无操作记录</div>
              ) : (
                logs.map((log) => (
                  <article className="log-row" key={log.id}>
                    <div className={`log-dot ${log.success ? "ok" : "bad"}`} />
                    <div>
                      <div className="log-title">
                        <strong>{log.commandType}</strong>
                        <span>{log.target}</span>
                        <time>{log.time}</time>
                      </div>
                      <p>{log.message}</p>
                      {log.rawOutput ? <pre>{log.rawOutput}</pre> : null}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>

        <aside className="side-column">
          <section className="panel tool-panel">
            <div className="panel-heading compact">
              <h2>连接中心</h2>
              <PlugZap size={18} />
            </div>

            <div className="mode-tabs">
              <button className={toolMode === "connect" ? "active" : ""} onClick={() => switchToolMode("connect")} title="无线连接">
                <Wifi size={16} />
                连接
              </button>
              <button className={toolMode === "code" ? "active" : ""} onClick={() => switchToolMode("code")} title="配对码配对">
                <Smartphone size={16} />
                配对码
              </button>
              <button className={toolMode === "qr" ? "active" : ""} onClick={() => switchToolMode("qr")} title="扫码配对">
                <QrCodeIcon size={16} />
                扫码
              </button>
              <button className={toolMode === "discover" ? "active" : ""} onClick={() => switchToolMode("discover")} title="自动发现">
                <Radar size={16} />
                发现
              </button>
              <button className={toolMode === "settings" ? "active" : ""} onClick={() => switchToolMode("settings")} title="ADB 设置">
                <Settings size={16} />
                设置
              </button>
            </div>

            {toolMode === "connect" ? (
              <div className="tool-section">
                <label className="field flush">
                  <span>设备地址</span>
                  <input
                    placeholder="192.168.1.23:5555"
                    value={wirelessAddress}
                    onChange={(event) => setWirelessAddress(event.target.value)}
                  />
                </label>
                <button className="primary-button inline" onClick={() => void connectWireless()} disabled={loading.connect}>
                  <Wifi size={17} />
                  连接
                </button>
              </div>
            ) : null}

            {toolMode === "code" ? (
              <div className="tool-section">
                <label className="field flush">
                  <span>配对地址</span>
                  <input
                    placeholder="192.168.1.23:37123"
                    value={pairAddress}
                    onChange={(event) => setPairAddress(event.target.value)}
                  />
                </label>
                <label className="field flush">
                  <span>配对码</span>
                  <input
                    placeholder="123456"
                    value={pairingCode}
                    onChange={(event) => setPairingCode(event.target.value)}
                  />
                </label>
                <button className="primary-button inline" onClick={() => void pairWireless()} disabled={loading.pair}>
                  <CheckCircle2 size={17} />
                  配对
                </button>
              </div>
            ) : null}

            {toolMode === "qr" ? (
              <div className="tool-section">
                <button className="secondary-button inline" onClick={() => void createQrPairingSession()} disabled={loading.qrPair}>
                  <QrCodeIcon size={17} />
                  生成二维码
                </button>
                {qrCodeUrl ? (
                  <div className="qr-pairing-box compact-qr">
                    <img src={qrCodeUrl} alt="ADB 无线调试配对二维码" />
                    <strong>{qrSession?.serviceName}</strong>
                    <span>{qrPairingStatus}</span>
                  </div>
                ) : (
                  <span className="muted-line flush">用于手机“使用二维码配对设备”。</span>
                )}
              </div>
            ) : null}

            {toolMode === "discover" ? (
              <div className="tool-section">
                <button className="secondary-button inline" onClick={() => void discoverCandidates()} disabled={loading.discover}>
                  <Radar size={17} />
                  扫描局域网
                </button>
                <div className="candidate-list flush">
                  {candidates.length === 0 ? (
                    <span className="muted-line flush">暂无候选设备</span>
                  ) : (
                    candidates.map((candidate) => (
                      <button
                        className="candidate-row"
                        key={candidate.address}
                        onClick={() => void connectWireless(candidate.address)}
                      >
                        <span>{candidate.address}</span>
                        <small>{candidate.confidence} · {candidate.source}</small>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {toolMode === "settings" ? (
              <div className="tool-section">
                <label className="field flush">
                  <span>手动 adb 路径</span>
                  <input
                    placeholder={settings.adbPath ? settings.adbPath : "留空使用内置 adb 或系统 PATH"}
                    value={adbPathInput}
                    onChange={(event) => setAdbPathInput(event.target.value)}
                  />
                </label>
                <button className="secondary-button inline" onClick={() => void saveAdbPath()} disabled={loading.savePath}>
                  <Save size={17} />
                  保存路径
                </button>
                {adbStatus?.version ? <p className="version-line flush">{adbStatus.version}</p> : null}
                {adbStatus?.error ? <p className="error-line flush">{adbStatus.error}</p> : null}
              </div>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <article className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function canDisconnectDevice(device: Device) {
  return device.transport === "wireless" && device.serial.includes(":");
}

function stateLabel(state: string) {
  switch (state) {
    case "device":
      return "在线";
    case "offline":
      return "离线";
    case "unauthorized":
      return "未授权";
    default:
      return state;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatError(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return JSON.stringify(error);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
