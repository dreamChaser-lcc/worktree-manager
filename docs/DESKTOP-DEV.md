# 桌面端开发环境搭建（Electron + Rust/Tauri）

> 2026-11-01 留档：Rust 全套曾因装到 C 盘被整体卸载（释放约 6.9GB）。**重新启用 Tauri 前务必按本文档先设环境变量再安装**，避免重蹈覆辙。

## 结论速览

| 阶段 | 需要 Rust 吗 | 需要 MSVC C++ 生成工具吗 |
|---|---|---|
| Electron 一期（内嵌 Koa 服务） | ❌ 不需要，Node ≥ 18 即可 | ❌ 不需要 |
| Tauri 二期（Rust sidecar） | ✅ 需要 | ✅ 需要（链接器） |

## Rust 安装（关键：先设环境变量再安装，才能落到 D 盘）

1. 新建系统环境变量（PowerShell 管理员）：

```powershell
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', 'D:\rust\rustup', 'Machine')
[Environment]::SetEnvironmentVariable('CARGO_HOME',  'D:\rust\cargo',  'Machine')
[Environment]::SetEnvironmentVariable('Path', $env:Path + ';D:\rust\cargo\bin', 'Machine')
```

2. 官网下载 `rustup-init.exe` 直接执行——它会读取上面的变量，工具链全部装入 D 盘
3. 组件选择默认 `stable-x86_64-pc-windows-msvc`
4. 重开终端验证：`cargo --version`、`rustc --version`

## MSVC C++ 生成工具（注意：只能装 C 盘，无法选路径）

- 下载 Visual Studio Build Tools 引导器，勾选「使用 C++ 的桌面开发」
- 占用约 3.5GB（BuildTools）+ 1.7GB（Windows Kits），固定写入 `C:\Program Files (x86)\`
- 这是微软安装器的限制，没有官方迁移动作；C 盘空间紧张时提前规划

## Tauri 项目运行与构建

```powershell
cd desktop-tauri
npm install
npm run tauri:dev      # 开发调试（按 package.json 实际脚本为准）
npm run tauri:build    # 产出安装包
```

- 构建产物 `src-tauri/target\` 很大（本次实测 4.2GB），暂时不用 Rust 时可整目录删除，下次构建自动重建
- Windows 下首次构建会编译数百个 crate，耗时数分钟属正常

## 卸载方法（本次执行过，留档备查）

```powershell
# 1) 卸载 Rust 工具链（连带删除 .cargo / .rustup，并清理 PATH）
& "$env:USERPROFILE\.cargo\bin\rustup.exe" self uninstall -y

# 2) 卸载 VS Build Tools（必须"从一开始就提权"运行，否则报 Exit Code 5007 静默退出；
#    屏幕会弹 UAC，请点"是"；进度条走完约 2-5 分钟）
Start-Process -FilePath "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" -Verb RunAs -ArgumentList 'uninstall','--installPath','C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools','--passive','--norestart'

# 3) 残留清理：VS Installer 共享组件（约 142MB）与空目录壳属正常残留，可保留
```
