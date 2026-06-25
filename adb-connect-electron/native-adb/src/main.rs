use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Read},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::Duration,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdbStatus {
    available: bool,
    source: String,
    path: String,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    serial: String,
    state: String,
    model: Option<String>,
    product: Option<String>,
    transport: String,
    display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    success: bool,
    message: String,
    raw_output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WirelessCandidate {
    address: String,
    source: String,
    confidence: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QrPairingSession {
    service_name: String,
    password: String,
    pairing_string: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    adb_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    command: String,
    payload: Option<Value>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    adb_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MdnsPairingService {
    service_name: String,
    address: String,
    service_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MdnsConnectService {
    service_name: String,
    address: String,
    service_type: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{}", serde_json::to_string(&value).unwrap());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", error);
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<Value, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("无法读取请求：{}", error))?;
    let request: Request = serde_json::from_str(&input).map_err(|error| format!("请求 JSON 无效：{}", error))?;
    let settings = load_settings();

    match request.command.as_str() {
        "getAdbStatus" => Ok(json!(get_adb_status(&settings))),
        "listDevices" => Ok(json!(list_devices(&settings)?)),
        "connectWireless" => Ok(json!(connect_wireless(&settings, string_payload(&request, "address")?)?)),
        "connectMdnsDevice" => Ok(json!(connect_mdns_device(&settings, string_payload(&request, "serial")?)?)),
        "pairWireless" => Ok(json!(pair_wireless(
            &settings,
            string_payload(&request, "address")?,
            string_payload(&request, "pairingCode")?
        )?)),
        "createQrPairingSession" => Ok(json!(create_qr_pairing_session()?)),
        "completeQrPairing" => Ok(json!(complete_qr_pairing(
            &settings,
            string_payload(&request, "serviceName")?,
            string_payload(&request, "password")?
        )?)),
        "disconnectDevice" => Ok(json!(disconnect_device(&settings, string_payload(&request, "serial")?)?)),
        "restartAdbServer" => Ok(json!(restart_adb_server(&settings)?)),
        "discoverWirelessCandidates" => Ok(json!(discover_wireless_candidates())),
        "getSettings" => Ok(json!(Settings {
            adb_path: settings.adb_path
        })),
        "updateAdbPath" => {
            let adb_path = request
                .payload
                .as_ref()
                .and_then(|payload| payload.get("path"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string);
            let next = PersistedSettings { adb_path };
            save_settings(&next)?;
            Ok(json!(Settings {
                adb_path: next.adb_path
            }))
        }
        _ => Err(format!("未知命令：{}", request.command)),
    }
}

fn string_payload(request: &Request, key: &str) -> Result<String, String> {
    request
        .payload
        .as_ref()
        .and_then(|payload| payload.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("缺少参数：{}", key))
}

fn get_adb_status(settings: &PersistedSettings) -> AdbStatus {
    let adb = resolve_adb_path(settings);
    match run_adb_with_path(&adb, &["version"]) {
        Ok(output) => AdbStatus {
            available: true,
            source: adb_source(settings, &adb),
            path: adb,
            version: output.lines().next().map(str::to_string),
            error: None,
        },
        Err(error) => AdbStatus {
            available: false,
            source: adb_source(settings, &adb),
            path: adb,
            version: None,
            error: Some(error),
        },
    }
}

fn list_devices(settings: &PersistedSettings) -> Result<Vec<Device>, String> {
    let adb = resolve_adb_path(settings);
    let output = run_adb_with_path(&adb, &["devices", "-l"])?;
    Ok(parse_devices(&output))
}

fn connect_wireless(settings: &PersistedSettings, address: String) -> Result<CommandResult, String> {
    let normalized = normalize_address(&address, 5555)?;
    let adb = resolve_adb_path(settings);
    run_adb_command_result(&adb, &["connect", normalized.as_str()])
}

fn connect_mdns_device(settings: &PersistedSettings, serial: String) -> Result<CommandResult, String> {
    let adb = resolve_adb_path(settings);
    let output = run_adb_with_path(&adb, &["mdns", "services"])?;
    let services = parse_mdns_connect_services(&output);
    let service = find_mdns_connect_service(&services, serial.trim()).ok_or_else(|| {
        "无法从 mDNS 服务解析连接地址，请确认手机仍在无线调试页面，或切到“发现”后扫描局域网".to_string()
    })?;
    run_adb_command_result(&adb, &["connect", service.address.as_str()])
}

fn pair_wireless(
    settings: &PersistedSettings,
    address: String,
    pairing_code: String,
) -> Result<CommandResult, String> {
    let normalized = normalize_address(&address, 0)?;
    if pairing_code.trim().is_empty() {
        return Err("请输入配对码".to_string());
    }

    let adb = resolve_adb_path(settings);
    run_adb_command_result(&adb, &["pair", normalized.as_str(), pairing_code.trim()])
}

fn create_qr_pairing_session() -> Result<QrPairingSession, String> {
    let service_name = format!("studio-{}", random_pairing_string(10)?);
    let password = random_pairing_string(12)?;
    let pairing_string = create_qr_pairing_string(&service_name, &password);

    Ok(QrPairingSession {
        service_name,
        password,
        pairing_string,
    })
}

fn complete_qr_pairing(
    settings: &PersistedSettings,
    service_name: String,
    password: String,
) -> Result<CommandResult, String> {
    let adb = resolve_adb_path(settings);
    let output = run_adb_with_path(&adb, &["mdns", "services"])?;
    let services = parse_mdns_pairing_services(&output);
    let Some(service) = find_qr_pairing_service(&services, service_name.trim()) else {
        return Ok(CommandResult {
            success: false,
            message: format!("还没有发现手机扫码后的配对服务，当前发现 {} 个配对服务", services.len()),
            raw_output: format!("{}\nparsed_pairing_services={}", output, services.len()),
        });
    };

    run_adb_command_result(&adb, &["pair", service.address.as_str(), password.trim()])
}

fn disconnect_device(settings: &PersistedSettings, serial: String) -> Result<CommandResult, String> {
    let adb = resolve_adb_path(settings);
    let target = resolve_disconnect_target(&adb, serial.trim())?;
    run_adb_command_result(&adb, &["disconnect", target.as_str()])
}

fn restart_adb_server(settings: &PersistedSettings) -> Result<CommandResult, String> {
    let adb = resolve_adb_path(settings);
    let kill = run_adb_command_result(&adb, &["kill-server"])?;
    let start = run_adb_command_result(&adb, &["start-server"])?;
    Ok(CommandResult {
        success: kill.success && start.success,
        message: "ADB server 已重启".to_string(),
        raw_output: format!("{}\n{}", kill.raw_output, start.raw_output),
    })
}

fn discover_wireless_candidates() -> Vec<WirelessCandidate> {
    let mut candidates = Vec::new();
    let Some(local_ip) = local_ipv4() else {
        return candidates;
    };

    let octets = local_ip.octets();
    for host in 1..=254_u8 {
        if host == octets[3] {
            continue;
        }

        let ip = Ipv4Addr::new(octets[0], octets[1], octets[2], host);
        for port in [5555_u16, 37099_u16] {
            let socket = SocketAddr::new(IpAddr::V4(ip), port);
            if TcpStream::connect_timeout(&socket, Duration::from_millis(35)).is_ok() {
                candidates.push(WirelessCandidate {
                    address: format!("{}:{}", ip, port),
                    source: "局域网端口探测".to_string(),
                    confidence: if port == 5555 { "高" } else { "中" }.to_string(),
                });
            }
        }
    }

    candidates
}

fn resolve_adb_path(settings: &PersistedSettings) -> String {
    if let Some(path) = settings
        .adb_path
        .as_ref()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        return path.to_string();
    }

    find_adb_in_common_locations().unwrap_or_else(|| "adb".to_string())
}

fn adb_source(settings: &PersistedSettings, path: &str) -> String {
    if settings.adb_path.as_deref() == Some(path) {
        "手动指定".to_string()
    } else if path == "adb" {
        "系统 PATH".to_string()
    } else {
        "自动发现".to_string()
    }
}

fn find_adb_in_common_locations() -> Option<String> {
    let mut candidates = vec![
        "/opt/homebrew/bin/adb".to_string(),
        "/usr/local/bin/adb".to_string(),
        "/opt/android-sdk/platform-tools/adb".to_string(),
    ];

    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join("Library/Android/sdk/platform-tools/adb")
                .to_string_lossy()
                .to_string(),
        );
        candidates.push(
            home.join("Android/Sdk/platform-tools/adb")
                .to_string_lossy()
                .to_string(),
        );
    }

    candidates
        .into_iter()
        .find(|path| Path::new(path).is_file())
}

