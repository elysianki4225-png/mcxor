# MCXOR · 网易我的世界存档加密解密工具 (PWA)

> 基于 [HTMonkeyG/XOR-MC-Archive-Decrypt](https://github.com/HTMonkeyG/XOR-MC-Archive-Decrypt) 核心算法构建的纯前端本地化、响应式 **Material Design 3** 网易《我的世界》(Minecraft) 存档加密与解密渐进式 Web 应用 (PWA)。

## 🌐 在线体验地址 (GitHub Pages)

- **立即在线访问**：**[https://elysianki4225-png.github.io/mcxor/](https://elysianki4225-png.github.io/mcxor/)**
- **仓库主页**：[https://github.com/elysianki4225-png/mcxor](https://github.com/elysianki4225-png/mcxor)

> 所有文件读取、密钥推导、加解密与重新打包均 **100% 在您设备本地浏览器的独立 Web Worker 线程中完成**，存档文件绝不会上传至任何服务器；首次访问后支持一键安装至桌面或手机主屏幕，断网亦可离线使用。

---

## ✨ 核心特性

- **Material Design 3 响应式界面**：遵循 Google Material You 设计规范，支持 **自动跟随系统 / 浅色模式 / 深色模式** 无闪烁切换，完美适配手机、平板与大屏桌面。
- **完整 PWA 离线支持**：内置 `manifest.webmanifest` 与作用域自适应 Service Worker，支持安装到桌面/主屏、离线运行、自动清理旧版缓存及桌面文件关联打开。
- **零内存泄露 & 超大存档不卡死**：
  - 采用基于 `Blob.slice()` 的 **随机切片 ZIP32/ZIP64 中央目录读取器** 与 **零拷贝流式打包器**（未修改的资源文件直接切片透传，无需解压重压）。
  - 核心计算全部运行于独立 **Web Worker**，主界面保持 60fps 流畅响应，支持随时中止任务。
  - 内置 `MemoryGuard` 句柄守卫，自动追踪并在切换存档、重置会话或离开页面时调用 `URL.revokeObjectURL()` 释放缓存句柄，并提供顶部实时内存状态栏与一键释放按钮。
- **三阶段独立实时进度条**：
  1. **① 上传与存档解析进度条**：实时显示分片读取字节数、MB/s 吞吐速度与扫描进度。
  2. **② 数据库文件加解密进度条**：逐文件展示 `db/` 核心文件处理计数与当前文件名。
  3. **③ 归档打包与下载准备进度条**：实时展示输出流打包条目、体积并自动触发下载。
- **64-bit 密钥检视器**：
  - 自动从 `CURRENT ⊕ MANIFEST-*` 或 `.ldb` 表尾魔数交叉推导 8 字节循环异或密钥。
  - 实时直观展示 **十六进制密钥 (`0x...`)**、**8 字节分布卡片**、**ASCII 字符预览** 与 **加密头魔数 (`0x801D3001`)**，支持一键复制或一键回填至主动加密。
- **多格式读取 & 8 项存档完整性验证**：
  - 支持 `.zip`、`.mcworld`、`.mctemplate`、`.mcaddon`、`.mcpack`、**直接拖拽/选择存档文件夹** 及散装数据库文件，自动兼容 Windows 中文 **GBK / GB18030** 与 UTF-8 路径。
  - 自动核验 `level.dat`（基岩版 NBT 头部与版本长度校验 / Java 版误传识别）、`db/` 目录、`db/CURRENT`（含 80 字节资源中心二次加密预警）、`db/MANIFEST-*`、CRC32 数据块校验、`netease_config` 兼容性提示，并在解密后对全部 `.ldb` 文件执行 **LevelDB 表尾 64-bit 魔数 (`0x57FB808B247547DB`) 合理性校验 (`avalTest`)**。

---

## 🚀 自建服务器一键部署（支持自定义域名 / 无域名 `nip.io` 免费证书）

仓库内置开箱即用的生产级一键部署脚本 [`deploy.sh`](./deploy.sh)、[`Dockerfile`](./Dockerfile) 与 [`docker-compose.yml`](./docker-compose.yml)，基于 Caddy 2 自动管理 HTTPS 证书（内置 Let's Encrypt + ZeroSSL 双重自动备援，彻底解决共享域名限流问题，确保 HTTPS 环境下完整开启 PWA 离线功能）。

### 方式一：没有域名（自动检测公网 IP 并签发 `<公网IP>.nip.io` 免费 HTTPS 证书）

只需一台开放了 TCP/UDP `80` 与 `443` 端口的 Linux 云服务器，无需购买或解析任何域名：

```bash
curl -fsSL https://raw.githubusercontent.com/elysianki4225-png/mcxor/main/deploy.sh | sudo bash -s -- --nip
```

> 若服务器位于多层 NAT 后，也可手动指定公网 IP：
> ```bash
> curl -fsSL https://raw.githubusercontent.com/elysianki4225-png/mcxor/main/deploy.sh | sudo bash -s -- --nip --ip 203.0.113.10
> ```
> 部署完成后可直接通过 `https://203.0.113.10.nip.io` 安全访问并安装 PWA！

### 方式二：拥有自己的域名（自动签发域名 HTTPS 证书并自动续期）

先将您的域名（如 `mc.example.com`）A 记录解析到服务器公网 IP，然后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/elysianki4225-png/mcxor/main/deploy.sh | sudo bash -s -- --domain mc.example.com
```

### 方式三：交互式向导或 Docker Compose 部署

```bash
git clone https://github.com/elysianki4225-png/mcxor.git
cd mcxor

# 交互式菜单（可自由选择自有域名或 nip.io 免域名证书）
sudo ./deploy.sh

# 或强制指定 Docker Compose 模式 + nip.io 证书
sudo ./deploy.sh --mode docker --nip
```

---

## 🛠️ 本地开发与自动化测试

本项目采用零构建依赖的现代原生 ES Modules 架构，克隆后即可直接运行：

```bash
# 启动本地开发预览服务器 (默认监听 http://0.0.0.0:3000)
npm start

# 运行完整自动化测试套件（加解密算法、密钥推导、40MB 大存档流式压测、零内存泄露校验、PWA 资源核验）
npm test
```

---

## 📜 致谢与开源协议

- 核心异或加解密算法与完整性测试规范源自 [HTMonkeyG/XOR-MC-Archive-Decrypt](https://github.com/HTMonkeyG/XOR-MC-Archive-Decrypt) (MIT License)。
- ZIP DEFLATE 编解码采用轻量级开源库 [fflate](https://github.com/101arrowz/fflate) (MIT License)。
- 本项目基于 [MIT License](./LICENSE) 开源。
