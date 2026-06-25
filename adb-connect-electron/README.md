# ADB Connect Electron

Electron shell + React TypeScript UI + Rust ADB service.

## 结构

- `electron/`: Electron main process 和 preload IPC。
- `src/`: React + TypeScript 用户界面。
- `native-adb/`: Rust CLI 服务，负责执行 adb、解析设备、无线连接、配对和发现。

## 常用命令

```bash
npm install
npm run test:native
npm run build
npm run dev
```

`npm run dev` 会启动 Vite、编译 Rust 服务，并打开 Electron 窗口。

## 说明

- UI 通过 `window.adbNative.run(...)` 调用 Electron IPC。
- Electron 主进程启动 Rust 二进制，并用 stdin/stdout 传递 JSON。
- Rust 服务默认使用系统 PATH 中的 `adb`，也可以在设置页保存自定义 adb 路径。