fn settings_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "无法读取系统配置目录".to_string())?;
    Ok(base.join("adb-connect-electron").join("settings.json"))
}

fn load_settings() -> PersistedSettings {
    let Ok(path) = settings_path() else {
        return PersistedSettings::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return PersistedSettings::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_settings(settings: &PersistedSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{}", error))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("无法序列化设置：{}", error))?;
    fs::write(path, content).map_err(|error| format!("无法保存设置：{}", error))
}

fn run_adb_command_result(adb: &str, args: &[&str]) -> Result<CommandResult, String> {
    match run_adb_with_path(adb, args) {
        Ok(output) => Ok(CommandResult {
            success: true,
            message: human_success_message(args, &output),
            raw_output: output,
        }),
        Err(error) => Ok(CommandResult {
            success: false,
            message: human_error_message(&error),
            raw_output: error,
        }),
    }
}

fn run_adb_with_path(adb: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(adb)
        .args(args)
        .output()
        .map_err(|error| format!("无法执行 adb：{}", error))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = [stdout.as_str(), stderr.as_str()]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");

    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err("adb 命令执行失败".to_string())
    } else {
        Err(combined)
    }
}

fn parse_devices(output: &str) -> Vec<Device> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }

            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next().unwrap_or("unknown").to_string();
            let mut model = None;
            let mut product = None;

            for part in parts {
                if let Some(value) = part.strip_prefix("model:") {
                    model = Some(value.to_string());
                } else if let Some(value) = part.strip_prefix("product:") {
                    product = Some(value.to_string());
                }
            }

            let transport = detect_transport(&serial).to_string();
            let display_name = model
                .clone()
                .or_else(|| product.clone())
                .unwrap_or_else(|| serial.clone());

            Some(Device {
                serial,
                state,
                model,
                product,
                transport,
                display_name,
            })
        })
        .collect()
}

