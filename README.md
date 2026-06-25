# ADB Connect

ADB Connect 是一个用于管理 ADB 设备连接的桌面 GUI。

## 项目结构

1. `adb-connect-electron/`

当前主要版本。

- Electron 驱动桌面窗口。
- React + TypeScript 构建用户界面。
- Rust CLI 服务负责执行 adb、解析设备、无线连接、配对和 mDNS 发现。

2. 根目录 Tauri 版本

早期 Tauri + React 实现，保留作为历史版本。

## 主要功能

1. 实时设备列表

- 自动刷新 `adb devices -l`。
- 显示 USB / 无线连接方式。
- 显示在线、离线、未授权等状态。

2. 无线连接

- 支持输入 `IP:端口` 执行 `adb connect`。
- 未填写端口时默认使用 `5555`。
- 支持断开真实 `IP:端口` 无线连接。

3. Android 11+ 无线调试配对

- 支持配对码配对。
- 支持二维码配对。
- 支持 mDNS `_adb-tls-connect._tcp` 服务解析后连接。

4. 自动发现

- 扫描当前局域网常见 ADB 端口。
- 发现结果作为候选展示，需要用户点击后才会连接。

5. ADB 设置和日志

- 默认使用系统 PATH 中的 `adb`。
- 支持手动指定 adb 路径。
- 记录最近 80 条操作日志。

## Electron 版本开发命令

```bash
cd adb-connect-electron
npm install
npm run build
npm run test:native
npm run dev
```

## Tauri 版本开发命令

```bash
npm install
npm run build
npm run tauri dev
```
