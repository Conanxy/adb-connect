import React from "react";
import ReactDOM from "react-dom/client";
import QRCode from "qrcode";
import {
  Cable,
  CheckCircle2,
  Loader2,
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

type ToolMode = "connect" | "code" | "qr" | "discover" | "settings";
type LoadingKey = keyof AppLoading;

type AppLoading = {
  refresh: boolean;
  connect: boolean;
  pair: boolean;
  qrPair: boolean;
  discover: boolean;
  restart: boolean;
  savePath: boolean;
};

const REFRESH_INTERVAL_MS = 3000;

function nativeInvoke<T>(command: string, payload?: Record<string, unknown>) {
  return window.adbNative.run<T>({ command, payload });
}

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
  const [qrPairingSucceeded, setQrPairingSucceeded] = React.useState(false);
  const [toolMode, setToolMode] = React.useState<ToolMode>("connect");
  const [candidates, setCandidates] = React.useState<WirelessCandidate[]>([]);
  const [logs, setLogs] = React.useState<ConnectionLog[]>([]);
  const [activeTask, setActiveTask] = React.useState("");
  const [candidateConnectingAddress, setCandidateConnectingAddress] = React.useState("");
  const [loading, setLoading] = React.useState<AppLoading>({
    refresh: false,
    connect: false,
    pair: false,
    qrPair: false,
    discover: false,
    restart: false,
    savePath: false
  });
  const qrPairingRunId = React.useRef(0);

  const busy = Object.values(loading).some(Boolean);

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

  const setTaskLoading = React.useCallback((key: LoadingKey, value: boolean, label?: string) => {
    setLoading((current) => ({ ...current, [key]: value }));
    setActiveTask(value ? label ?? "" : "");
  }, []);

  const refreshAll = React.useCallback(async (showLoading = true) => {
    if (showLoading) {
      setTaskLoading("refresh", true, "刷新设备列表");
    }
    try {
      const [status, nextDevices, nextSettings] = await Promise.all([
        nativeInvoke<AdbStatus>("getAdbStatus"),
        nativeInvoke<Device[]>("listDevices"),
        nativeInvoke<SettingsState>("getSettings")
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
      if (showLoading) {
        setTaskLoading("refresh", false);
      }
    }
  }, [addLog, setTaskLoading]);

  React.useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => void refreshAll(false), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      qrPairingRunId.current += 1;
    };
  }, [refreshAll]);

  function cancelQrPairing(resetView = false) {
    qrPairingRunId.current += 1;
    setTaskLoading("qrPair", false);

    if (resetView) {
      setQrSession(null);
      setQrCodeUrl("");
      setQrPairingSucceeded(false);
      setQrPairingStatus("生成二维码后会自动等待手机扫码");
    }
  }

  function switchToolMode(mode: ToolMode) {
    if (mode !== "qr") {
      cancelQrPairing(true);
    }
    setToolMode(mode);
  }

  async function runCommand(
    loadingKey: LoadingKey,
    taskLabel: string,
    commandType: string,
    target: string,
    action: () => Promise<CommandResult>
  ) {
    setTaskLoading(loadingKey, true, taskLabel);
    try {
      const result = await action();
      addLog({
        commandType,
        target,
        success: result.success,
        message: result.message,
        rawOutput: result.rawOutput
      });
      await refreshAll(false);
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
      setTaskLoading(loadingKey, false);
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

    const isCandidateAction = target !== wirelessAddress.trim();
    if (isCandidateAction) {
      setCandidateConnectingAddress(target);
    }

    try {
      await runCommand("connect", "连接无线设备", "无线连接", target, () =>
        nativeInvoke<CommandResult>("connectWireless", { address: target })
      );
    } finally {
      if (isCandidateAction) {
        setCandidateConnectingAddress("");
      }
    }
  }

  async function pairWireless() {
    const target = pairAddress.trim();
    await runCommand("pair", "执行配对码配对", "无线配对", target, () =>
      nativeInvoke<CommandResult>("pairWireless", {
        address: target,
        pairingCode
      })
    );
  }

  async function createQrPairingSession() {
    cancelQrPairing(false);
    const runId = qrPairingRunId.current;
    setTaskLoading("qrPair", true, "生成扫码配对二维码");
    try {
      setQrPairingSucceeded(false);
      const session = await nativeInvoke<QrPairingSession>("createQrPairingSession");
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
      setTaskLoading("qrPair", false);
      addLog({
        commandType: "二维码配对",
        target: "生成二维码",
        success: false,
        message,
        rawOutput: message
      });
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
        const result = await nativeInvoke<CommandResult>("completeQrPairing", {
          serviceName: session.serviceName,
          password: session.password
        });

        if (qrPairingRunId.current !== runId) {
          return;
        }

        if (result.success) {
          setQrSession(null);
          setQrCodeUrl("");
          setQrPairingSucceeded(true);
          setQrPairingStatus("连接成功，二维码已失效。继续连接请重新生成。");
          addLog({
            commandType: "二维码配对",
            target: session.serviceName,
            success: true,
            message: result.message,
            rawOutput: result.rawOutput
          });
          await refreshAll(false);
          setTaskLoading("qrPair", false);
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
      setTaskLoading("qrPair", false);
    }
  }

  async function disconnectDevice(serial: string) {
    await runCommand("connect", "断开无线设备", "断开设备", serial, () =>
      nativeInvoke<CommandResult>("disconnectDevice", { serial })
    );
  }

  async function connectMdnsDevice(serial: string) {
    await runCommand("connect", "解析并连接无线设备", "mDNS 连接", serial, () =>
      nativeInvoke<CommandResult>("connectMdnsDevice", { serial })
    );
  }

  async function restartAdbServer() {
    await runCommand("restart", "重启 ADB server", "重启 ADB", "adb server", () =>
      nativeInvoke<CommandResult>("restartAdbServer")
    );
  }

  async function discoverCandidates() {
    setTaskLoading("discover", true, "扫描局域网设备");
    try {
      const result = await nativeInvoke<WirelessCandidate[]>("discoverWirelessCandidates");
      setCandidates(result);
      addLog({
        commandType: "自动发现",
        target: "局域网",
        success: true,
        message: result.length > 0 ? `发现 ${result.length} 个候选设备` : "未发现候选设备",
        rawOutput: formatCandidateSummary(result)
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
      setTaskLoading("discover", false);
    }
  }

  async function saveAdbPath() {
    setTaskLoading("savePath", true, "保存 ADB 路径");
    try {
      const result = await nativeInvoke<SettingsState>("updateAdbPath", {
        path: adbPathInput
      });
      setSettings(result);
      addLog({
        commandType: "保存设置",
        target: adbPathInput || "默认 adb",
        success: true,
        message: "ADB 路径已保存",
        rawOutput: JSON.stringify(result)
      });
      await refreshAll(false);
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
      setTaskLoading("savePath", false);
    }
  }

  const usbCount = devices.filter((device) => device.transport === "usb").length;
  const wirelessCount = devices.filter((device) => device.transport === "wireless").length;

  return (
    <main className={`app-shell ${busy ? "is-busy" : ""}`}>
      {busy ? (
        <div className="task-toast">
          <Loader2 size={16} className="spin" />
          <span>{activeTask || "正在处理"}</span>
        </div>
      ) : null}

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
                <ActionButton icon={<RefreshCw size={18} />} loading={loading.refresh} label="刷新" title="刷新设备" variant="icon" onClick={() => void refreshAll()} />
                <ActionButton icon={<RotateCcw size={16} />} loading={loading.restart} label="重启 ADB" onClick={() => void restartAdbServer()} />
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
                      <ActionButton icon={<Unplug size={16} />} loading={loading.connect} label="断开" onClick={() => void disconnectDevice(device.serial)} />
                    ) : canConnectMdnsDevice(device) ? (
                      <ActionButton icon={<Wifi size={16} />} loading={loading.connect} label="连接" onClick={() => void connectMdnsDevice(device.serial)} />
                    ) : device.transport === "wireless" ? (
                      <span className="readonly-pill">已配对</span>
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
              <ModeTab active={toolMode === "connect"} icon={<Wifi size={16} />} label="连接" onClick={() => switchToolMode("connect")} />
              <ModeTab active={toolMode === "code"} icon={<Smartphone size={16} />} label="配对码" onClick={() => switchToolMode("code")} />
              <ModeTab active={toolMode === "qr"} icon={<QrCodeIcon size={16} />} label="扫码" onClick={() => switchToolMode("qr")} />
              <ModeTab active={toolMode === "discover"} icon={<Radar size={16} />} label="发现" onClick={() => switchToolMode("discover")} />
              <ModeTab active={toolMode === "settings"} icon={<Settings size={16} />} label="设置" onClick={() => switchToolMode("settings")} />
            </div>

            {toolMode === "connect" ? (
              <div className="tool-section">
                <label className="field flush">
                  <span>设备地址</span>
                  <input placeholder="192.168.1.23:5555" value={wirelessAddress} onChange={(event) => setWirelessAddress(event.target.value)} />
                </label>
                <ActionButton icon={<Wifi size={17} />} loading={loading.connect} label="连接" variant="primary" fullWidth onClick={() => void connectWireless()} />
              </div>
            ) : null}

            {toolMode === "code" ? (
              <div className="tool-section">
                <label className="field flush">
                  <span>配对地址</span>
                  <input placeholder="192.168.1.23:37123" value={pairAddress} onChange={(event) => setPairAddress(event.target.value)} />
                </label>
                <label className="field flush">
                  <span>配对码</span>
                  <input placeholder="123456" value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} />
                </label>
                <ActionButton icon={<CheckCircle2 size={17} />} loading={loading.pair} label="配对" variant="primary" fullWidth onClick={() => void pairWireless()} />
              </div>
            ) : null}

            {toolMode === "qr" ? (
              <div className="tool-section">
                <ActionButton icon={<QrCodeIcon size={17} />} loading={loading.qrPair} label="生成二维码" fullWidth onClick={() => void createQrPairingSession()} />
                {qrPairingSucceeded ? (
                  <div className="qr-success-box">
                    <CheckCircle2 size={40} />
                    <strong>连接成功</strong>
                    <span>{qrPairingStatus}</span>
                  </div>
                ) : qrCodeUrl ? (
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
                <ActionButton icon={<Radar size={17} />} loading={loading.discover} label="扫描局域网" fullWidth onClick={() => void discoverCandidates()} />
                <div className="candidate-list flush">
                  {candidates.length === 0 ? (
                    <span className="muted-line flush">暂无候选设备</span>
                  ) : (
                    candidates.map((candidate) => (
                      <button
                        className="candidate-row motion-button"
                        disabled={loading.connect}
                        key={candidate.address}
                        onClick={() => void connectWireless(candidate.address)}
                      >
                        <span>
                          {candidateConnectingAddress === candidate.address ? <Loader2 size={14} className="spin" /> : null}
                          {candidate.address}
                        </span>
                        <small>{candidateConnectingAddress === candidate.address ? "连接中" : `${candidate.confidence} · ${candidate.source}`}</small>
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
                  <input placeholder={settings.adbPath ? settings.adbPath : "留空使用系统 PATH"} value={adbPathInput} onChange={(event) => setAdbPathInput(event.target.value)} />
                </label>
                <ActionButton icon={<Save size={17} />} loading={loading.savePath} label="保存路径" fullWidth onClick={() => void saveAdbPath()} />
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

function ActionButton({
  fullWidth = false,
  icon,
  label,
  loading,
  onClick,
  title,
  variant = "secondary"
}: {
  fullWidth?: boolean;
  icon: React.ReactNode;
  label: string;
  loading?: boolean;
  onClick: () => void;
  title?: string;
  variant?: "primary" | "secondary" | "icon";
}) {
  const widthClass = fullWidth ? "is-full" : "";
  const className = variant === "primary" ? `primary-button ${widthClass} motion-button` : variant === "icon" ? "icon-button motion-button" : `secondary-button ${widthClass} motion-button`;
  return (
    <button className={className} onClick={onClick} disabled={loading} title={title ?? label}>
      {loading ? <Loader2 size={17} className="spin" /> : icon}
      {variant === "icon" ? null : <span>{loading ? "处理中" : label}</span>}
    </button>
  );
}

function ModeTab({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`motion-button ${active ? "active" : ""}`} onClick={onClick} title={label}>
      {icon}
      <span>{label}</span>
    </button>
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

function canConnectMdnsDevice(device: Device) {
  return device.transport === "wireless" && device.serial.includes("_adb-tls-connect._tcp") && !device.serial.includes(":");
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

function formatCandidateSummary(candidates: WirelessCandidate[]) {
  if (candidates.length === 0) {
    return "";
  }

  const visibleCandidates = candidates.slice(0, 20).map((candidate) => `${candidate.address} · ${candidate.confidence} · ${candidate.source}`);
  const hiddenCount = candidates.length - visibleCandidates.length;
  return hiddenCount > 0
    ? `${visibleCandidates.join("\n")}\n... 另有 ${hiddenCount} 个候选设备，请在发现列表中滚动查看`
    : visibleCandidates.join("\n");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