fn detect_transport(serial: &str) -> &'static str {
    let lower = serial.to_lowercase();
    if lower.contains(':')
        || lower.starts_with("adb-")
        || lower.contains("_adb-tls-connect._tcp")
        || lower.contains("_adb-tls-pairing._tcp")
    {
        "wireless"
    } else {
        "usb"
    }
}

fn is_mdns_wireless_serial(serial: &str) -> bool {
    let lower = serial.to_lowercase();
    lower.starts_with("adb-")
        || lower.contains("_adb-tls-connect._tcp")
        || lower.contains("_adb-tls-pairing._tcp")
}

fn resolve_disconnect_target(adb: &str, serial: &str) -> Result<String, String> {
    if !is_mdns_wireless_serial(serial) {
        return Ok(serial.to_string());
    }

    let guid = mdns_guid(serial);
    let output = run_adb_with_path(adb, &["devices", "-l"])?;
    let Some(target) = parse_devices(&output)
        .into_iter()
        .find(|device| device.serial.contains(':') && guid.as_ref().is_some_and(|id| device.serial.contains(id)))
        .map(|device| device.serial) else {
        return Err("无法从 mDNS 设备名解析精确断开地址，请先刷新设备列表或使用 adb disconnect <IP:端口>".to_string());
    };

    Ok(target)
}

fn mdns_guid(serial: &str) -> Option<String> {
    let without_prefix = serial.strip_prefix("adb-").unwrap_or(serial);
    let before_service = without_prefix
        .split("._adb-tls-connect._tcp")
        .next()
        .unwrap_or(without_prefix)
        .split("._adb-tls-pairing._tcp")
        .next()
        .unwrap_or(without_prefix);
    before_service
        .split('-')
        .next()
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn random_pairing_string(length: usize) -> Result<String, String> {
    const CHARSET: &[u8] =
        b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-+*/<>{}";
    let mut bytes = vec![0_u8; length];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法生成二维码配对随机串：{}", error))?;

    Ok(bytes
        .into_iter()
        .map(|byte| CHARSET[byte as usize % CHARSET.len()] as char)
        .collect())
}

fn create_qr_pairing_string(service_name: &str, password: &str) -> String {
    format!("WIFI:T:ADB;S:{};P:{};;", service_name, password)
}

fn parse_mdns_pairing_services(output: &str) -> Vec<MdnsPairingService> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with("List of discovered")
                || line.starts_with("Service")
                || line.starts_with('*')
            {
                return None;
            }

            let columns = line.split_whitespace().collect::<Vec<_>>();
            let service_type_index = columns
                .iter()
                .position(|column| column.contains("_adb-tls-pairing._tcp"))?;
            let service_name = columns[..service_type_index].join(" ");
            let service_type = columns[service_type_index].to_string();
            let address = columns[service_type_index + 1..]
                .iter()
                .find(|column| column.contains(':'))?
                .trim_matches(',')
                .to_string();

            Some(MdnsPairingService {
                service_name,
                address,
                service_type,
            })
        })
        .collect()
}

fn parse_mdns_connect_services(output: &str) -> Vec<MdnsConnectService> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with("List of discovered")
                || line.starts_with("Service")
                || line.starts_with('*')
            {
                return None;
            }

            let columns = line.split_whitespace().collect::<Vec<_>>();
            let service_type_index = columns
                .iter()
                .position(|column| column.contains("_adb-tls-connect._tcp"))?;
            let service_name = columns[..service_type_index].join(" ");
            let service_type = columns[service_type_index].to_string();
            let address = columns[service_type_index + 1..]
                .iter()
                .find(|column| column.contains(':'))?
                .trim_matches(',')
                .to_string();

            Some(MdnsConnectService {
                service_name,
                address,
                service_type,
            })
        })
        .collect()
}

fn find_mdns_connect_service<'a>(
    services: &'a [MdnsConnectService],
    serial: &str,
) -> Option<&'a MdnsConnectService> {
    let guid = mdns_guid(serial)?;
    services
        .iter()
        .find(|service| service.service_name.contains(&guid) || serial.contains(&service.service_name))
}

fn find_qr_pairing_service<'a>(
    services: &'a [MdnsPairingService],
    service_name: &str,
) -> Option<&'a MdnsPairingService> {
    let token = service_name.trim_start_matches("studio-");
    services.iter().find(|service| {
        service.service_name.starts_with("studio-")
            && (service.service_name == service_name || service.service_name.contains(token))
    })
}

fn normalize_address(address: &str, default_port: u16) -> Result<String, String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("请输入设备地址".to_string());
    }

    if trimmed.contains(':') {
        return Ok(trimmed.to_string());
    }

    if default_port == 0 {
        return Err("请输入包含端口的地址".to_string());
    }

    Ok(format!("{}:{}", trimmed, default_port))
}

fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

fn human_success_message(args: &[&str], output: &str) -> String {
    if args.first() == Some(&"connect") {
        return output.lines().next().unwrap_or("无线设备连接命令已执行").to_string();
    }

    if args.first() == Some(&"pair") {
        return output.lines().next().unwrap_or("无线调试配对命令已执行").to_string();
    }

    if args.first() == Some(&"disconnect") {
        return output.lines().next().unwrap_or("设备断开命令已执行").to_string();
    }

    "命令执行成功".to_string()
}

fn human_error_message(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("not found") || lower.contains("no such file") || lower.contains("无法执行 adb") {
        "未找到 adb，请检查 adb 路径".to_string()
    } else if lower.contains("unauthorized") {
        "设备未授权，请在手机上允许 USB 调试".to_string()
    } else if lower.contains("refused") || lower.contains("timed out") || lower.contains("unable to connect") {
        "无法连接设备，请确认 IP、端口和同一局域网状态".to_string()
    } else if lower.contains("pair") || lower.contains("code") {
        "无线配对失败，请确认配对端口和配对码".to_string()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_qr_pairing_string, detect_transport, find_mdns_connect_service,
        find_qr_pairing_service, mdns_guid, parse_devices, parse_mdns_connect_services,
        parse_mdns_pairing_services, resolve_disconnect_target,
    };

    #[test]
    fn detects_classic_tcp_devices_as_wireless() {
        assert_eq!(detect_transport("192.168.1.23:5555"), "wireless");
    }

    #[test]
    fn detects_android_wireless_debugging_mdns_devices_as_wireless() {
        assert_eq!(
            detect_transport("adb-10CECK0QZ1000N0-UI44fA._adb-tls-connect._tcp"),
            "wireless"
        );
    }

    #[test]
    fn detects_usb_serials_as_usb() {
        assert_eq!(detect_transport("10CECK0QZ1000N0"), "usb");
    }

    #[test]
    fn parses_mdns_wireless_device_transport() {
        let output = "\
List of devices attached
adb-10CECK0QZ1000N0-UI44fA._adb-tls-connect._tcp device product:PD2425 model:V2425A
";

        let devices = parse_devices(output);

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].transport, "wireless");
        assert_eq!(devices[0].display_name, "V2425A");
    }

    #[test]
    fn parses_guid_from_mdns_wireless_serial() {
        assert_eq!(
            mdns_guid("adb-10CECK0QZ1000N0-UI44fA._adb-tls-connect._tcp"),
            Some("10CECK0QZ1000N0".to_string())
        );
    }

    #[test]
    fn disconnects_classic_tcp_devices_by_address() {
        assert_eq!(
            resolve_disconnect_target("adb", "192.168.1.23:5555").unwrap(),
            "192.168.1.23:5555"
        );
    }

    #[test]
    fn creates_android_studio_compatible_qr_pairing_string() {
        assert_eq!(
            create_qr_pairing_string("studio-AbCd123456", "Pass12345678"),
            "WIFI:T:ADB;S:studio-AbCd123456;P:Pass12345678;;"
        );
    }

    #[test]
    fn parses_mdns_pairing_services() {
        let output = "\
List of discovered mdns services
studio-AbCd123456-abc _adb-tls-pairing._tcp. 192.168.1.23:37123
adb-10CECK0QZ1000N0-UI44fA _adb-tls-connect._tcp. 192.168.1.23:41687
";

        let services = parse_mdns_pairing_services(output);

        assert_eq!(services.len(), 1);
        assert_eq!(services[0].service_name, "studio-AbCd123456-abc");
        assert_eq!(services[0].address, "192.168.1.23:37123");
    }

    #[test]
    fn parses_and_finds_mdns_connect_services() {
        let output = "\
List of discovered mdns services
adb-JVBE8LNFFQ8XWWRO-J71Uax _adb-tls-connect._tcp. 192.168.31.172:39385
";

        let services = parse_mdns_connect_services(output);
        let service =
            find_mdns_connect_service(&services, "adb-JVBE8LNFFQ8XWWRO-J71Uax._adb-tls-connect._tcp")
                .unwrap();

        assert_eq!(services.len(), 1);
        assert_eq!(service.address, "192.168.31.172:39385");
    }

    #[test]
    fn finds_qr_pairing_service_by_studio_token() {
        let output = "\
List of discovered mdns services
studio-AbCd123456-abc _adb-tls-pairing._tcp. 192.168.1.23:37123
";
        let services = parse_mdns_pairing_services(output);

        let service = find_qr_pairing_service(&services, "studio-AbCd123456").unwrap();

        assert_eq!(service.address, "192.168.1.23:37123");
    }
}
