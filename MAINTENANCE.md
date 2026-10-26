# MarkdownX 维护手册

面向"接手/续做这个项目的人（或 AI）"的操作文档。README 讲**功能与历史**，本手册讲**怎么改、怎么验证、怎么发版**，
以及**哪些坑真的踩过、哪些结论真的验证过**。

> 对应版本：v2.6.0（2026-10-18）。每条操作都来自本项目的实际执行记录，不是推测。
>
> **2026-10-20 补**：本机 profile 重装后工具链被清空，补上「已有什么 / 还缺什么 / 怎么装」的基线核实
> （§1.6，至此本机重新具备桌面打包与 Android 构建的前提）；另记录一条会**静默误判成"项目坏了"**的坑 ——
> UNC 当前目录会让 `npm`/`npx` 在 `C:\Windows` 里执行（§1.5 事实 6）。

---

## 1. 三分钟上手

**工作目录**：`Z:\MarkDownX_app`（NAS 上的唯一真源；本地副本已废弃，见 §1.5）。

> **本手册里所有命令都用「仓库相对路径」**（`scripts/…`、`src-tauri/…`、`tools/…`），
> 因此**在原仓库或任意一份本地 clone 里都原样可用** ✓。只有三类路径是绝对的、且必须显式给出：
> **签名私钥**（`TAURI_SIGNING_PRIVATE_KEY_PATH`）、**Android SDK/JDK**（§13）、以及 **NAS 本身**（§1.5）。
> 注意 **不要**把 `/tmp`、`$HOME` 这类 MSYS 路径传给原生程序（`git`/`curl`/`robocopy`）——本 shell
> 关闭了路径转换，会静默走错地方；要用 `C:/…` 或仓库相对路径（§8 有这条坑的原始记录）。

```bash
npm ci                      # 首次：按 lock 精确安装（postinstall 会拷 MathJax / PDF.js 离线资源）
npm run dev                 # 只跑前端热更（调 UI 时用这个，不碰 Rust）
npm run tauri dev           # 完整桌面应用（首次 Rust 编译较慢，之后是增量）
```

**改动后必过的三道门**（缺一不可）：

```bash
npx tsc --noEmit                              # ① 类型检查
npm run test                                  # ② 单测（vitest）
node tools/render-equivalence-gate/gate.cjs   # ③ 渲染等价护栏
# ③ 的判据只有两行，必须是这样：
#   PASS 6/6 documents equivalent
#   PASS line-ending equivalence 6/6
```

> ⚠️ **判据只认脚本自己的那两行结论，不要去数 PASS 行数** —— 数行数会在断言段变化时给出错误的
> "通过"（真的犯过一次，见 §8.6）。

**动了渲染器就多一步**：护栏里有黄金文件契约 —— 输出变了，要么把行为改回去，要么**逐字符审查差异后
带着理由重新生成黄金**（见 §9.5）。

打包（Windows，签名私钥在仓库之外）：

```bash
export TAURI_SIGNING_PRIVATE_KEY="Z:/MarkDownX-keys/markdownx-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build          # 缺私钥则不会产出 .sig，自动升级即失效
```

---

## 1.5 环境与工作目录（NAS）

| 项 | 位置 / 说明 |
|---|---|
| **唯一真源** | `Z:\MarkDownX_app`（NAS 共享；本地 `C:\Users\callyli00\Documents\MarkdownX-v1.6.0-Source` 已废弃删除）|
| 远端 | `https://github.com/callyli00/MarkdownX`（`origin`）|
| 分支语义 | `main` = 桌面发布线（**发版从这里出**）；`feat/android-port` = Android 线（含移动端外壳与 Android 构建配置）|
| 签名私钥 | `Z:\MarkDownX-keys\markdownx-updater.key`（**仓库之外**，git 看不到；`tauri.conf.json` 里只有公钥）|
| 版本号来源 | `package.json` 的 `version` 是唯一权威，其余 5 处要同步（§3）|

### NAS 上必须知道的环境事实（不知道会误以为"项目坏了"）

> 先记住分工：**NAS 是唯一真源与协作点（一切以 git 提交为准）**；而**重工具链要在本地盘的一次
> clone 里运行** —— 下面 1~3 条说明 git 与环境，4~6 条说明为什么"离开网络盘"这条边界比看上去更宽。

1. **git 会拒绝操作**：SMB 共享里文件属主是 NAS 自己的账户，git 报 `detected dubious ownership`。
   在**每一台**访问这份副本的机器上各执行一次（限定路径，不要用 `*`）：
   ```bash
   git config --global --add safe.directory 'Z:/MarkDownX_app'
   # 若用 UNC 路径（脚本内部可能用），再加一条：
   git config --global --add safe.directory '%(prefix)///192.168.5.51/personal_folder/MarkDownX_app'
   ```
2. **首次构建慢是正常的**：`node_modules`、`src-tauri/target`、`src-tauri/gen/**/build` 都是可再生成的，
   迁移时被有意排除 → Rust 首次全量构建约 10 分钟，Android 首次同理，第二次起才有缓存。
3. **Windows 的 git TLS 可能握手失败**：症状是 `schannel: failed to receive handshake, SSL/TLS connection failed`
   （而同一台机器上 `curl https://github.com` 却正常）。切到 Git for Windows 自带的 OpenSSL 后端即可：
   ```bash
   git config --global http.sslBackend openssl     # 需要改回时设回 schannel
   ```
4. **`vite dev` 不要跑在网络盘上**（2026-10-18 实测）：从 NAS 启动，**120 秒仍未就绪** ——
   dev server 要遍历 `node_modules` 的十几万个小文件走 SMB。**要看界面就把仓库 clone 到本地盘再跑。**
5. **Android 构建无法在网络盘上进行**（同次实测）：`npx tauri android build` 在 NAS 路径上 3 秒内 panic ——
   `AssetDirOutsideOfAppRoot { asset_dir: "assets", root_dir: "Z:\\…\\src-tauri" }`；
   改成 UNC 路径同样 panic（`helpers\\app_paths.rs:140`），所以不是盘符形式问题，是 Tauri CLI 的路径解析
   不支持网络路径。**Android 打包必须在本地盘的 clone 里做。**
   （**桌面**构建不受影响：同一份仓库在 NAS 上成功产出了 v2.6.0 的 NSIS 安装包与签名。）
6. **UNC 当前目录会让 `npm`/`npx` 跑到 `C:\Windows` 去执行**（2026-10-20 实测，且**不报路径错误**）：
   `cmd.exe` 不支持 UNC 作为当前目录，会打印
   `CMD.EXE was started with the above path as the current directory. UNC paths are not supported.
   Defaulting to Windows directory.` 然后在 `C:\Windows` 里跑。两个现场：
   - `npx tsc --noEmit` → 打印 tsc 的**帮助文本**（找不到 tsconfig），exit 1；
   - `npm run test` → `RUN v2.1.9 C:/Windows`，随后 `EPERM: operation not permitted, scandir 'C:\Windows\CSC'`，exit 1。
   两者都看起来像"项目坏了"，实际是工作目录错了。**直接 `node` 跑脚本不受影响** ——
   同一时刻 `node tools/render-equivalence-gate/gate.cjs` 在 UNC 下仍然 `PASS 6/6 + 6/6`。
   → 凡是要经 cmd 的命令（`npm` / `npx` / `tauri`）都把工作目录设成**盘符路径** `Z:\MarkDownX_app`，
   或 `cd` 进本地 clone。自查：`(Get-Location).Path` 应以 `Z:\` 开头，而不是 `\\`。
7. **`npx tauri info` 在网络盘上会挂起**（2026-10-20 实测，**装上 Rust 之后**才出现）：
   未装 Rust 时它只读 `Cargo.lock`，秒回；装上 Rust 后它要解析 cargo 元数据，从 `Z:\MarkDownX_app`
   跑超过 10 分钟无输出（连续两次只在被强杀前才结束）。同一份仓库在本地 clone 里 **120 秒内**返回、
   `Environment` 段全 ✔。→ 查环境这一项请在本地 clone 里做，别把挂起当成"工具链坏了"。

### 因此的分工（均已实测）

| 用途 | 放在哪 | 依据 |
|---|---|---|
| 唯一真源 / 协作 / 归档 | **NAS `Z:\MarkDownX_app`** | 一切以 git 为准；本手册命令皆为仓库相对路径，在 clone 里同样可用 |
| `vite dev`（要看界面时） | **本地盘的 clone** | 网络盘上 120 秒仍未就绪（事实 4）|
| Android 打包 | **本地盘的 clone** | 网络盘上 3 秒 panic（事实 5）|
| 桌面发版构建 / 发布脚本 | 两边皆可 | NAS 上已验证可行（会慢一些）|

本地工作区示例（可随时删，仅用于构建）：
```bash
git clone -b feat/android-port https://github.com/callyli00/MarkdownX.git C:/Users/<user>/mrx-android-build
cd C:/Users/<user>/mrx-android-build && npm ci && npx tauri android build --apk --target aarch64
```
> 附带好处：**用全新 clone 构建，等于同时验证了"推上去的分支能被独立构建成功"** ✓。

### 1.6 本机构建工具链基线（2026-10-20 重装后重新核实）

> **为什么要有这一节**：2026-10-18 那次 v2.6.0 打包之后，本机用户 profile 被重装，
> `~\.rustup`、`~\.cargo`、`~\.tauri` **都已不存在**，而 `src-tauri/target/release/` 里仍留着
> 24.8 MB 的 `markdown-x.exe` 和签名好的安装包 —— 极易误判成"工具链还在"。重建时照本节做。

**已核实无需安装**（2026-10-20 本机实测，不是推测）：

| 组件 | 实测版本 | 核实方式 |
|---|---|---|
| Visual Studio Enterprise 2022 | `17.14.36915.13`，MSVC `14.44.35207`，`cl` 19.44.35222 | `vswhere -all -products * -format json`；直接执行 `VC\Tools\MSVC\<ver>\bin\Hostx64\x64\cl.exe` |
| Windows SDK | `10.0.26100.0` | `C:\Program Files (x86)\Windows Kits\10\lib` |
| Node.js / npm | `v24.16.0` / `11.17.0` | `node -v` / `npm -v` |
| WebView2 运行时 | `155.0.4283.62` | 注册表 `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv` |

**结论：C++ 侧完整，唯一需要管理员的那一步可以跳过**；下面三样均为**用户级安装**：

| 项 | 版本（钉死依据） | 装法 |
|---|---|---|
| Rust | stable **msvc** 工具链；上次成功构建是 `rustc 1.98.1`（证据：`src-tauri/target/.rustc_info.json`）| `rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-msvc --profile default`，再 `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`（§13.5）|
| JDK | **21 LTS** | `aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip` → `%LOCALAPPDATA%\Java`。依据：wrapper 钉 Gradle **9.6.1** + AGP **9.3.1** + `jvmTarget = JVM_1_8` → JDK 17+ 即可；Tauri 的 `gradle_max_supported_java("9.6.1") = 26` 给出上界。原 Android Studio 自带 jbr 是 25.0.3，也可用。**解压后的目录名形如 `jdk-21.0.12.1+1`** —— `JAVA_HOME` 要指向这个目录，不是 zip 文件名 |
| Android SDK | cmdline-tools **23.0**（`commandlinetools-win-16111833_latest.zip`，解压后**必须**是 `cmdline-tools\latest`）+ `platforms;android-36`、`platforms;android-37.0`、`build-tools;36.0.0`、`platform-tools`、`ndk;30.0.16248370` | 版本从 `dl.google.com/android/repository/repository2-3.xml` 查得；`ndk` 与两个 `compileSdk` 取自 `gen/android/app/build.gradle.kts` 与 `:tauri-android`（§13.6.2 第 2 条：**36 和 37 都要**）。⚠️ **没有裸的 `platforms;android-37`** —— 官方只发 `37.0` / `37.1` / `37.2`（2026-10-20 实测：`sdkmanager "platforms;android-37"` 打印 `Package platforms/android-37 not found.` 却**仍然 exit 0**，极易漏装）|

环境变量（用户级）：`JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME = %ANDROID_HOME%\ndk\30.0.16248370`；
PATH 追加 `%USERPROFILE%\.cargo\bin`、`%ANDROID_HOME%\cmdline-tools\latest\bin`、`%ANDROID_HOME%\platform-tools`。
**注册表里新设的变量当前 shell 继承不到**（同 §13.1），装完要新开进程。
（不要把 PATH 用 `setx PATH` 写，它会截断到 1024 字符；用 `[Environment]::SetEnvironmentVariable('Path', …,'User')`。）

两个一次性前提：

1. **开发者模式必须开**（§13.6.1）：否则 Android 构建卡在 `.so` 的符号链接那一步，报
   `Creation symbolic link is not allowed for this system`。
2. **签名私钥要回填**：默认路径 `~\.tauri\markdownx-updater.key` 已随 profile 重装丢失，从
   `Z:\MarkDownX-keys\markdownx-updater.key` 复制回去（或发版时显式给 `TAURI_SIGNING_PRIVATE_KEY_PATH`，见 §4）。

**装完后的验收顺序**（顺序本身是有原因的，见下条注）：

```powershell
cd Z:\MarkDownX_app                      # 必须盘符路径；UNC 会让 npm/npx 跑到 C:\Windows（§1.5 事实 6）
npx tauri info                           # 期望 rustc / Cargo / rustup 三项从 ✘ 变 ✔
cd src-tauri; cargo fetch; cd ..          # 干净机器必需：否则下一步报 no cargo registry sources
python tools/android-codegen.py          # 补两个 codegen 产物（幂等）
npm run tauri build                      # 验收：NSIS 安装包 + .sig
npx tauri android build --apk --target aarch64
```

> `cargo fetch` 那一步是 2026-10-20 实测出来的：`android-codegen.py` 从 cargo registry 的
> `tauri-2.12.1/mobile/` 取模板，而全新机器上 `~\.cargo\registry\src` 还不存在 —— 直接跑脚本会
> 以 `no cargo registry sources` 退出，看起来像"脚本坏了"。详见 §13.8。

**验证状态（2026-10-20 当天实测结果）**：

| 验收项 | 结果 | 证据 |
|---|---|---|
| `npx tauri info` 环境段 | ✅ 全 ✔ | `rustc 1.99.1 (58cf8f9c3)`、`cargo 1.99.1`、`rustup 1.29.1`、`MSVC: Visual Studio Enterprise 2022`、`WebView2 155.0.4283.62`。**注意：要在本地 clone 里跑** —— 装上 Rust 后它要解析 cargo 元数据，从网络盘跑会挂起 >10 分钟（两次实测），本地盘 120s 内返回 |
| 桌面 `npm run tauri build` | ✅ | 7.6 分钟（首次全量编译）；产物 `MarkdownX_2.6.0_x64-setup.exe` **12.78 MiB** + `.sig`；日志末尾 `No updater private key password provided, assuming an empty password`、`Finished 1 updater signature` |
| `python tools/android-codegen.py` | ✅ | 先 `cargo fetch` 后正常；模板取自 `tauri-2.12.1\mobile`，写入 `TauriActivity.kt`(1442 B) 与 `proguard-tauri.pro`(182 B)，占位符已替换 |
| `npx tauri android build --apk` | ⛔ CLI 路径仍需开发者模式；✅ **APK 经无提权旁路已产出** | ① 网络盘上立即 panic（`AssetDirOutsideOfAppRoot`，`mobile/mod.rs:640`，0 分钟）→ 必须在本地 clone；② 本地 clone 里 Rust 交叉编译**成功**（`libmarkdown_x_lib.so` **20.6 MB**，与"带 `custom-protocol` 应 >20 MB"的判据相符），随后卡在 `.so` 符号链接：`Creation symbolic link is not allowed for this system`；③ 按下面 §1.6.1 的旁路出包成功 |

### 1.6.1 开发者模式开不了时，如何仍然产出 APK（2026-10-20 实测）

Tauri CLI 在 `jniLibs/` 里建**符号链接**，非管理员在未开开发者模式的 Windows 上必然失败，且没有开关可绕
（§13.6.1）。但 CLI 的两件事是分开的：**编 `.so`** 与 **建链接并调 gradle**。只要 `.so` 已就绪，
就可以复制进去、跳过那几个任务直接用 gradle 装配：

```powershell
# 0) 前置：codegen 产物（-x 会连带跳过生成 TauriActivity 的任务，所以这里必须先有）
python tools/android-codegen.py
# 1) .so 已由失败的那次 CLI 构建编出；复制（不是链接）到 jniLibs
$jni = "src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
New-Item -ItemType Directory -Force $jni | Out-Null
Copy-Item "src-tauri\target\aarch64-linux-android\release\libmarkdown_x_lib.so" $jni -Force
# 2) 跳过会建符号链接的 rustBuild* 任务，直接装配 release 包
cd src-tauri\gen\android
.\gradlew.bat :app:assembleUniversalRelease --console=plain `
  -x rustBuildArm64Release -x rustBuildArmRelease -x rustBuildX86Release -x rustBuildX86_64Release -x rustBuildUniversalRelease
```

**新机器上还会撞到第二个坑（本条为 2026-10-20 首次记录）**：

```
Execution failed for task ':app:validateSigningUniversalRelease'.
> Keystore file 'C:\Users\<user>\.android\debug.keystore' not found for signing config 'selfSigned'.
```

新机器没有那个 keystore（平时由 Android Studio 首次 debug 构建自动生成）。用 JDK 自带 keytool 按标准参数补：

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore "$env:USERPROFILE\.android\debug.keystore" -alias androiddebugkey `
  -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android `
  -dname "CN=Android Debug,O=Android,C=US"
```

**产物与验收（实测）**：
`gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` = **22.19 MB**，687 个条目、
解压合计 23.1 MB（与文件大小相符，未见 §13.6.3 的"体积翻倍假象"）；包内 `lib/arm64-v8a/libmarkdown_x_lib.so`
**21,053.9 KB**；`apksigner verify --print-certs` exit 0（`CN=Android Debug`）；
`aapt2 dump badging` → `package com.markdownx.editor versionCode=2600000 versionName=2.6.0`、
`minSdkVersion 24`、`targetSdkVersion 37`、`launchable-activity com.markdownx.editor.MainActivity`。

> **这条旁路是给"开不了开发者模式"时的兜底，不是首选**：`npx tauri android build --apk` 是正规入口，
> 一旦开发者模式打开，仍应按 §1.6 的验收顺序走 CLI。

实际安装到的版本：Rust `1.99.1`（stable-x86_64-pc-windows-msvc，另加 4 个 android target）、
JDK `21.0.12.1`（`%LOCALAPPDATA%\Java\jdk-21.0.12.1+1`）、SDK `platforms/android-36` +
`platforms/android-37.0`、`build-tools/36.0.0`、`ndk/30.0.16248370`、`platform-tools`、`cmdline-tools/latest`。

**本轮踩到并已写进本文的三个坑**：`JAVA_HOME` 照字面抄了 zip 名（实际目录是 `jdk-21.0.12.1+1`）；
`rustup target add` 的四个 android target 容易漏（漏了就只能在 Windows 上编）；`platforms;android-37`
不存在（见上表）。

---

## 2. 项目结构（关键文件与职责）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/App.tsx` | ~4135 | **单组件应用**：状态、布局、菜单、文档标签、更新弹窗、位置映射调用点 |
| `src/App.css` | ~3260 | 全部样式：工作台 token、外壳、**打印规则**、右键菜单、更新弹窗 |
| `src/AppIcon.tsx` | 89 | 线性图标库（`<AppIcon name="..." />`），新增图标在此登记 |
| `src/utils/markdownRenderer.ts` | ~1026 | **渲染管线**：`renderMarkdown`（整篇）/`renderMarkdownPayload`（Worker 安全）/`finalizeAssetUrls`（主线程）；公式与引用 token 化；位置锚点 `data-src-*`；Mermaid 与代码遮蔽 |
| `src/utils/renderClient.ts` | ~140 | 渲染客户端：≥20KB 走 Worker，**任何失败回退同步**（只慢不错） |
| `src/utils/renderWorker.ts` | 47 | Worker 入口（纯字符串→字符串，禁止引入 DOM 依赖） |
| `src/utils/updater.ts` | ~250 | 自动升级：桌面走 updater 插件、Android 走原生桥（同一份 `latest.json`），**失败归一为状态值，绝不抛错** |
| `src-tauri/src/android_update.rs` | ~190 | Android 更新清单解析 + 版本比较（**无 cfg，宿主可 `cargo test`**；7 项单测） |
| `src-tauri/src/lib.rs` | ~330 | Rust 命令、**单实例回调**、文件监视器、插件注册、**Android 原生桥** |
| `src-tauri/installer-hooks.nsh` | 67 | NSIS 钩子：文件关联（`OpenWithProgids` + 仅认领无主类型 + 立即刷新） |
| `src-tauri/tauri.conf.json` | ~89 | 窗口/CSP/打包目标/**文件关联**/**updater 端点与公钥** |
| `src-tauri/gen/android/app/src/main/java/com/markdownx/editor/MobileExtrasPlugin.kt` | ~300 | **Android 原生能力**：系统打印 + APK 下载/安装（§13.9） |
| `scripts/release-update.mjs` | ~310 | 发布：签名打包 → 清单（含 APK）→ 上传 raw + 建 Release → **自动实测** |
| `scripts/copy-mathjax.cjs` | ~85 | 离线 MathJax 打包（含 35 个 TeX 扩展；缺了公式会报错） |
| `tools/render-equivalence-gate/` | — | 渲染等价护栏（语料 + 黄金文件 + gate） |
| `src/pdf/` | — | PDF 预览/标注/结构编辑（v2.3.0 新增；纯逻辑带 Vitest 覆盖） |
| `scripts/copy-pdfjs.cjs` / `scripts/copy-cjk-font.cjs` | — | 离线拷贝 PDF.js 资源与 CJK 便签字体 |

Tauri 命令：`get_cli_args`、`get_host_platform`、`read_file_from_path`、`read_dir_files`、
`toggle_fullscreen`、`toggle_always_on_top`、`open_devtools`、`start_watching_file`、
`stop_watching_file`、`list_system_fonts`，以及 Android 桥的四个（v2.6.1）：
`native_print`、`android_update_check`、`android_update_install`、`android_update_progress`。
权限见 `src-tauri/capabilities/desktop.json` 与 `mobile.json`（含 `updater:default`、
`process:allow-restart`）。**Android 桥的四个命令是 app 命令，不是 `plugin:` 命令** —— 本应用没有
app 级 ACL manifest，app 命令对 local origin 直接放行，所以它们不需要任何 capability 例外；
Kotlin 类仍经一个**不暴露任何命令**的 Tauri 插件包装注册，因为 `register_android_plugin` 只存在于
`PluginApi` 上（见 §13.9）。

---

### 2.1 平台无关的核心模块（新增功能优先落这里，因为可单测）

| 文件 | 职责 |
|---|---|
| `src/utils/markdownRenderer.ts` | 渲染主管线：入口 LF 归一化 → Mermaid 围栏抬升 → 数学/引用的等长哨兵掩码 → A/B 层扩展 → marked → 后处理。**改这里必跑护栏** |
| `src/utils/outline.ts` | 大纲提取（在 LF 空间做，避免 CRLF 下逐行正则全灭） |
| `src/utils/properties.ts` | B 层：frontmatter 解析、属性卡渲染、导出元数据（`latexMetadata`/`escapeLatex`） |
| `src/utils/propertyEdit.ts` | B 层写回：`setProperty`/`removeProperty`（只动目标行，其余逐字节原样） |
| `src/utils/linkTarget.ts` | 预览链接分类与相对路径解析（锚点/文件/外部） |
| `src/platform/documentUri.ts`、`recents.ts` | Android 线的文档库与最近文件（在 `feat/android-port` 上） |

`src/utils/__tests__/` 下每个模块都有对应单测；**新功能优先在这类纯模块里实现并在那里测试**，
`App.tsx` 只做接线。

---

## 3. 版本号同步（7 处，缺一处就"版本不符"）

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | 根 `version` **和** `packages[""].version`（两处） |
| `src-tauri/Cargo.toml` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/tauri.android.conf.json` | `bundle.android.versionCode`（公式 `major*10^6 + minor*10^5 + patch*10^3`，2.7.0 → `2700000`；**它不会跟着 `version` 自动变**，而 Android 只认 versionCode 判新旧，漏改就等于手机端收不到更新） |
| `src/App.tsx` | `const APP_VERSION` **和** `RELEASE_NOTES` 头部条目 |
| `README.md` | 标题 `# MarkdownX (vX.Y.Z)` **和** 新增 `### [vX.Y.Z] - 日期` 一节 |

`RELEASE_NOTES` 与 README 那一节就是**更新弹窗显示的说明**（发布脚本从 README 取，单一来源）。

---

## 4. 发布流程（已端到端验证）

```bash
# ① 改版本号（§3 的 6 处 + package-lock 第 3/9 行）+ README 写 ### [vX.Y.Z] - 日期
#    + App.tsx 的 RELEASE_NOTES 顶部加一条（关于对话框读它）
# ② 构建（会产出安装包 + .sig + latest.json）
TAURI_SIGNING_PRIVATE_KEY_PATH=Z:/MarkDownX-keys/markdownx-updater.key \
  node scripts/release-update.mjs --owner callyli00 --repo MarkdownX
# ③ 确认产物存在（缺 .sig 说明没签名，装完的客户端将来无法升级）
ls -la src-tauri/target/release/bundle/nsis/MarkdownX_<版本>_x64-setup.exe*
# ④ 生成/复核 latest.json（复用已构建产物）
TAURI_SIGNING_PRIVATE_KEY_PATH=Z:/MarkDownX-keys/markdownx-updater.key \
  node scripts/release-update.mjs --owner callyli00 --repo MarkdownX --skip-build
# ⑤ 发布：把「安装包 + latest.json」推到 release-assets 分支，再建 Release
#    ⚠️ **不要用脚本的 --publish**：它走 Contents API 上传，大文件踩过事故（§8.5）
```

**发布成功的判据**（三条链路都要 HTTP 200，且版本号一致）：

```bash
curl -s https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/latest.json | grep -o '"version":"[^"]*"'
curl -sI https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/MarkdownX_<版本>_x64-setup.exe | grep -i content-length
curl -sL https://github.com/callyli00/MarkdownX/releases/latest/download/latest.json | grep -o '"version":"[^"]*"'
```

② raw 清单的 `content-length` 必须与本地安装包**字节数完全一致**；raw CDN 有约 5 分钟缓存，读到旧版本等 1~2 分钟再试。

> **NAS 上的已知灯下黑（2026-10-18 实测）**：② 这一步脚本可能在 1 秒内以
> `stdin is not a tty` 退出 —— 那是 `execFileSync(..., { shell: true, stdio: 'inherit' })`
> 在无 TTY 上下文里抛错让**脚本**早退，但它启的**构建子进程会脱离父进程继续跑完**。
> 所以：看到这句不要立刻重跑（会同时再来一份构建、争同一个 target 锁）；
> 用 `cargo`/`rustc` 进程是否存在 + 产物是否出现来判断构建是否结束，再用 ④ 继续。
> **另：不要把脚本输出接 `| tail`** —— 构建几百行输出会把真正的报错吞掉（也踩过）。

| 发布会落点 | 内容 | 用途 |
|---|---|---|
| 分支 `release-assets` | 仅 2 个文件（孤立提交，每次覆盖） | **应用首选**拉取源（raw，不依赖 github.com） |
| GitHub Release `vX.Y.Z` | 安装包 + `latest.json` | 人类查看 / 标签 / 订阅 / **兜底端点** |
| `src-tauri/target/release/bundle/` | NSIS 安装包 + `.sig` + `latest.json` | 本地产物 |

**签名私钥**：`C:\Users\callyli00\.tauri\markdownx-updater.key`（仓库外、未被 git 跟踪）。
**丢了它，已安装客户端将永久无法接受后续更新** —— 请离线备份到密码管理器。配置里只有公钥。

**NAS 上的副本（源码迁到 `Z:\MarkDownX_app` 后新增）**：`Z:\MarkDownX-keys\markdownx-updater.key`
（在 `Z:\MarkDownX_app` **之外** ✓，git 看不到它 ✓，已核对 SHA-256 与原件一致 ✓）。
在 NAS 上发版时显式指定路径：

```bash
TAURI_SIGNING_PRIVATE_KEY_PATH=Z:/MarkDownX-keys/markdownx-updater.key \
  node scripts/release-update.mjs --owner callyli00 --repo MarkdownX
```

脚本默认路径仍是本机 `C:/Users/callyli00/.tauri/…`（`scripts/release-update.mjs` 第 27 行）✓。
注意：网络盘上无法设置 POSIX 权限 ✓，访问控制依赖 NAS 的账号权限 ✓。

---

## 5. 自动升级机制（应用检查、用户决定、不回滚）

- 启动后延迟 20 秒**静默检查**；发现新版本只在**帮助图标点一个小圆点**，菜单显示「检查更新（有新版本 vX）」。
- 点「下载并安装」才：下载 → **minisign 签名校验** → 静默安装（`installMode: passive`）→ 自动重启。
- **任何失败静默跳过并记日志**，绝不阻塞启动、绝不弹错误框；只有手动「检查更新…」才显示失败原因。
- 端点（`plugins.updater.endpoints`，**按序尝试**）：

```json
[ "https://raw.githubusercontent.com/callyli00/MarkdownX/release-assets/latest.json",
  "https://github.com/callyli00/MarkdownX/releases/latest/download/latest.json" ]
```

**为什么 raw 优先**（本机实测）：raw 清单 0.42s / 包 1.76s、**0 次跳转**，完全不经过 `github.com`；
Release 路线 1.28s / 2.84s，**必须先过 `github.com`** —— 该主机在本网络**时通时断**（曾测得 12 秒超时/连接重置）。
因为检查是静默的，指向"当时拉不到"的宿主会表现为**自动升级永不触发且无任何提示**，故把最抗断的放前面。

**故障排查**

| 现象 | 先查 |
|---|---|
| 永远没有小圆点 | ①端点是**编译期写死**的（见 §8 引导版）②`curl` 两个端点是否 200 ③raw 有几分钟缓存 |
| 弹窗「检查更新失败」 | 弹窗里有原因行；`updater.ts` 把异常归一为 `status:'error'` |
| 下载卡住/失败 | 清单本身可达 ≠ 安装包可达；清单里的 `url` 要单独 `curl` 验证 |
| 签名校验失败 | 发布私钥与配置公钥是否同一对；`.sig` 是否本次构建产物 |

---

## 6. 必须保持的不变量

1. **打开文档时公式必须自动渲染**（v1.9.7–v1.9.12 曾因分片/按需排版破坏它，被整体回退）。
2. **源码⇄预览双向位置连续**：`data-src-*` 锚点 + 块内对齐；双击预览落到源码对应字符。
3. **打印输出不含任何界面**：顶栏/侧栏/格栅/标签条/状态栏/右键菜单都在 `@media print` 隐藏列表；
   **新增外壳元素必须同步加进该列表**（v1.9.0 改版时漏过，用户真的打印出了侧栏）。
4. **Worker 只是优化**：失败必须回退同步渲染 —— 只允许变慢，不允许不渲染。
5. **渲染等价护栏必须 PASS**：①Worker 路径 ≡ 同步路径（逐字节）②与历史黄金文件一致
   ③LF 与 CRLF 渲染结构一致 ④源码含行间公式就必须产出公式标记。改动渲染器后必跑。
6. **单实例语义**：第二次双击由单实例插件转发给已有窗口；`argv[0]` 必须剔除（否则会把 exe 当文档打开）。
7. **打包目标收敛为 `["nsis"]`**：只需 Windows 安装包；若将来要 Linux 包，再补 `appimage`/`deb`。
8. **外壳布局的两条用户硬要求**（不要"顺手优化"掉）：状态栏保持**通栏**；侧边栏**贯通到状态栏上沿**。
9. **预览的 DOM 由补丁器接管，不由 React 管**（P5，2026-10-26）：`<article ref={previewRef}>` 上**不得再挂
   `dangerouslySetInnerHTML`**。渲染仍出整篇 HTML，但只把变化的顶层块写进 DOM（`src/utils/domPatch.ts`
   算计划，App 的 `useLayoutEffect` 执行），变化的节点才交给 `typesetMathNodes()` 增量排版。
   破坏它的典型方式：把 innerHTML 塞回 JSX（→ 每按一键全篇重排，MathJax 全量 typeset），
   或让补丁器与 `renderedHtml` 失去同步（→ 空白预览）。真机判据见 `tools/local-check/smoke-p6.mjs`。

---

## 7. 文件关联（安装时由 NSIS 钩子完成）

- `bundle.fileAssociations`：两个类型 —— `md / markdown / mdown / mkd / mdx`（`Markdown Document`，
  role=Editor）与 `pdf`（`PDF Document`，role=Viewer）。
- `installer-hooks.nsh`：写 `OpenWithProgids`；**仅在该扩展名无 `UserChoice` 时**认领默认值；
  结束调用 `SHChangeNotify` 立即刷新；卸载对称回收。
- **新增一个文件类型要同时改三处，缺一处就会"能手选但看不到/或能看到但关联不上"**：
  1. `tauri.conf.json` → `bundle.fileAssociations` 增加条目（决定 ProgID、图标、打开命令）。
  2. `installer-hooks.nsh` → `MDXClaimExt` / `MDXReleaseExt` 各加一行（宏已参数化为
     `PROGID EXT` 两参，新类型用自己的 ProgID）。只改 ① 不改 ②：能关联但不会出现在
     "打开方式"里；只改 ② 不改 ①：ProgID 没有 command，双击会失败。
  3. 若该类型要出现在**侧栏工作区文件树**，还要在 `src-tauri/src/lib.rs` 的
     `read_dir_files` 扩展名白名单里加上它（这是独立的一处，与系统关联无关）。
- PDF 关联的默认行为：`.pdf` 通常已被 Edge/Acrobat 占用 `UserChoice`，所以安装**不会**抢占默认，
  只是把 MarkdownX 加进"打开方式"；用户可在「设置 → 默认应用 → 按文件类型选择默认应用」指定。
- 关键注册表位置（均为 HKCU，无需管理员）：

| 键 | 作用 |
|---|---|
| `HKCU\Software\Classes\.md`（默认值） | 扩展名 → ProgID `Markdown Document` |
| `HKCU\Software\Classes\Markdown Document\shell\open\command` | 打开命令（`%LOCALAPPDATA%\MarkdownX\markdown-x.exe "%1"`） |
| `HKCU\...\Explorer\FileExts\.md\UserChoice` | **用户选择的默认程序**（Win10/11 带 Hash，程序不可静默改写） |
| `HKCU\Software\Classes\Applications\<exe>` | 按 exe 路径登记的"打开方式"条目 —— **幽灵条目来源**，除本次安装外不应存在 |

**"打开方式里有多个 MarkdownX 且图标空白"** = 存在指向已删除路径的登记项（曾因 `C:\Program Files\MarkdownX` 被删而出现）。
排查：全树搜索 `markdown-x`，逐条判断目标文件是否存在，删掉失效项。

---

## 8. 已知坑与纪律（每条都真的踩过）

- **源码写入会静默丢失**：`write_file`/`patch` 报成功但内容没变（本轮 CSS、JSX、发布脚本、维护手册各中过一次）。
  **规则：每次改动后立刻 `grep` 校验，并尽快提交**（提交后就不会丢）。
- **CRLF 是隐形杀手**：行尾锚定正则漏 `\r` 会让"代码围栏未闭合"，其后整段被遮蔽、公式全部不识别。
  改扫描类代码后必须用 LF 与 CRLF 两种语料验证（`gate.cjs` 第二相）。
- **一次性测量不能下结论**：`github.com` 曾 12 秒超时被判"不可用"，几分钟后同一 URL 返回 200。
- **给原生程序的路径**：本 shell 关闭 MSYS 转换，`$HOME`/`/tmp` 传给 `git`/`gh`/`curl` 会失败；用 `C:/...`。
- **`curl -o /dev/null` 在 Windows 退出码 23**：请求其实成功；改用 `-o NUL` 并容忍非零退出。
- **捕获阶段的全局右键压制会吃掉所有 `onContextMenu`**：加自定义右键前先检查它。
- **`gh`/`git` 在已开着的 PowerShell 里"找不到"**：包管理器只对新进程更新 PATH；新开窗口或用完整路径。
- **仓库里不要放**：`node_modules/`、`src-tauri/target/`、签名私钥、任何 token。
- **不要用 MSI**：targets 已收敛为 `["nsis"]`（MSI 用另一套 ProgID，会在"打开方式"里再添一份）。

---

## 8.5 Contents API 上传大文件的坑（v2.3.1 实测）

- `scripts/release-update.mjs --publish` 走 GitHub **Contents API**（`PUT /repos/.../contents/<file>`）
  上传安装包。安装包 ≤ 5.4 MB（v2.2.4）时能过；到 13 MB（v2.3.0 / v2.3.1）时该请求**稳定返回
  `401 Bad credentials`** —— 而同一时刻 `gh api user`（读）和 `gh release create`（资产上传）都正常，
  所以这是**大 body 的上传被拒**，不是凭据真的坏了。**不要**因此去动凭据。
- 可靠替代路径（两条都用 git/gh 的正常能力）：
  1. **分支发布**：临时目录 `git init` → 放 `MarkdownX_<ver>_x64-setup.exe` + `latest.json`
     → `git push -f origin HEAD:release-assets`（git push 走 credential manager，不受影响）。
  2. **Release 兜底**：`gh release create v<ver> --notes ... <exe> <latest.json>`；
     若上传中断，用 `gh release upload v<ver> <exe> --clobber` 补传（13 MB 约需 2–3 分钟），
     再用 `gh release edit v<ver> --draft=false --latest` 把 Draft 转正。
- 症状自查：`gh release list` 里出现 **Draft** 且资产不全 → 就是上传被中断。

---

## 8.6 三条提交/验证纪律（2026-10-18 连续踩到后固化）

1. **提交范围显式列举，禁用 `git add -A` 兜底。**
   一次 `git add -A` 把 `src-tauri/gen/` 的 Android 构建产物（446 MB）扫进了发布提交，只能回退重做。
   现在 `src-tauri/gen/` 已在 `.gitignore` 里，但纪律仍然成立：**只 add 你真正改过的路径**。
2. **判据只认脚本自己的结论，不数行数。**
   我连续几轮上报"护栏 12 行 PASS"，那是 `grep -c "^PASS"` 数出来的 —— 而当时护栏其实是
   `FAIL 5/6 documents equivalent`。**读脚本输出的 `PASS/FAIL N/N` 那一行**，不要读计数器。
3. **长任务一律写日志文件再读末尾，不要接 `| tail` 看输出。**
   构建类命令的几百行输出里，真正的报错会被 `tail` 截掉，只剩无关的收尾行 —— 
   结果是拿"看起来失败"或"看起来成功"去猜。日志文件 + `tail -40 <日志>` 才是可靠读法。

附带一条**契约**纪律：**黄金文件（`tools/render-equivalence-gate/golden/`）只能带理由改。**
改渲染器导致输出变化时，先逐字符审查差异（确认只有预期改动），再重新生成并写明原因；
不要为了让护栏变绿而直接覆盖黄金。做法见 §9.5。

---

## 9. 验证方法论（"能跑"必须有证据）

| 层次 | 手段 |
|---|---|
| 类型/构建 | `npx tsc --noEmit`、`npm run build` |
| 渲染正确性 | `tools/render-equivalence-gate/gate.cjs`（两相均需 PASS） |
| 界面行为 | 浏览器驱动 + **注入 Tauri 桩**（`window.__TAURI_INTERNALS__`）：断言 DOM、模拟点击、读计算样式 |
| 打印 | `Emulation.setEmulatedMedia('print')` + 断言 `display:none` 与 `innerText` 无界面文字 |
| 组件状态 | 从 `__reactFiber$*` 链读 `memoizedState`（源码看起来对但界面不符时用） |
| 升级/安装 | **系统侧确认**：exe 的 `VersionInfo.FileVersion` + 卸载项 `DisplayVersion` |
| 网络可达性 | 对每个候选 URL `curl` 计时与跳转数（见 §5） |

浏览器 harness 目前在临时目录、不随仓库分发；**仓库内持久可复现的只有 tsc + gate**，其余需按上表重建。

---

## 9.5 新增或修改一个功能：标准流程

**先定位再动手**（`search_files`/`grep` 找锚点，不要凭记忆改）→ **改 → 跑三道门（§1）→ 提交（§8.6.1）**。

按改动类型看额外要动什么：

| 你改了什么 | 必须同步做的事 |
|---|---|
| 渲染器（`src/utils/markdownRenderer.ts` 等） | 跑护栏；输出有变化就按契约处理黄金文件（下方流程）；必要时补单测 |
| 预览里的交互（`src/App.tsx`） | 纯逻辑抽到 `src/utils/*.ts` 并写单测；**在真实应用里验证**（§9 的手法） |
| 外壳/样式（`src/App.css`） | 新增的**界面元素**要判断是否属于内容：chrome 必须加进 `@media print` 隐藏列表（不变量 3） |
| 版本相关（发版） | §3 的 6 处 + `package-lock` 第 3/9 行 + README + `RELEASE_NOTES` + `MAINTENANCE` 对应版本；`Cargo.lock` 里 markdown-x 的版本行会在构建后由 cargo 写回，记得补记一次 |
| Android 相关 | 在 `feat/android-port` 分支上做；APK 配方见该分支的 §13 |

**黄金文件的正确处理流程**（渲染器输出变化时）：

```bash
# 1) 拿出当前渲染，与黄金逐字符比对（不要只看长度）
node -e "…"                   # 渲染目标语料 → 临时文件
# 2) 用 Python 的 difflib 逐行 + 逐字符看差异，确认只有预期改动
# 3) 确认后覆盖该语料的黄金，并把差异写进提交说明
cp <当前渲染> tools/render-equivalence-gate/golden/<语料>.md.html
# 4) 重跑护栏，读它自己的结论：PASS 6/6 + PASS 6/6
```

**真实应用里的验证手法**（本项目长期使用，可复用）：

- 桌面调试包：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动
  `src-tauri/target/debug/markdown-x.exe <样本文档>`，再用 CDP（WebSocket + `Runtime.evaluate`）读 DOM 断言；
- 预览是**只读**的、编辑在「源码」视图：要验证"回写源码"，必须切到 `.wb-view-tab` 文本为 `源码`
  的那个页签去读 `textarea`（预览模式下**没有** textarea）；
- React 受控输入要用**原生 setter + 派发 `input` 事件**才能触发 `onChange`（直接改 `.value` 无效）；
- 「没滚动」「没生效」先怀疑**样本设计**（文档太短不需要滚动、目标在文档最末够不到顶部）——
  这两次都误判过，见 §8.6 的教训。

---

## 10. 已知边界（诚实声明）

- 自动升级端到端**已实测一次**（2.2.2 → 2.2.3，系统侧确认文件版本变化）；其余版本依赖同一路径。
- 单元测试：`npm run test`（Vitest，覆盖 `src/pdf/` 纯逻辑）；**渲染护栏 `gate.cjs` 仍需手动执行**；无 CI。
- `README.md` 变更日志很长（历史包袱），新改动只需在顶部加一节。

---

## 11. 待办与可选项

> **本节已清空重启。** 之前登记的旧计划一律作废、不再跟踪，需要时从 git 历史取回
> （`git log -p -- MAINTENANCE.md`）：
>
> - 工具链可选项：`git`/`gh` 加入 PATH、浏览器 harness 固化到 `tools/ui-harness/`、加 `npm run gate` 脚本；
> - PDF 后续项：页面缩略图导航、PDF 内文本搜索、标注清单导出、原生 `/Annots` 字典。
>
> 其中**本质上不是"计划"的两条**（打包目标收敛、外壳布局的两条硬要求）已上移到 §6
> 不变量第 7、8 条 —— 它们是不该随计划一起被清掉的信息。

### 11.1 A 层（Obsidian 风格 Markdown 扩展）—— 立项中

用户按"分三层"的讨论结论先做 **A 层（纯渲染层，不需要索引/库）**。开工前已核对代码现状：
**Mermaid 与 Callout 其实早已实现**（`renderMermaidDiagrams()` + `renderer.blockquote` 的
`<div class="callout-card">`），所以本轮只做真正的缺口：

| 项 | 现状 | 计划 |
|---|---|---|
| A1 高亮 `==文字==` | **缺** | 源码级转换（跑在代码/公式掩码之后，自动免疫），产出 `<mark class="md-mark">` |
| A2 注释 `%%文字%%` | **缺** | 预览与导出均不显示；只作用于非围栏正文（Mermaid 的 `%%` 注释不受影响） |
| A3 Callout 类型补全 | 只有 `NOTE/TIP/WARNING/CAUTION/IMPORTANT/THEOREM/DEFINITION/ASSUMPTION` | 补 Obsidian 别名（info/todo/success/question/danger/bug/example/quote/abstract/faq/failure）+ **可折叠** `[!type]-` / `[!type]+` |
| A4 脚注 `[^1]` | **缺**（marked v12 核心不含脚注） | 收集定义、按首次引用编号、回链；导出链路（HTML/Word/LaTeX）兼容 |
| A5 任务列表样式 | GFM 已渲染 checkbox，但**无样式、不可交互** | 补 CSS；"点选回写源码"单独评估 |
| A6 验收 | — | tsc + 单测 + 渲染等价护栏 + 真实文档渲染实测 |

**实现纪律**（本轮三条硬约束）：
1. 新语法一律跑在**掩码之后**（代码块与公式此时已是等长哨兵），从而实现"公式内不误判"而不额外写守卫；
2. 任何删改字符都必须走 `trackedReplace` + `SourceTranslation`，保住源码⇄预览偏移（不变量 2）；
3. 新增的可见 UI 元素必须同步进 `@media print` 隐藏列表（不变量 3）。

**进展（v2.4.9 已发布）**：A1~A5 全部完成 ✓

| 项 | 状态 | 实现要点 |
|---|---|---|
| A1 高亮 | ✓ | 侧翼规则挡散文比较；打印改为下划线（浏览器默认不打印背景色） |
| A2 注释 | ✓ | 源码层删除 → 预览 / HTML / Word / LaTeX / 打印自动一致 |
| A3 Callout | ✓ | 别名映射既有配色族 + `data-callout` 保留字面类型；折叠用 `<details>`（打印强制展开） |
| A4 脚注 | ✓ | 就地改写（单路径，公式与行内代码照常渲染）；按首次引用编号；同标签只发一次 id |
| A5 任务列表 | ✓ | 仅补 CSS；`:has()` 在老浏览器退化为保留项目符号 |

**两个既有缺陷（本轮发现并修掉，都不是 A 层引入的）**：
1. Callout 标题捕获用 `\s*` 会跨换行 → `> [!note]` 后换行写正文时，标题被正文顶替（实测标题变成"内容"）；
2. **CommonMark 会把 `[^x]: text` 当链接引用定义吞掉** → 未被引用的脚注定义会**静默丢失作者文字**，
   修法是未引用时转义首字符后原样保留。

**新增纪律**：① 新语法一律插在 `unmaskVerbatimRegions` **之前**（代码与公式此时是哨兵，免疫是结构性的）；
② 任何语法都不得静默删除作者文字 —— 无法解析的一律原样保留。

### 11.2 B 层（文档元数据）—— 已实现，未发布

| 项 | 状态 | 实现要点 |
|---|---|---|
| B1 解析与属性卡 | ✓ | `src/utils/properties.ts` 纯函数（YAML 小子集，不成形的行忽略而非猜解）；渲染成属性卡而非裸 YAML；**值一律转义**（官方明确不支持属性内 Markdown） |
| B2 导出元数据 | ✓ | `title/author/date` 接入 3 处 `<title>`（HTML×2 + Word）与 LaTeX 的 `\title/\author/\date`；无 frontmatter 时输出与旧版**一字不变** |

**三条必须记住的约束**：
1. **`---` + `title: x` + `---` 是合法的 setext 标题** —— 不先摘走的话，文档开头的属性会被渲染成
   `<h2>title: x</h2>` 加一条游离 `<hr>`（已写成回归测试）；
2. **属性值是数据不是正文** —— 值里的 `==x==` / `[^1]` 不能被 A 层那两趟改写；属性卡通过哨兵在
   **最后**注入，反向保证它自己产出的 HTML 也不被那些趟处理；
3. **LaTeX 正文直接取 `activeFile.content`** —— 不剥掉 frontmatter 的话，整个 YAML 块会作为
   垃圾正文进入 `.tex`。剥除规则与渲染器一致：**解析不出属性就不剥**（不因"看起来像"而删作者文字）。

**导出链路的验证边界（诚实声明）**：元数据取值与回退逻辑由 `latexMetadata()` 在单测中真实执行
并断言；但**导出文件本身没有端到端生成过** —— 导出需要原生保存对话框，自动化跑不了。
三个 `<title>` 与 LaTeX 三行的接线是按 diff 审阅确认的，未做端到端出文件验证。

**过程中一次自我纠正**：45b301e 的说明写了"用真实帮助函数在真实模板表达式上验证"，但探针文件在
仓库根目录、vitest 的 include 是 `src/**`，**它从未执行**。已在 f9b0695 纠正：逻辑抽成
`latexMetadata()` 放进 src 真正测试。留作纪律：**验证声明必须能指出它落在哪个被执行的路径上**。

**B3 属性编辑（已完成）**：预览只读 → 编辑必须**回写源码**。
- 数据层 `src/utils/propertyEdit.ts` 纯函数：`setProperty` / `removeProperty` / `formatPropertyValue`；
  **只动目标那一行，其余逐字节原样**；改块状列表要吃掉 `- 项` 续行（否则留孤儿项）；CRLF 保持 CRLF；
  引号**只在必要时加**（全加引号会把用户没碰过的值也改写，diff 全是噪声）。
- UI：属性行带 `data-prop-key/kind/value` → 点击处理器不需要知道卡片内部结构；
  卡片里的「＋ 添加属性」是 **chrome 不是内容** → 已进 `@media print` 隐藏列表（不变量 3）。
- 端到端实测方式（可复用）：用 CDP 点行开编辑器 → 用 React 原生 setter 写受控输入
  （直接改 `.value` 不会触发 onChange）→ 点保存 → **切到「源码」视图读 textarea** 验证回写。
  注意：预览模式下**没有 textarea**，所以在预览模式里断言源码是无效的（本轮踩过一次）。

**未做**：C 层（双链/索引）。

---

## 12. PDF 模块（v2.3.0 新增）

### 12.1 分层

| 文件 | 职责 |
|---|---|
| `src/pdf/pathKind.ts` | 零依赖 `isPdfPath`（可在 Node 测） |
| `src/pdf/openPdf.ts` | 经 plugin-fs `readFile` 读字节；`%PDF` 魔数在前 1024 字节内搜索 |
| `src/pdf/pdfjs.ts` | PDF.js 启动：worker(`?url`) + 离线 cMaps/标准字体 |
| `src/pdf/PdfViewer.tsx` | 多页 canvas + 工具条 + 可见页追踪（IntersectionObserver） |
| `src/pdf/PdfAnnotLayer.tsx` | SVG 标注覆盖层（高亮/下划线/删除线/便签/墨迹） |
| `src/pdf/annotations.ts` | 标注模型（归一化坐标 0..1，top-left 原点） |
| `src/pdf/coords.ts` | CSS 像素 ↔ 归一化 ↔ PDF 点（含 /Rotate 处理） |
| `src/pdf/annotStore.ts` | 标注嵌入 PDF 目录私有键 `MarkdownXAnnots`（base64 JSON） |
| `src/pdf/flatten.ts` | 压平到内容流；CJK 便签用 Noto Sans SC 子集 |
| `src/pdf/structuralOps.ts` | 旋转/删页/插页/重排/提取/合并/拆分/元数据 |
| `src/pdf/cjkFont.ts` | 记忆化 fetch `/fonts/NotoSansSC-Regular.ttf` |

### 12.2 三条必须记住的坑

1. **`bytes.slice()` 是强制的**：pdf.js 会把 `data` 的 ArrayBuffer **转移（transfer）**给 worker；
   不复制的话调用方手里的 `Uint8Array` 会变成零长度，保存时写出空文件。
2. **中文 PDF 必须有 cMaps**：否则 pdf.js 渲染成方框（空白/豆腐块）。资源靠
   `scripts/copy-pdfjs.cjs` 从 node_modules 拷到 `public/pdfjs/`；换 pdfjs 版本后要重跑。
3. **不要把 pdf-lib 静态导入 `App.tsx`**：pdf-lib + fontkit ≈ 1 MB。它们在各个调用点用
   `await import()` 动态引入；一旦改回静态导入，启动包会从 ~350 kB 涨回 ~1.4 MB。
4. **文字选择依赖文本层**：pdf.js 只把字形画进 `<canvas>` 的像素里，**必须**在每页再叠一层
   `TextLayer`（`.pdf-text-layer`，透明文字 spans）。少了它，PDF 里的文字不可选中、不可复制，
   高亮/下划线也就无从实现。另外：高亮类工具的事件必须**穿透**标注层（`pointer-events: none`）
   才能选字，只有便签/墨迹/框选删除才让标注层接收指针事件。
5. **文本层必须设 `--scale-factor`**：pdf.js 的 span 用 `calc(var(--scale-factor) * Xpx)` 定位、
   层宽也用它推导，但 **pdf.js 自己不会设这个变量**（那是宿主 viewer 的职责）。
   每页渲染前执行 `textDiv.style.setProperty('--scale-factor', String(scale))`；
   同时**不要**手动写 `textDiv.style.width/height`，交给 `TextLayer.render()` 推导。
   漏设的症状：低缩放时选中高亮与文字明显错位，放大后"看起来好转"。

### 12.3 保存语义（用户拍板）

- **Ctrl+S**：标注写回 PDF 内嵌私有键 → **仍可再编辑**（不压平）。
- **导出压平副本**：烧进页面内容流 → 任何阅读器可见、不可再编辑；中文便签用
  Noto Sans SC（SIL OFL）子集嵌入。

### 12.4 已核实的字体来源

`@expo-google-fonts/noto-sans-sc@0.4.4` 的 `400Regular/NotoSansSC_400Regular.ttf`
（10,559,284 B，SIL OFL，允许再分发）。
**反例**：`@fontsource/noto-sans-sc` 只发按 Unicode 分片的 woff2，字形表不完整，pdf-lib 不能用。
**禁用**：Windows 系统字体（微软 EULA 不允许把其字体嵌入再分发的 PDF）。

### 12.5 PDF 打印为什么不能用 `window.print()` 直接打

直接打印实时查看器会把 canvas **塞进通用 A4 打印样式表重新排版**：结果既带上工具条/界面元素，
又被按 A4 重新分页（尤其实 PDF 本身不是 A4 时）。正确做法（v2.3.4 起）：

1. `PdfViewer` 把每页 canvas 转成 `data:image/png`；
2. **写进一个隐藏 iframe 的独立文档**再打印 —— 这是关键：把内容放进应用自己的 DOM 里
   （哪怕离屏、哪怕 `@page` 后注入）都会被应用打印样式表干扰，实测出现空白页/首张空白。
   iframe 文档只含 `@page { size: <W>mm <H>mm; margin: 0 }` + `html,body{margin:0}` +
   每页一张 `<img>`（`width:100%`、`img:not(:last-child){page-break-after:always}`）；
3. 纸张尺寸取 `viewport.rawDims`（72dpi 页面单位）换算 mm（`× 25.4 / 72`），与 PDF 自身一致；
4. **打印前必须等图像解码**：轮询 `img.complete && naturalWidth > 0` 后再 `contentWindow.print()`
   （留 5s 兜底），否则打印管线可能对着未绘制的图像输出空白；
5. **每页图像必须用一个严格小于页面的盒子**：`width: calc(<W>mm - 0.6mm)` /
   `height: calc(<H>mm - 0.6mm)` + `margin: 0 auto` + `object-fit: contain`。
   用 `width:100%; height:auto` 看似正确，但**只要图像纵横比比纸张高一丁点**（画布尺寸取整、
   或该页尺寸与第一页不同），就会溢出当前页并多出一个近乎空白的 sheet —— 表现为
   **"一页正常、一页空白"**；0.3mm 边距在成品上不可见，但换来"任何纵横比都不溢出"的确定性；
6. 打印结束后移除 iframe。

> 复现与验证方法（建议照做，别再靠猜）：把同样的 CSS 与若干张 N 页图像放进一个独立 HTML，
> 用真实打印管线（CDP `Page.printToPDF`，`preferCSSPageSize: true`）输出，统计 PDF 的
> `/Count` 页数是否等于图像数。上面第 5 条就是这么定位的：3 张图打出 6 页 → 改 CSS 后 3 页。

已知边界：**逐页尺寸不同的 PDF 只能按第一页的纸张尺寸输出**（CSS 一个文档只能有一条 `@page size`）。

### 12.6 右键菜单架构（v2.4.0 起）

三件套，新增菜单项只改三处：

1. **模型** `src/ui/contextMenuModel.ts`：纯函数 `buildMenu(ContextTarget) → MenuItem[]`。
   6 种 surface（tab / preview / sidebar-file / sidebar-doc / pdf-page / pdf-annot），
   条目顺序 = 特异性（选区 > 命中元素 > surface 默认）。有 18 条单测锁行为。
2. **分类器** `classifyPreviewTarget()`（App.tsx）：从事件目标解析选区/链接/图片/代码/公式。
   源码切片靠渲染器的 `data-src-start/end` 锚点，**禁止**用文本搜索猜位置。
3. **分发器** `runContextAction(id, ctx)`（App.tsx）：switch on item id 调既有 handler。

接线要点（漏一个就会出现"右键没反应"）：
- 捕获阶段抑制器（App.tsx `handleContextMenu`）的 `customMenuSurface` 选择器必须包含新 surface
  的根类名（`.pdf-page-wrap` / `.file-tree-item` / `.sidebar-doc-item` …），否则事件在到达
  React 前就被 `stopPropagation` 吃掉；
- PDF 标注命中用 `annotAtPoint` **几何命中**（annotations.ts，有单测），不要改成 DOM 命中——
  标注 SVG 在选择工具下是 `pointer-events:none`，事件永远落不到它上面；
- 菜单渲染由 `buildMenu` 驱动，不要再手写 per-surface 的 JSX 三元分支。

**PDF 标注项的两套语义，别混用**：
- 工具栏图标（`onPdfToolButton`）：有待应用选区则应用，否则**切换**（再点一次关闭）；
- 右键菜单项（`armOrApplyPdfTool`）：有选区则应用，否则**只武装**（菜单不是 toggle，不能把
  用户已激活的工具悄悄关掉）。两者共用 `applyMarkToPendingSelection()`，避免逻辑漂移。

PDF 视图**不显示操作提示条**（v2.4.1 起移除）：可发现性由工具图标的 `title` 与右键菜单承担，
不要再加回 `.pdf-hint` 之类的常驻引导。

外部动作（打开链接 / 在文件夹中显示）走 `@tauri-apps/plugin-opener` 的**动态导入**；
capabilities 只给了 `opener:allow-open-url` 与 `opener:allow-reveal-item-in-dir`，不要扩权。

### 12.7 标注的两种操作习惯都要支持

- **先选工具再选文字**：松手即标注（`PdfViewer` 内部完成）。
- **先选文字再按工具按钮**：`PdfViewer` 通过 `onSelectionChange` 把待应用选区上报给 `App`，
  由工具栏按钮触发；按完保持该工具激活，方便连续标注。

两条路径共用同一份归一化选区数据，避免两套逻辑漂移。

---

### 12.8 【已修】双击跳源码"落在前一块" —— marked 的 raw 会把换行规范化成 LF

**症状**：在预览里双击跳源码，光标常落在**被点段落之前**，且越靠文档后部偏得越多
（前部几十字符、后部上千字符），表现为"定位不稳"。

**根因（应用内打点取证，两个数字完全相等）**：每块打点靠**累加 `token.raw.length`** 求在 sanitized
文本里的偏移，再经 `translation.map()` 换到源码坐标。而 **marked 返回的 `raw` 已把 CRLF 规范化成 LF**，
源文件却是 CRLF —— 每行少算 1 个字符：

```
coverage 差值 = 1109 ，   sanitized 文本里的 CRLF 对数 = 1109    ← 完全相等
rawHead "# Vectors, Tensors, and …"   rawCRLF=0   rawLF=2
smHead  "# Vectors, Tensors, and …"   smCRLF=1109
```

累加值从第一个换行起就偏小，之后**每块都往前偏**，并随文档深度累积。

**修法**：在 `processMathAndCitations` 入口统一换行（`rawMarkdown.replace(/\r\n?/g, '\n')`），
让 translation、sanitized 文本、锚点与 `<textarea>.value`（DOM 本就把 CRLF 规范化成 LF）
处于**同一空间**。磁盘文件的行尾不变。
**顺带撤掉**先前一轮基于错误假设加上的 `toTextareaOffset`/`toContentOffset` 换算（方向搞反了：
锚点当时并不是 CRLF 空间，而是被这个 bug 提前了）。

**验收**：coverage 差值 1109 → **0**；词级定位检查 **3/16 → 16/16**（光标覆盖第 78 ~ 102579 字符
通篇一致）；渲染护栏 6/6（含换行等价）保持 PASS。

### 12.10 【已修】TOC 点不动：粘连的 `$$` 吞掉整段文档 + 含公式标题匹配不上

**症状**（用户报告）：同一本合并书里，第 1~3 章的目录能跳、第 5~10 章点了没反应。

**缺陷一（主因，渲染侧）**：表格单元格里两个行内公式贴在一起（转换产物）——
`| $c_1 \neq 0$$c_2 = c_3 = c_4 = 0$ |` 产生了 `$$`。行间公式那一趟用
`/\$\$([\s\S]*?)\$\$/`（**无边界要求**），于是它与很远处（本书是好几章之后）的一个
真实 `$$` 配对，把中间的表格、标签、**标题**全部吞掉 —— 那些标题从未成为 DOM 元素，
TOC 自然无处可跳。配对还取决于粘连 `$$` 的**奇偶性**，这正是"第 5~10 章死、11~12 章恢复"的来源。

实测：渲染出的 `h1` **6 → 12**、`h2` **44 → 81**、`getElementById` 命中 **217/396 → 391/396**。
修法：行间公式开头必须位于**词法边界**（`(?<!\S)`）；粘连的 `$$` 交给行内公式那一趟，
被正确读成两个相邻行内公式。

**缺陷二（次因，跳转侧）**：含公式的标题**永远匹配不上**，两层原因叠加：
① 渲染器的 id 用 marked 的 `token.raw` —— 那是**净化后**的文本，公式已变成 `@@MATH_INLINE_42@@` 哨兵；
② MathJax 把 `\theta` 排版成字符 **θ**，而大纲标题是源码文本 `$(r,\theta ,z)$`。
修法：新增比对函数，把每个数学 span **还原成它的 `data-tex-source`**（源码比源码），
再对标记/空白免疫比较，并按出现次序取第 n 个（避免重名跳错）。

**验收**：真机 + 真实书实测 —— 大纲 396 项，逐个点击 5 个含公式的标题 **5/5** 落在自身标题上；
新增 5 项单测（粘连 `$$` 的 1/2/3 个 + 真实行间块，其中"三个粘连"用例忠实复现了标题被吞）；
单测 96 项；渲染护栏 6/6。

**对文件的建议**：`$a$$b$` 本身就是歧义写法（转换工具产生）。应用现在按"两个相邻行内公式"解读，
这是更安全的读法；合并类工具若要更干净，可在产出前把相邻行内公式之间补一个空格
（或由校验关卡提示，见 `lossless-markdown-book-merging`）。

---

### 12.9 【已修】渲染保险：行内公式不得跨过 HTML 标签

**背景**：上游转换把 `<img alt="…">` 在公式中间截断（skill `lossless-markdown-book-merging`
的 `caption_text[:100]`，已在 skill 侧修正），属性里留下**落单的 `$`**。

**为何会毁全文**：行内公式的内容模式是 `(?:\\.|[^$])+?` —— 除 `$` 外什么都允许，可跨换行、跨标签。
于是落单的 `$` 与很后面（跨段）的 `$` 配对，把中间的 `" width=…>`、`</figcaption>`、`</figure>`
连同正文**全部当作公式吞掉**：figure 块消失，其后所有公式奇偶性错位。
实测一本合并书里同类截断 **7 处**，每处都毁掉其后的整页。

**修法**：让内容**不能跨过"格式正确的标签开头"**（复用 `isInsideHtmlTag` 用的 `HTML_TAG_OPEN`
正则、剥掉 `^` 锚）：配对失败时 `String.replace` 不会消费那个 `$`，`trackedReplace` 的记账
自动保持正确。裸 `<`（`\sum_{l<m}`、`a<b`）不是标签开头，**不受影响**。

**验收**：新增 4 项回归测试（真实截断 alt 场景），修前 3/4 失败 → 修后 9/9；
拿**那份有缺陷的旧书**跑真实渲染器：`</figure>` 从"被吞"→ 保留、裸 `</figcaption>` 消失、
`$n$` 恢复为正确公式 span；完整单测 77/77；渲染护栏 6/6（含换行等价）。

**排查中踩到并纠正的三个测量陷阱**（每个都先给出过错误结论，值得复用）：
1. **后台/隐藏窗口里 `requestAnimationFrame` 不触发** —— 落点写在 rAF 里，探针会误报大面积失败。
   必须先 `Page.bringToFront`（并断言 `document.hidden === false`）。
2. **"实际偏移 vs 元素锚点"是假通过指标** —— 两边处于同一错误空间时误差互相抵消，看起来全对。
   必须比对**落点处的文字**。
3. **用"去掉公式后拼接的短语"在源码里搜是假阴性** —— 源码里公式是真实字符，任何跨越公式的短语
   只存在于一侧。必须按**词**比对。
## 13. Android 移动端移植（分支 `feat/android-port`）

### 13.1 工具链版本（每一条都有出处，不是"建议值"）

| 组件 | 版本 | 出处 |
|---|---|---|
| Android Studio | Rabbit 1 / **2026.2.1** | 官方页面标注 "latest version in the **stable** channel" |
| JDK | Android Studio 自带 `jbr`（实测 OpenJDK **25.0.3**） | Tauri 前置文档要求 `JAVA_HOME` 指向 jbr |
| Gradle wrapper | **9.6.1** | Tauri 模板 |
| AGP | **9.3.1** | Tauri 模板 |
| SDK Platform | **37** | 模板 `compileSdk = 37` / `targetSdk = 37` |
| Build-Tools | **36.0.0** | AGP 兼容表默认值 |
| NDK | **30.0.16248370**（本机） | AGP 默认是 `28.2.13676358`，见 13.2 |
| Command-line Tools | `latest` | Tauri 前置清单要求；提供 `sdkmanager`，且 Tauri 会用它自动装 NDK |

三个环境变量（Windows 用户级）：`JAVA_HOME` → Android Studio `\jbr`；`ANDROID_HOME` → SDK 根；`NDK_HOME` → `%ANDROID_HOME%\ndk\<版本>`。
注意：**注册表里新设的变量当前 shell 会话继承不到**，跑 `tauri android …` 前要在会话里 export 一次。

JDK 版本不会撞墙的依据：Tauri CLI 的 `gradle_max_supported_java("9.6.1") = 26`（源码 `check_java_gradle_versions.rs`），
所以 Java 25 在 Gradle 9.6.1 的支持范围内，不会打印那条 "can only run on Java up to …" 警告。

### 13.2 必须钉 `ndkVersion`（真踩过的坑）

- Tauri 的 android 模板 `app/build.gradle.kts` **不设 `ndkVersion`**（tauri-cli 2.12.1 模板全文确认）；
- `tauri.conf.json` 的 schema 里**没有任何 ndk 配置项**（grep 确认）——所以只能改生成出来的 gradle。
- 后果：AGP 回退到**它自己的默认 NDK**（9.3.1 → `28.2.13676358`）。本机装的是 30.x，于是要么再下载一份数 GB 的 NDK，要么报 `NDK not configured`。
- **Rust 侧没有这个问题**：Tauri CLI 自己发现已装 NDK，日志会打印 `Info Using installed NDK: …`，并读 `NDK_HOME`。
- 因此把 gradle 侧钉到**同一个** NDK，避免 C/C++ 与 Rust 两半工具链版本错位。

改动位置：`src-tauri/gen/android/app/build.gradle.kts` 的 `android {}` 块内 `ndkVersion = "30.0.16248370"`。
**升级 NDK 后要同步改这一行**（改完重跑 `tauri android build`）。

### 13.3 生成物 `src-tauri/gen/android` 是要入库的

**不要**把整个 `src-tauri/gen/` 加进 `.gitignore`：

- 依据：Tauri 模板**自带** `gen/android/.gitignore`，而它只忽略构建产物（`build`、`.gradle`、`local.properties`、`key.properties`、`.tauri` 等）。
  这个内层忽略文件的存在本身就说明**项目骨架应当提交**（否则没必要在其中放 .gitignore）。
- 体量很小：40 个文件 / **373 KB**。
- 其中 `app/src/main/AndroidManifest.xml`、`app/src/main/java/.../MainActivity.kt`、`buildSrc/.../RustPlugin.kt`
  正是后续 intent 关联、权限、返回键要动的地方，必须版本可控。
- 例外：`src-tauri/gen/schemas` 仍然忽略（tauri-build 每次构建重建 ACL schema）。

> **2026-10-20 补：这条纪律曾被 `.gitignore` 违反过，而症状是"静默的"。**
> `.gitignore` 里当时有一条兜底的 `src-tauri/gen/`（§8.6.1 的 446 MB 事故之后加的）。
> 它和本节直接冲突，危险之处在于**已跟踪的文件不受忽略规则影响** —— 所以 41 个骨架文件照常
> 可提交、看起来一切正常；但**任何新增文件都会被静默忽略**：`git status` 什么都不显示，
> 你以为提交了、其实 git 从没见过它（改 manifest、加一个 Kotlin 文件都会中招）。
> 已替换为按目录的精确规则：`src-tauri/gen/android/**/build/`、`.gradle/`、`local.properties`、
> `key.properties`、`keystore.properties`、`.tauri/`、`tauri.settings.gradle`、
> `app/src/main/java/**/generated/`、`app/proguard-tauri.pro`、`app/src/main/jniLibs/`。
> 模板自带的内层 `.gitignore` 仍是第一道防线；§8.6.1「提交范围显式列举、禁用 `git add -A`」照旧。

### 13.4 Android 平台约束（已核实的支持矩阵，逐项来自官方文档）

| 能力 | Android | 备注 |
|---|---|---|
| `updater` / `single-instance` / `process` | ❌ 不支持 | 桌面专用 → 必须 `#[cfg(desktop)]` 或按平台隐藏 |
| `dialog` | ✅ | **不支持文件夹选择器** → 桌面"工作区目录树"无法移植 |
| `file-system` | ✅ | **默认只能访问应用目录**；但 `dialog.open()` 返回的 `content://` 它"支持任意路径格式"，可直接读写 |
| `opener` / `shell` | ✅ | **只能打开 URL**（`reveal-item-in-dir` 不可用） |

两条容易走错路的结论：

1. `RunEvent::Opened { urls }` **存在且 Android 会派发**（`tauri-2.12.1/src/app.rs:263`，门控
   `#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]`；派发链
   `tao-0.35.3/src/platform_impl/android/ndk_glue.rs:665` → `mod.rs:285`）。
   docs.rs 的默认构建文档里**看不到**这个变体（被 cfg 门控），只看文档会误判成"做不了"。
   → "用 MarkdownX 打开 .md" **纯 Rust 可实现，不必写 Kotlin 插件**，且可复用桌面已有的 `open-file-from-cli` 事件。
2. `fileAssociations` 原生支持 Android：配置项含 `androidIntentActionFilters`（`view`/`send`/`sendMultiple`）、`mimeType`、`role`。

### 13.5 Rust Android 目标

需要四个（`aarch64` 现代手机 / `armv7` 老 32 位机 / `i686` 与 `x86_64` 模拟器）：

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

坑：`rustup target add` **被中断**（例如超时强杀）会留下半截文件，之后重装报

```
error: failed to install component: 'rust-std-aarch64-linux-android',
detected conflict: 'lib\rustlib\aarch64-linux-android\lib\libaddr2line-*.rlib'
```

处理：删掉 `<toolchain>/lib/rustlib/<target>` **以及**同目录下的 `manifest-rust-std-<target>`，再重装。
装好的正常形态是「目录 + 对应 manifest」成对，且 `lib/*.rlib` 约 55 个。

### 13.6 `tauri android init` 的行为（实测，反直觉）

- **可重复运行**：工程已存在时不会报错，会再跑一遍并打印 `Project generated successfully!`。
- **不覆盖已存在的生成文件**：`app/build.gradle.kts` 里的 `ndkVersion` 钉子在重跑 init 后**依然在**。
  但**删掉**某个生成文件再跑 init，它会被按模板重新生成（实测删 `AndroidManifest.xml` 后重建，内容与之前逐字节一致 → init 是确定性的）。
- **intent-filter 在「构建时」生成，`init` 时不会**（此条先前的判断是错的，实测纠正）：
  先在配置里写好 `mimeType` + `androidIntentActionFilters`，然后跑 `tauri android build`，
  CLI 会往 `app/src/main/AndroidManifest.xml` 注入带标记
  `<!-- tauri-file-associations. AUTO-GENERATED. DO NOT REMOVE. -->` 的 `<intent-filter>` 块
  （`VIEW`/`SEND` 动作 + `android:mimeType` + 每条扩展名的 `android:pathPattern`）。
  **只跑 `tauri android init` 是看不到的** —— 本次就因为只在 init 后检查，误判成"Tauri 不生成、必须手改"。
  → 结论：靠配置即可，「用 MarkdownX 打开 .md/pdf」不需要手写 manifest；但**该块要跑一次 build 才会落地**。
  → `mimeType` 是关键：主配置里原有条目只有 `ext`/`name`/`role`，**没有 mimeType 就不会生成 intent-filter**，
    所以必须在 `tauri.android.conf.json` 里补上（已补）。

### 13.6.1 Windows 上构建 Android 需要符号链接权限（卡住整条构建）

`tauri android build` 在 Rust 编译完成后，会把产物 `.so` **以符号链接**放进
`gen/android/app/src/main/jniLibs/<abi>/`（CLI 会打印 `Info symlinking lib "…" in jniLibs dir "…"`）。
Windows 默认不允许非管理员创建符号链接，于是整条构建在这里中止：

```
failed to build Android app: Failed to create a symbolic link from "…\libmarkdown_x_lib.so" to file
"…\gen/android/app/src/main/jniLibs/arm64-v8a\libmarkdown_x_lib.so" (file clobbering enabled):
Creation symbolic link is not allowed for this system.
For Windows 10 or newer: You should use developer mode.
```

实测过的**无效**绕法：

- 预先在 jniLibs 里放好同名文件 → 无效（`file clobbering enabled`：它会先删掉再建链，仍失败）。
- CLI 里没有任何 copy 回退，也没有 `TAURI_*SYMLINK*`/`TAURI_*COPY*` 之类的环境变量开关（二进制里 grep 过）。

有效解法（二选一，都需要用户配合，普通权限的 shell 做不到）：

1. **开启开发者模式**：设置 → 隐私和安全性 → 开发者选项 → 开发者模式 = 开（或管理员执行
   `reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f`）。
2. **用管理员权限的终端**跑构建。

自查命令（应输出 `SYMLINK OK`）：

```powershell
New-Item -ItemType SymbolicLink -Path "$env:TEMP\l.txt" -Target "$env:TEMP\t.txt"
```

补充：debug 的未 strip 产物很大（本机实测 `libmarkdown_x_lib.so` **153 MB**），这也是 CLI 选择建链而非复制的原因。
另注意 `app/.gitignore` 已包含 `/src/main/jniLibs/**/*.so`，即使误复制也不会入库。

### 13.6.2 首次构建踩到的一串环境问题（均为实测，含绕法）

按发生顺序记录，每条都真的卡过：

1. **`buildSrc` 是独立子构建，插件解析不走 root 的仓库**。
   它在解析自己的 `kotlin-dsl` 插件时默认用 `gradlePluginPortal()`（`plugins.gradle.org`）。
   本机访问该站会 303 重定向到 `repo.maven.apache.org`，而重定向后的地址 Gradle 的 JVM
   完成不了 TLS 握手（`Remote host terminated the handshake`），整个构建在
   `A problem occurred configuring project ':buildSrc'` 处中止。
   → 修法：新增 `src-tauri/gen/android/buildSrc/settings.gradle`，在 `pluginManagement` 里把
   `mavenCentral()` 排在 `gradlePluginPortal()` **之前**（该 artifact 本来就在中央仓库）。
   注意 `gradle.properties` 开了 `org.gradle.configuration-cache=true`，改完要等一次构建让缓存失效，
   否则会**复用旧配置、看起来像没生效**。

2. **需要 `platforms;android-36`**。`:tauri-android` 模块 `compileSdk` 是 36，而 app 模块是 37，
   只装 37 会在 `:tauri-android:compileDebugJavaWithJavac` 处报
   `Failed to install the following SDK components: platforms;android-36`。

3. **gradle 的 RustPlugin 要调用 `npm`**。`buildSrc/.../BuildTask.kt` 实际执行
   `npm run -- tauri android android-studio-script --target <abi>`，并在 Windows 上依次回退
   `npm` → `npm.exe` → `npm.cmd` → `npm.bat`，**四个都失败时抛出的是最后一个**，所以报错显示
   `'command 'npm.bat''` + `CreateProcess error=2` —— 极具误导性（npm.cmd 其实是存在的）。
   确定性的最后错误是：
   ```
   java.io.IOException: Cannot run program "npm.bat" (in directory "…\src-tauri"):
     CreateProcess error=2, 系统找不到指定的文件。
   ```
4. **绕法（.so 已就绪时）**：Tauri CLI 已经编译好并 symlink 好 `.so`，可以跳过那四个任务直接装配：
   ```bash
   cd src-tauri/gen/android
   ./gradlew :app:assembleDebug -x rustBuildArm64Debug -x rustBuildArmDebug \
     -x rustBuildX86Debug -x rustBuildX86_64Debug
   ```
   实测 `BUILD SUCCESSFUL`，产出 `app/build/outputs/apk/<abi>/debug/app-<abi>-debug.apk`。
5. **产物体量预期**：debug 未 strip 的 `libmarkdown_x_lib.so` 达 **153 MB**，所以
   `arm64` debug APK **154 MB**、`universal` debug APK **570 MB**（四个 ABI 各一份）。
   这是 debug 正常现象，release 会 strip，体量会小一个量级 —— 不要把它当成缺陷。

### 13.6.3 改前端后如何快速重出 APK（含一个体积翻倍的假象）

- **前端是被编进 Rust 库的**：`tauri::generate_context!` 把 `frontendDist` 嵌进二进制，
  所以**只改前端也必须重编 `.so`**，不能只重跑 gradle。最小步骤：
  ```bash
  npm run build                                   # 前端 → dist
  cd src-tauri && cargo build --target aarch64-linux-android
  cd gen/android && ./gradlew :app:assembleDebug --console=plain \
      -x rustBuildArm64Debug -x rustBuildArmDebug -x rustBuildX86Debug -x rustBuildX86_64Debug
  ```
  手动编 Rust 时要自己带上 Tauri 平时注入的两个变量，否则在链接期报 `program not found`：
  ```
  CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd
  CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS=-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES
  ```
- **不需要再提权**：`jniLibs/<abi>/libmarkdown_x_lib.so` 已是指向 `target/…` 的符号链接，
  重编直接生效。
- **体积翻倍的假象**：实测有一次 APK 从 154MB 变成 **304MB**，而 `unzip -l` 里所有条目
  合计仍只有 ~166MB —— 说明是**覆盖写入留下的陈旧数据**，不是真的变大。
  处置：先 `./gradlew --stop`（守护进程常占着文件，`rm` 会报 `Device or resource busy`），
  再清掉 `app/build/outputs/apk` 重跑。重建后 165MB，与内容合计相符。
  判据：`ls -la` 的大小与 `unzip -l` 的合计**应当接近**，差 100MB 以上即为异常。

### 13.6.4 真机 UI 调试配方（adb reverse + CDP），以及"按钮点不动"的真因

**手机上的"上面的按钮无法点击"，根因不是按钮小，而是整个应用被挤成了 85px。**

真机实测（OnePlus，视口 350x805 CSS px）：手机端侧栏仍是**桌面式内联**布局，
`width: 260px` 钉在 flex 行里，于是 `.app-col`（顶栏 + 编辑 + 预览）只剩 **85px** ——
除前两个按钮外，全部塌成 `0x0`，物理上根本没有可点区域。

修复：手机端侧栏改为 `position: fixed` 覆盖层（内联宽度只在桌面应用）、
`.sb-splitter` 在手机端 `display:none`（它无条件渲染，关闭态仍占 22px 并盖住按钮）、
手机端侧栏默认关闭、顶栏 30px→44px。

注意 App.css 里**本来就有按宽度裁减工具栏**的规则，手机（350px）会命中：
`.wb-tb-center`（<860px）与 `.wb-edit-cluster`（<680px）被 `display:none`。
所以"某些按钮 0x0"是**按设计隐藏**，不是缺陷 —— 诊断时要按
`offsetWidth > 0` 区分"可见但不可点"与"本来就隐藏"。

**真机调试配方（改前端后不用重打 APK 就能在手机上看到）**：

```bash
adb reverse tcp:1420 tcp:1420          # 手机的 localhost:1420 → 本机 dev server
# 本机 dev server 必须监听 IPv4！vite 默认只绑 ::1，而 adb reverse 连的是 127.0.0.1，
# 否则手机上表现为 net::ERR_EMPTY_RESPONSE
npm run dev -- --host 127.0.0.1
adb shell am force-stop com.markdownx.editor && adb shell am start -n com.markdownx.editor/.MainActivity
# 转发 WebView 的调试端口到本机，复用桌面那套 CDP 探针
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>   # pid 见 ps -A | grep markdownx
curl http://127.0.0.1:9222/json
```

两条经验：`adb shell svc power stayon true` 防止息屏后系统回收进程（会让探针误判成"崩溃"）；
`adb shell cat /proc/net/unix | grep webview_devtools_remote` 拿 socket 名（用 pid 拼）。

**另外：debug 包不是独立可用的。** debug 构建里 Tauri 会去加载 `devUrl`
（`http://localhost:1420`），所以脱离 dev server 时手机上只显示
`Failed to request http://localhost:1420/`。要一个能独立安装运行的包必须做 **release 构建**
（前端嵌入二进制、且会 strip，体积也小得多）。

### 13.6.5 手机端按钮"点了没反应"的三种真因（真机实测）

用真机 + 真实输入事件（`Input.dispatchMouseEvent`，不是合成 `click()`）逐个点出来的：

1. **`window.print()` 在 Android WebView 里是无实现的空操作**。
   「打印/导出」按钮最终调 `window.print()`（见 `handlePrint`），所以手机上点了
   既不报错也没反应 —— 控制台干净、前台 Activity 不变。PDF 打印走 iframe
   `contentWindow.print()`，同样无实现。
   → 手机端该按钮改为展开**导出菜单**（HTML/Word/LaTeX/PDF 都是写文件 + SAF 保存，
   在安卓上是通的）。
2. **系统状态栏压住顶栏**：Android 15+ 强制 edge-to-edge，实测
   `env(safe-area-inset-top) = 33px`，而应用外壳从 y=0 铺满 →
   顶栏 0..56、左栏首按钮 2..46 的上半部都在系统栏底下。用
   `env(safe-area-inset-*)` 给 `.typora-shell` 与移动端抽屉让位。
3. **窄屏规则把入口整片隐藏**：`@media (max-width:1080px)` 里的
   `[data-optional="true"]` 隐藏了「偏好设置」；`<860px` 隐藏 `.wb-tb-center`；
   `<680px` 隐藏 `.wb-edit-cluster`。手机端需要保留的入口要显式加
   `wb-mobile-keep` 并用更高特异性覆盖。

**探针纪律（这次踩到的假阴性）**：探针点「保存」得到"无反应"，
真实原因是**侧栏抽屉当时开着**（x 0..295），点击落在抽屉上而不是按钮上。
坐标点击前必须断言 `document.elementFromPoint(x, y)` 的最上层元素就是目标
（`topmost === 目标`），否则会把"被遮挡"误判成"按钮坏了"。
另外：按可变的 `title` 文案找按钮不安全 —— 手机端标题改了（打印→导出）就找不到了，
应改用稳定的 `data-*` 选择器。

### 13.6.6 手机端"打印不可用"与"PDF 打开不渲染"（真机实测）

**打印**：`Webview::print()` 在 tauri 里是 `#[cfg(desktop)]`，且注释自述"Currently only
supported on macOS on wry"，最后一句 "`window.print()` works on all platforms" 在 Android 上是**错的**
—— WebView 没有 print 实现，`window.print()` 是静默空操作（不报错、界面无变化）。
`core:webview:allow-print` 权限在移动端存在，但它守护的 API 被编译掉了（又一处"有权限、无 API"）。

**v2.6.1 已实现真正的安卓系统打印**（§13.9）：Kotlin 侧 `PrintManager` +
`WebView.createPrintDocumentAdapter()`，跑的是与桌面相同的 Chromium 打印管线，所以 `@media print`
样式表原样生效。此条保留作为"为什么必须自己写 Kotlin"的证据链。

**PDF"打开不渲染"**：真机实测根因**不是没渲染，而是渲染得太宽**。
实测：查看器宽 303px，而 canvas 按 `cssW=744`（A4 @96dpi 自然宽度）绘制 →
用户看到的只是页面**左上角的空白页边距**，所以像"什么都没渲染"。
（像素证据：首次打开时 canvas 有 337 个非白采样点、34 个文本层 span —— 内容其实画出来了。）
修法：手机端首次加载时按容器宽度做一次 fit-width（一次性，之后用户自己的缩放优先），
keyed on `body.host-mobile` 而非视口宽度，以免窄桌面窗口被误改。

**顺带修掉一个既有隐患**：`renderPageInto` 里 `gen` 代次检查写在 `await page.render().promise`
**之后**，而 pdf.js 禁止在未完成的 canvas 上再次 render，于是任何"渲染途中改动缩放"
都会抛 `Cannot use the same canvas during multiple render() operations` 并把该页位图毁掉。
改为保存 RenderTask 并在代次推进时 `cancel()`；取消导致的 `RenderingCancelledException`
按预期吞掉。修完真机复测：清空错误数组后重开 PDF，新增错误 **0**，三页 canvas 均 285x404。

### 13.6.7 手机端"图多的 PDF 黑屏/打不开"= 被系统 LMK 强杀（真机实测）

用户反馈：本机某 PDF 无法渲染；含图片的 PDF 直接黑屏。

真机取证（`logcat`）：
```
I/Zygote: Process 11116 exited due to signal 9 (Killed)
I/Zygote: Process 11859 exited due to signal 9 (Killed)
```
**signal 9 是被低内存杀手强杀**，不是崩溃 —— 没有 FATAL、没有 ANR、没有 JS 异常。
对照 `dumpsys meminfo`：打开一个扫描件前 PSS 200MB / RSS 393MB，
打开后 PSS **321MB** / RSS **559MB**（+121MB PSS），而 **canvas 位图总共只有 9MB**。
→ 内存不是 canvas 吃掉的，是 **pdf.js 解码的页面图片**：一张 300dpi 的 A4 扫描页解码后约 **35MB**，
而代码里**从不调用 `doc.cleanup()`**，解码图一直留在内存里。

两处修复（`src/pdf/PdfViewer.tsx`）：
1. **栅格化 DPR 设上限**：`Math.min(devicePixelRatio, 2)`。手机上报 3.25，位图内存是 CSS 面积的
   10.6 倍；实测单页位图 926x1309(4.6MB) → 570x806(**1.8MB**)，省 61%。
2. **渲染稳定后调度 `doc.cleanup()`**（700ms 防抖，渲染前取消待执行项，避免在渲染途中释放）。
   它只释放"当前不再引用"的资源，所以可见页的图仍在内存里 —— 这一步是防止**多页/多标签累积**。

真机复测（修复后）：
```
nature.pdf (25MB 论文)  3 页 570x758  非白 818/1321/837  平均亮度 232-237  文本层 950  ✓ content
multi.pdf  (6.2MB)      3 页 574x752  非白 1737/1056/838 平均亮度 233-243  文本层 1164 ✓ content
scan2.pdf  (扫描件)      3 页 570x808  非白 454/310/471   平均亮度 250-252  文本层 0    ✓ content
错误 0，进程存活
```
判定口径：`dark/sampled > 0.9` 判为 BLACK SCREEN，`nonWhite/sampled < 0.002` 判为 BLANK，
其余为 content —— 避免只用"非白像素"一个指标把黑屏误判成"有内容"。

**遗留**：连续打开 4 个 PDF 后 PSS 达 459MB，仍偏高。更重的文档或后台内存紧张时仍可能被强杀；
进一步措施是把移动端渲染窗口收窄到可见页 ±1，以及限制同时打开的 PDF 标签数。

### 13.6.8 「用打开按键打不开 PDF」= SAF URI 没有扩展名（真机实测）

`isPdfPath()` 只看扩展名（`/\.pdf$/i`），而**系统文件选择器返回的是 SAF content URI**，
形如 `content://com.android.providers.downloads.documents/document/1234` —— **没有 `.pdf` 后缀**。
于是 PDF 被判成普通文本，走文本分支去读二进制 → 打不开。

**为什么之前没发现**：桌面与真机自测用的都是带 `.pdf` 的真实路径（`/data/.../test-3p.pdf`），
只有走系统选择器选文件才会暴露。复现方式：把一个 PDF 复制成无扩展名文件再打开 ——
实测 `noext` 打开后是普通文档标签且 `pdfViewer=false`，而 `test-3p.pdf` 正常。

修法：**扩展名不够时按文件头嗅探**（`%PDF`，与加载器已有的校验同一规则）。
`src/pdf/openPdf.ts` 新增 `readIfPdf(path)`：用**已授权的 `readFile` 读一次**并返回字节
（若像 PDF），调用方复用它，避免读两遍。

**踩到的权限坑**：最初用 `plugin-fs` 的 `open()` + `FileHandle.read()` 只读前 1KiB，
但 **`fs:allow-open` 没有授予移动端 capability**（我写的 mobile.json 只有
read/write-text-file、read/write-file、read-dir、exists、mkdir），调用被拒 →
`sniffPdf` 静默返回 false，表现为"改了却仍然打不开"。
**权限是编译进二进制的，改权限要重新打包**，所以改用已授权的 `readFile`。
（若日后加了 `fs:allow-open`，可改为只读前 1KiB 以免整读大文件。）

验证：真机 `noext3`（内容是 PDF 的无扩展名文件）→ `pdfViewer=true`、3 个 canvas、无错误；
`test-3p.pdf` 仍正常。新增 6 条 `looksLikePdf` 单测（含"头部在 1024 字节窗口内/外"的边界）。

**遗留**：SAF URI 里没有文件名，标签页名会显示文档 id（如 `1234`）。
要拿到真实文件名需查询 provider 的 `_display_name`（需要原生侧支持）。

### 13.6.9 折叠屏兼容与"编辑按钮和设置重叠"（真机实测）

**重叠**：打开 PDF 时顶栏出现 7 个标注工具（选择/高亮/下划线/删除线/便签/墨迹/橡皮），
它们和固定动作挤在同一行、该行不换行。实测（外屏 350px 视口）：
行宽到 x=470，于是「墨迹」(x=382)、「橡皮」(x=427) **超出视口不可点**；
而「偏好设置」被钉在右端，**压在工具上面** —— 与「删除线」重叠 37x44px、与「便签」6x44px。

修法：手机端让 `.pdf-tool-icons`（该容器本就存在，无需改 JSX）单独成行
（`.wb-topbar { flex-wrap: wrap; height: auto }` + 工具簇 `flex: 1 1 100%`）。
实测重叠数 **0**、14 个按钮全部回到视口内。
**用 `flex-wrap` 而非 `overflow-x: auto`**：后者会把交叉轴也变成 auto，
裁掉挂在同一行的导出下拉菜单（本手册已记录过这个坑）。
遗留（美观问题）：顶栏因此变成约 195px、最多 4 行；正解是把标注工具移到底部工具条，
属于移动端重设计的一部分。

**折叠屏**：本机是 OnePlus PKH110（书本式折叠）。结论：
- **布局自适应**：用 CDP `Emulation.setDeviceMetricsOverride` 模拟外屏 350 / 内屏 760 /
  半开 900x480，三种尺寸下溢出按钮均为 **0**，`body` 平台类恒为 `host-mobile`，
  各区域随宽度重排。
- **翻折不丢状态**：`AndroidManifest.xml` 的 `configChanges` 已含
  `screenSize|smallestScreenSize|screenLayout|orientation`，Activity 不会重建。
- **修掉一个真问题**：PDF 展开后**不会重新适配宽度**（内屏 712px 可用，页面仍是 285px）。
  原实现是"一次性 fit"。改为 `ResizeObserver` 监听容器宽度、变化超过 8px 且
  **用户未手动缩放过**时重新 fit（手动缩放永远优先）。
  实测：285(外屏) → 696(内屏) → 833(900px) → 285(折回)。
- 提示：顶栏可见按钮数随宽度变化（12 → 17 → 19），因为应用原有的按宽度媒体查询
  会逐步放出按钮；这是自适应行为，但折叠时工具栏形态会变。

### 13.6.10 【重要】`custom-protocol` —— 没有它，每个包都会去连 devUrl

**症状**：任何安装到手机上的包（debug/release 都一样）启动后只显示
`Failed to request http://localhost:1420/: error sending request for url`，
必须让电脑开着 dev server 才能用。

**根因**：`is_dev()`（tauri-build `src/lib.rs:607`）读的是 `DEP_TAURI_DEV`，其文档写明
*"compiled without the `custom-protocol` Cargo feature"*。即：

```
dev 标志 = 构建时没有启用 custom-protocol feature
dev 标志为真 -> 加载 build.devUrl（http://localhost:1420），而不是二进制里内嵌的前端
```

而本项目的 `Cargo.toml` **从来没有 `[features]` 段** —— `tauri build`（桌面）会自动带上
这个 feature，所以桌面端一直正常；**手动给 Android 打 cargo 包时没带，于是每个包都是"开发构建"**。
CLI 二进制里可见 `custom-protocoltauri/custom-protocol`，即 CLI 传的就是它。

**修法**：`Cargo.toml` 加
```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
```
手动构建时显式带上：
```bash
cargo build --release --target aarch64-linux-android --features custom-protocol
```

**判定是否生效的可靠信号（体积）**：同一次 release 编译，带 feature 后
`libmarkdown_x_lib.so` 从 **13.0 MB 变成 21.5 MB** —— 多出来的正是内嵌的前端资源。
APK 也从 14.7 MB 变为 23.2 MB。若体积没变大，说明前端没被嵌入，一定跑不起来。

**真机验证**：停掉 dev server、撤掉 `adb reverse` 后安装并启动 —— 界面完整渲染
（工具栏/标签页/编辑区/状态栏），无任何 `localhost:1420` 报错。
注意 release 包会关闭 WebView 调试（调试只在 debug 构建开启），因此 release 只能靠
`adb shell screencap` + 视觉确认，不能用 CDP 探针。

### 13.7 Android 平台配置 `tauri.android.conf.json`

- 文件名固定，Tauri CLI 会**自动查找并合并**（`--help` 原文：*"a platform-specific file is looked up and merged with the default file by default (… tauri.android.conf.json …)"*），
  合并遵循 JSON Merge Patch：**对象逐键合并，数组整体替换** —— 所以 `app.windows` 与 `fileAssociations` 必须在 Android 侧重新写一份，
  否则桌面那套 `minWidth: 800 / minHeight: 600 / decorations: false` 会原样带进手机端。
- **`bundle.targets` 不能写 `apk`/`aab`**：`BundleType` 枚举只有 `deb/rpm/appimage/msi/nsis/app/dmg`（schema 实测），
  Android 产物由 `tauri android build` 直接生成 APK 与 AAB，不走 `targets`。
- `bundle.android` 可配置项只有四个：`minSdkVersion`、`versionCode`、`autoIncrementVersionCode`、`debugApplicationIdSuffix`。
  `versionCode` 按官方公式算：`major*1000000 + minor*1000 + patch`（v2.4.3 → `2403000`），改版本号时要同步。
- 桌面 capability 的平台过滤**已实测生效**：探针在 Windows 上调用被 `fs:allow-read-text-file` 门控的插件命令成功返回，
  而一个不存在的命令返回 `not allowed. Command not found`（阴性控制项）——说明 `platforms` 取值（`windows`/`macOS`/`linux`，注意 macOS 大写 S）拼写正确。

---

### 13.8 【已修】Android 构建：`npm.bat` 失败的真因 + 两个被漏写的 codegen 产物

**症状**：`./gradlew :app:assembleRelease` 报

```
Execution failed for task ':app:rustBuildArm64Release' (registered by plugin 'rust').
> A problem occurred starting process 'command 'npm.bat''
```

**真因（不是 npm 没装）**：`buildSrc/.../BuildTask.kt` 先试 `npm`，失败后回退 `npm.exe` /
`npm.cmd` / `npm.bat`，最后抛出**最后试的那个**（`npm.bat`）—— 报错因此极具误导性。四种全部失败的
原因是 **Java 的 `CreateProcess` 只能启动真正的可执行映像，不能直接启动 `.cmd`/`.bat`**（必须经
`cmd.exe /c`）。所以 `npm.cmd` 明明存在却报 `CreateProcess error=2`。

**修法**（已入库）：Windows 上改为 `cmd /c npm ...`：

```kotlin
val windows = Os.isFamily(Os.FAMILY_WINDOWS)
runTauriCli(if (windows) "cmd" else "npm", if (windows) listOf("/c", "npm") else emptyList())
```

**副作用（这才是最坑的地方）**：此前用 `-x rustBuildArm64Release -x rustBuildArmRelease ...`
绕过该任务 —— 但**这个任务同时负责生成 Kotlin 代码**，跳过它会让 app 缺少
`TauriActivity`，于是所有 ABI 都报 `Unresolved reference 'TauriActivity'`，**根本打不出 APK**。
`BuildTask` 修好后不再需要任何 `-x` 绕法。

**两个 CLI 没有（重新）写出的 codegen 产物**（都是 crate 模板 + 占位符替换，且都在
`.gitignore` 里，因此干净检出必然缺）：

| 模板 | 目标 | 占位符 | 缺失后果 |
|---|---|---|---|
| `tauri-*/mobile/android-codegen/TauriActivity.kt` | `app/src/main/java/<包路径>/generated/` | `{{package}}` | Kotlin 报 `Unresolved reference 'TauriActivity'`（生成的 MainActivity 与它**同包**，所以模板里不写 import） |
| `tauri-*/mobile/proguard-tauri.pro` | `app/` | `$PACKAGE` | release 包装上后启动即崩：`NoSuchMethodError: MainActivity;.getPluginManager()Lapp/tauri/plugin/PluginManager;` —— R8 裁掉了 `PluginManager` 按名查找的方法 |

**复制时必须替换占位符**，否则 keep 规则不匹配（这次就因为直接复制模板、`$PACKAGE` 未替换而白跑一轮）。
已提供可重复执行的脚本：`python tools/android-codegen.py`（幂等，从 cargo registry 里按最高版本
自动定位模板，包名读自 `tauri.conf.json`）。

> **干净机器上必须先 `cargo fetch`**（2026-10-20 实测）：`android-codegen.py` 的模板取自
> cargo registry 里的 `tauri-<ver>/mobile/`，而新机器没跑过任何 cargo 命令时该目录不存在，
> 脚本会直接退出：`no cargo registry sources at C:\Users\<user>\.cargo\registry\src`。
> 在 `src-tauri/` 里先跑一次 `cargo fetch`（只下载依赖、不编译；`Cargo.lock` 已锁 tauri **2.12.1**），
> 再跑 codegen 就正常。**顺序不能反过来** —— 否则会误以为"脚本坏了"。

**可用的构建命令**（不再需要 `-x rustBuild*`）：

```bash
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="C:/Users/<user>/AppData/Local/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/30.0.16248370"
export PATH="/c/Program Files/nodejs:$PATH"     # gradle daemon 靠 PATH 找 npm.cmd
(cd src-tauri && cargo fetch)                    # 干净机器必需：填充 registry，见上方提示
python tools/android-codegen.py                  # 缺失时补两个 codegen 产物
npx tauri android build --apk --target aarch64
```

产物：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
（只构建了 arm64 的 `.so`，所以 universal 也只有 arm64 → 23.2 MB）。

**`versionCode`**：本次由 `2403000`(v2.4.3) 升到 `2407000`(v2.4.7)，沿用既有写法（注意本节上方记录的
"`major*1000000 + minor*1000 + patch`"公式算不出 `2403000`，实际沿用值才是准的）。

**`versionCode` 的真实公式（2026-10-20 复核）**：`major*1e6 + minor*1e5 + patch*1e3`，与历史值全部吻合
（2.4.3→2403000、2.4.7→2407000、2.5.0→2500000、2.6.0→2600000、**2.6.1→2601000**）。
本次先按 `patch*100` 误写成 2600100（数值仍递增，但会打乱后续排序），已改回 2601000 并重新出包。
`tauri.properties` 由 CLI 从 `tauri.android.conf.json` 写入；手改 conf 后必须让 CLI 再跑一次
（或同步改 `gen/android/app/tauri.properties`），否则 Gradle 仍用旧 versionCode。

---

### 13.9 Android 原生桥：系统打印 + 应用内 APK 更新（v2.6.1 实现）

两条硬事实决定了必须写 Kotlin：`window.print()` 在 Android WebView 里**无实现**（§13.6.6），
`tauri-plugin-updater` **不支持 mobile**（§13.4）。实现分三处，缺一处就是"点了没反应"：

| 位置 | 职责 |
|---|---|
| `src-tauri/gen/android/app/src/main/java/com/markdownx/editor/MobileExtrasPlugin.kt` | Kotlin 侧：`printDocument` / `fetchText` / `installUpdate` / `downloadState` |
| `src-tauri/src/lib.rs`（`#[cfg(target_os = "android")]` 段） | 注册 Kotlin 类、`run_mobile_plugin` 转发、清单端点从配置读回 |
| `src-tauri/src/android_update.rs` | 清单解析 + 版本比较（**无 cfg，宿主 `cargo test` 覆盖**） |

**调用链与命名必须一致**：

```
JS: invoke('native_print' | 'android_update_check' | 'android_update_install' | 'android_update_progress')
  → lib.rs: #[tauri::command] → PluginHandle::run_mobile_plugin("<method>", payload)
  → Kotlin: @Command fun <method>(invoke: Invoke)      ← 方法名就是 run_mobile_plugin 的字符串
```

**为什么是 app 命令而不是 `plugin:` 命令**：`tauri/src/webview/mod.rs` 对**任何** `plugin:` 前缀的命令
都强制走 ACL（`if plugin_command.is_some() || has_app_acl_manifest || !is_local`），而本应用没有 app 级
ACL manifest、请求来自 local origin，app 命令直接放行。所以桥的四个命令**不需要**任何 capability 条目，
也就没有"权限给了、命令仍被拒"这一类故障。Kotlin 类仍然需要一个 **Tauri 插件壳**，因为
`register_android_plugin` 只存在于 `PluginApi` 上；这个壳叫 `markdownx-mobile`，**不声明任何命令**。

**打印**（`MobileExtrasPlugin.printDocument`）：

1. `PrintManager.print(jobName, webView.createPrintDocumentAdapter(jobName), null)`；jobName 带时间戳，
   因为系统保留打印历史、重名会让连续两次打印难以分辨。
2. 它跑的是与桌面相同的 Chromium 打印管线 → **`@media print` 样式表原样生效**（不变量 3 继续成立：
   界面元素本来就被那张表隐藏、版心铺平、A4 分页）。输出等于桌面那份，不是手机截图。
3. **打印期间绝不改 DOM**：适配器要等用户在系统对话框里确认之后才抓取 WebView。所以"打印前加个
   body class、打完立刻删"这种做法在这里是错的 —— 也正是打印样式表独自完成排版的原因。
4. 命令本身只把任务丢到主线程并立刻 resolve；`run_mobile_plugin` 不会等到用户按"打印"。
5. **手机端 PDF**：打印样式表故意 `display:none` 掉查看器，iframe 路径的 `contentWindow.print()`
   同样无实现，所以手机端该按钮改为**导出压平副本**（`handleExportFlattenedPdf`），菜单文案随文件类型变。

**更新**（`fetchText` / `installUpdate` / `downloadState`）：

1. 清单是**同一份 `latest.json`**：APK 是 `platforms` 里多出的 `android-universal` 一项，
   桌面与手机因此不可能对同一版本号有两种说法。签名字段只对 Windows 有意义（minisign）；
   APK 不是 minisign 签的 —— 它的完整性由 **PackageManager 校验签名证书**保证，证书不符系统直接拒绝安装。
2. 端点不写死在 Kotlin 里：`lib.rs` 从**合并后的运行时配置**读 `plugins.updater.endpoints`
   （即 `tauri.conf.json` 那一处，唯一真源），再依次尝试。
3. 版本比较在 Rust（`android_update::compare_versions`，数值逐段比较，`2.10.0 > 2.9.9`；
   预发布 `2.7.0-beta.1` 不会被当成比 `2.7.0` 新）；网络在 Kotlin（`HttpURLConnection`，不引入
   reqwest 这类要从零交叉编译的依赖）。
4. 下载到 `cacheDir/updates/MarkdownX-<ver>.apk`（`.part` 临时文件 + 长度校验后改名），
   旧包在下次下载时删除。进度写在 `@Volatile` 字段里，JS 每 600ms 轮询 `android_update_progress`。
5. 安装：`FileProvider(applicationId + ".fileprovider")` 取 `content://`（模板里已有 `cache-path` 根，
   所以**不需要**额外存储权限），`ACTION_VIEW` + `application/vnd.android.package-archive` +
   `FLAG_GRANT_READ_URI_PERMISSION`。
6. 权限：manifest 里 `REQUEST_INSTALL_PACKAGES`，外加用户一次性授权「安装未知应用」；
   **下载前**就检查并在未授权时跳转设置页，避免白花 20+ MB 流量。
7. 调试包换钥匙的后果：Android 要求升级包与被装包**同一签名证书**。本机 `~/.android/debug.keystore`
   是本次会话生成的；若手机上是别的密钥签的旧包，安装会失败，需要先卸载旧包（会丢 localStorage 偏好）。

**R8 不能把插件类裁掉**（这类故障只在真机复现）：release 开了 R8，而插件类**只被 JNI 按名查找**。
`tauri-android` 的 `consumer-rules.pro` 里有
`-keep @app.tauri.annotation.TauriPlugin public class * { @app.tauri.annotation.Command public <methods>; ... }`，
所以 app 自己的 `@TauriPlugin` 类会自动保留。**已实测**（从产物 `classes.dex` 里按字节搜索）：
`com/markdownx/editor/MobileExtrasPlugin`、`printDocument`、`fetchText`、`installUpdate`、`downloadState`、
以及 `Lapp/tauri/annotation/Command;` / `Lapp/tauri/annotation/TauriPlugin;` 注解串都在。
升级 tauri 版本或改动 consumer rules 后，这条检查必须重做 —— 否则运行时报
`No command printDocument found for plugin`。

**验证边界（必须说清楚，别把"编译过"当"能用"）**：

- **已验证**：`tsc` 0；单测 204 项（新增 `updaterAndroid.test.ts` 8 项）；护栏 6/6 + 换行 6/6；
  Rust 单测 10 项（含 `android_update` 7 项）；`cargo build --release --target aarch64-linux-android`
  （55.85s，含 `register_android_plugin`）；`:app:assembleUniversalRelease` → BUILD SUCCESSFUL
  （Kotlin 编译通过）；APK badging `versionCode='2601000' versionName='2.6.1'` +
  `uses-permission REQUEST_INSTALL_PACKAGES`；dex 检查见上；桌面 NSIS 2.6.1 同时产出。
- **未验证（无真机，必须由用户实测）**：系统打印对话框里的真实输出、下载—安装整条流程。
- **真机验收清单**：
  1. 打开 md →「全部功能」→「打印…」→ 系统打印面板出现 →「另存为 PDF」→ 检查输出无顶栏/侧栏、A4 分页；
  2. 「检查更新」→ 应看到 2.6.1（前提是已发布 2.6.1 资产）→「下载并安装」→ 系统安装器 → 装完关于页显示 v2.6.1；
  3. 首次点安装若被拦：允许「安装未知应用」后回来再点一次（进度与错误都显示在更新弹窗里）；
  4. 排障：`adb logcat` 过滤 `Tauri/MobileExtrasPlugin` 看失败原因；
     `adb shell dumpsys package com.markdownx.editor | findstr version` 看实际版本。

### 13.10 v2.6.1 已发布（2026-10-20）：APK 拉不到更新的根因与修复

**根因（"APK 无法直接从 GitHub 上拉取更新"）**：发布用的 `latest.json` 里 `platforms` 只有
`windows-x86_64` 一项，**没有 `android-universal`**；`release-assets` 分支上也没有 APK 文件。
手机端读同一份清单 → 找不到 APK 项 → 永远拿不到下载地址。
所以这不是网络问题，是**发布脚本从来没把 APK 写进清单**。

**修复**：`scripts/release-update.mjs` 新增 `--apk <path>` 参数，APK 会被：

1. 改名为 `MarkdownX_<version>_universal-release.apk`；
2. 写进 `latest.json` 的 `platforms["android-universal"]`（**同样带签名字段** —— 当初以为"只有手机读这一项"
   而省略了签名，结果把桌面端的更新检查整个搞挂，详见 §13.11）；
3. 随安装包一起强推到 `release-assets` 分支，并作为 Release 资产上传。

**本次实测（全部 HTTP 200）**：

| 端点 | 结果 |
|---|---|
| `raw.githubusercontent.com/.../release-assets/latest.json` | 200，`version=2.6.1`，含 `android-universal` |
| `raw.githubusercontent.com/.../release-assets/MarkdownX_2.6.1_universal-release.apk` | 200，23 501 536 B |
| `raw.githubusercontent.com/.../release-assets/MarkdownX_2.6.1_x64-setup.exe` | 200，13 415 661 B |
| `github.com/.../releases/latest/download/latest.json` | 200（Release 兜底） |
| `github.com/.../releases/latest/download/...apk` | 206/200（Release 兜底） |

GitHub Release `v2.6.1`（非 draft、非 prerelease，即 `releases/latest`）带 3 个资产：
`latest.json`、`MarkdownX_2.6.1_x64-setup.exe`、`MarkdownX_2.6.1_universal-release.apk`。

**产物核对**（不是"编译过"就算数）：

- APK badging：`versionCode='2601000' versionName='2.6.1'`、`minSdk 24`、`targetSdk 37`、
  `native-code: 'arm64-v8a'`；
- APK 签名：`apksigner verify` 退出码 0，证书 `CN=Android Debug`（**仅供侧载测试，不是分发签名**，
  见 §13.9 第 7 条）；
- APK 内的 `lib/arm64-v8a/libmarkdown_x_lib.so` 与本次新编的 `.so` **SHA-256 完全一致**
  （`94367C40…`）—— 所以 Gradle 报 `UP-TO-DATE` 是正确的，不是"用了旧包"。

**发布脚本自身的一个坑**：`publishAssetBranch` 会在构建目录里 `git init` 一个暂存仓库。在 NAS 共享
上，那个目录归文件服务器账号所有，Git 直接拒绝执行：
`fatal: dubious ownership in repository at '//CALLYLI00/.../bundle/.release-assets'`
→ **在共享目录上根本发不了版**。修法：所有 git 调用加 `-c safe.directory=*`（提交 `2a168b9`）。

**发布命令**（从共享目录直接可用）：

```powershell
node scripts/release-update.mjs --owner callyli00 --repo MarkdownX `
  --apk <app-universal-release.apk> --skip-build --publish
```

`--skip-build` 复用已有产物；不带该参数时脚本会自己跑 `tauri build`（桌面），
**但不会**跑 Android 构建 —— APK 必须由 §1.6.1 的流程单独产出后用 `--apk` 传进来。

**仍需真机验收**（同 §13.9 清单）：本节只证明"资产确实发布出去了、地址可达"，
打印对话框与下载—安装整条链路还没有物理设备可验。

### 13.11 v2.6.1 复发：桌面端「检查更新失败 ✗ missing field `signature`」

**症状**：桌面版点「检查更新」立刻报错，提示框还建议"请确认更新源已配置 … 且网络可达"。

```
检查更新失败 ✗
missing field `signature`
```

但 `raw.githubusercontent.com/.../latest.json`、两个资产、Release 兜底端点全部 HTTP 200 —— **网络完全正常**，
是**清单读不了**。

**根因（不是 Android 的问题，是 Android 的改动打到了桌面端）**：§13.10 为了"手机端能拿到 APK"往
`latest.json` 的 `platforms` 里加了 `android-universal` 一项，并**特意省掉了 `signature`**
（理由：APK 不是 minisign 签的、只有手机读这一项、完整性由 Android 证书校验保证）。

前两条都错了，而且是同一个错：

1. **签名是必填的**。`tauri-plugin-updater` 2.13.1 的
   `ReleaseManifestPlatform`（`updater.rs:84-89`）是
   `{ url: Url, signature: String }`，`signature` 上**没有** `#[serde(default)]`；
2. **桌面会解析每一项**。`InnerRemoteRelease.platforms`
   （`updater.rs:1575`）是 `Option<HashMap<String, ReleaseManifestPlatform>>` —— 反序列化一个 map
   会把**每个值都构造出来**，不是按目标平台惰性取。于是"只有手机读的那一项"照样把整份文档拖挂了。

失败点在**反序列化**阶段，早于 `get_urls` 的目标平台查找（`updater.rs:701-731`），所以桌面根本走不到
"只有 `windows-x86_64` 和我有关"那一步 —— `missing field` 就是 serde 的原始报错。

那个"请确认更新源已配置/网络可达"的提示是**误导**：它把"清单解析失败"归因到了配置和网络。

**修复（一处，覆盖两端）**：**用同一把 updater 私钥把 APK 也签了**，`android-universal` 带上真实签名。

- 桌面：`platforms` 全部条目齐全 → 恢复正常（`windows-x86_64` 的签名本来就对，未改动）；
- Android：`android_update.rs::parse_manifest` 只读 `version` / `notes` /
  `platforms["android-universal"].url`，**完全不看 `signature`** —— 多一个字段对它零影响，
  信任锚仍然是 Android 自己的安装证书校验（同 §13.9 第 7 条）。

没有选"给 Android 单开一份清单"或"让桌面端自己过滤平台"：前者破坏"一次发布只有一个版本"的约束，
后者要绕过插件默认路径、为一个既定形状的问题改客户端。

**代码层面的防线**（避免第三次）：

1. 清单构造抽成纯模块 `scripts/release-manifest.mjs` 的 `buildManifest()` / `assertManifest()`：
   `url` 与 `signature` 同级必填，`signature` 为空/纯空白一律抛错；`platforms` 用**数组**传
   （键名打错不会静默多出一项），并拒绝重复平台。
2. `scripts/release-update.mjs` 现在**先暂存 APK、再签名、最后写清单**，签到的是
   `bundle/MarkdownX_<version>_universal-release.apk` 本体 —— 发布字节与清单里的签名必然描述同一个文件。
   签名调 `node node_modules/@tauri-apps/cli/tauri.js signer sign …`（不走 `shell:true`，共享路径免引号问题），
   并带 `--app-version`，把版本写进 trusted comment。
3. 单测 `scripts/release-manifest.test.mjs`（新增，`vitest.config.ts` 的 `include` 因此扩到
   `scripts/**/*.test.mjs`）：直接复现历史形状（Android 项无 `signature`）断言**构造阶段就抛错**。
4. 集成测试 `src-tauri/tests/updater_manifest.rs`（新增目录）：用**真实**的
   `tauri_plugin_updater::RemoteRelease` 反序列化双平台清单，并断言
   "少一个 signature → 整份文档 `expect_err`" —— 这条把插件的行为本身钉住，
   将来插件改了要求会在这里失败，而不是在用户机器上。该文件用
   `#![cfg(any(windows, macos, linux))]` 圈住，因为 `tauri-plugin-updater` 只在桌面目标上是依赖（`Cargo.toml:44-46`）。

**验收（真实验签，不是"字段非空"）**：

- 用独立 crate 调 `minisign-verify`（与插件 `verify_signature` 同一套原语）
  对 `bundle/MarkdownX_2.6.1_universal-release.apk` + 其 `.sig` + `tauri.conf.json` 里的 `pubkey`
  做密码学校验：**VERIFY OK**，trusted comment =
  `timestamp… file:MarkdownX_2.6.1_universal-release.apk version:2.6.1`；
- 线上 `release-assets` 分支的 APK 重新下载后 SHA-256 = `A296F528…6A6F`，与本地被签的那份**逐字节一致**
  → 签名对**发布出去的字节**有效；
- 拉线上 `latest.json`，用真实 `tauri_plugin_updater::RemoteRelease` 反序列化：**通过**，
  `windows sig len=440`、`android sig len=448`、`notes_len=1906`；
- 端点复测：raw 三件资产 + `releases/latest/download/latest.json` 全 **HTTP 200**。

**门禁**：`npx tsc --noEmit` 0；vitest **25 文件 / 214 用例**（原 24/204，+1 文件 +10 用例）；
`node tools/render-equivalence-gate/gate.cjs` **6/6 + 6/6**；`cargo test` **13 个**（10 单测 + 3 集成）。

**教训**：跨平台共用一个清单时，"某一项只有另一个平台会读"是**伪假设** ——
序列化格式的必填字段对所有读者生效。改共享格式前，先看消费者**类型定义**怎么写的，
别只看它**取用逻辑**取不取。

### 13.12 v2.7.0 出包：在本地目录构建时缺的两个文件（2026-10-25）

**背景**：UNC 工作区里 `vite build` 连配置都加载不了（`failed to load config from \…`，esbuild 解析不到包入口），
所以 2.7.0 的包在本地目录出：把源码/配置/`src-tauri` 拷到本地 + `npm ci --offline`
（本机 npm 缓存 763 MB，**30 秒装回 234 个包**，全程不需要外网）。

**两次失败都不是代码问题**：

1. `failed to resolve bundle > windows > nsis > installerHooks ./installer-hooks.nsh`
   —— 拷贝清单漏了 `src-tauri/installer-hooks.nsh`。它是 `tauri.conf.json` 里**相对 `src-tauri`** 的路径；
   缺它时 Rust 已经编译完，失败点在"打包"这一步（增量重试只需打包时间，不必从头编译十几分钟）。
2. `ENOENT: <本地目录>\README.md` —— 发布脚本从 README 最新的 `### [vX.Y.Z]` 一节取更新说明（单一来源），
   拷贝目录里必须有 `README.md`，否则清单写不出来。

**本地构建目录的最小清单**：
`package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.node.json`、`vite.config.ts`、`index.html`、
`README.md`、`src/`、`scripts/`，以及
`src-tauri/{Cargo.toml,Cargo.lock,build.rs,tauri.conf.json,tauri.android.conf.json,installer-hooks.nsh,src,capabilities,icons,gen/android}`。

**安卓侧可以直接在本地目录出包**：`gen/android` 仅 404 KB 可直接拷；`app/build.gradle.kts` 里
`ndkVersion = "30.0.16248370"` 与本机 `NDK_HOME` 完全一致；Gradle 9.6.1 的分发包已缓存
（`~/.gradle/wrapper/dists`），`npm run tauri android build -- --apk` 无需外网。

**验证（v2.7.0 本机产物）**：安装包 13,443,210 B（SHA-256 前缀 `7e1f3767`）、`.sig` 440 B；
`latest.json` 的 `windows-x86_64.signature` 非空，`notes` 即 README 的 v2.7.0 一节。

### 13.13 真机冒烟怎么做（CDP 驱动真实 WebView，2026-10-25 实测）

桌面端也能自动化冒烟，不必靠人眼点：给 WebView2 开远程调试，然后用 CDP 在页面上求值。

```powershell
# 启动（把 fixture 目录作为参数 → 直接进入工作区状态）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
.\src-tauri\target\release\markdown-x.exe C:\tmp\smoke\vault
# 另一个进程：GET http://127.0.0.1:9333/json 取 webSocketDebuggerUrl，再发 Runtime.evaluate
```

**三条必须知道的实测结论**：

1. **`.click()` 不会触发 React 处理器**。在这个 WebView 里 `el.click()` 的合成事件进不到
   React 的委托监听（页面上什么都没发生，也没有报错）。要驱动界面，取元素上的
   `__reactProps$…` 并直接调它的 `onClick()`：
   `const k = Object.keys(el).find(k => k.startsWith('__reactProps')); el[k].onClick(evt)`。
2. **`window.__TAURI_INTERNALS__.invoke` 不可替换**（`writable:false, configurable:false`），
   所以"把对话框命令打桩成固定目录"这条路走不通。改用**文件夹命令行参数**（§13.13 的做法），
   这也是 `path_kind` 命令存在的原因。
3. **打印样式可以断言**：`Emulation.setEmulatedMedia({media:'print'})` 之后读 `getComputedStyle`，
   验证 `.wikilink` 无下划线、`.md-tag` 背景透明。

**v2.7.0 冒烟结果（18/18）**：文件夹参数建索引、双链解析成 `b.md` / `b.md#heading-…`、
断链 unresolved、标签芯片（含嵌套）、块 id、嵌入图片经 `asset.localhost` 真实加载、
反链 2 条、未解析面板列出 `[[不存在]]`、标签面板 2 个、点击 `[[b]]` 打开目标文档、
打印媒体下链接/标签去装饰、页面无未捕获异常。

**冒烟抓到的真 bug**：行内代码里的 `[[b]]` 被当成真链接（一篇讲语法的笔记成了被讲对象的
第三条反链）。扫描器已改为同时屏蔽围栏代码与行内代码（等长空格替换，偏移不变），
回归测试见 `src/utils/__tests__/wikiLink.test.ts`。

### 13.14 上行只有 ~100 KB/s 时怎么发版（v2.7.0 实测的降级布局）

`release-update.mjs --publish` 的常规布局是：**安装包 + APK + latest.json 全部进 `release-assets` 分支**
（raw 端点不依赖 github.com，这是当初选它的理由）。但 2026-10-25 这台机器的上行只有
**~100–200 KB/s**，26 MB 的分支强推反复卡死（git 报 `failed to push some refs`，curl 停在
`HTTP/1.1 100 Continue` 之后不动；实测 1 MB 上传 17 s、5 MB 可用、13 MB 勉强、23 MB 基本不上去）。

**这次采用的降级布局**（客户端完全无感）：

| 端点 | 内容 |
|---|---|
| `release-assets` 分支（raw） | **只有 `latest.json`**（几 KB，秒级推上去） |
| GitHub Release `v2.7.0` | `MarkdownX_2.7.0_x64-setup.exe` + `latest.json`（+ APK，能上传时） |
| `latest.json` 里的 `url` | 指向 `https://github.com/.../releases/download/v2.7.0/<file>` |

判别与验收：

```bash
curl -s https://raw.githubusercontent.com/callyli00/MarkDownX/release-assets/latest.json | grep -o '"version":"[^"]*"'
curl -sIL https://github.com/callyli00/MarkDownX/releases/download/v2.7.0/MarkDownX_2.7.0_x64-setup.exe | grep -i content-length
# raw 分支上不再有安装包，所以脚本 verifyRaw() 的"分支安装包 content-length"这一条不适用
```

**上传实测口径**（避免误判为"卡死"）：Windows 的 `Get-Process curl | OtherTransferCount` 恒为 0，
别用它判断在传；用 `--trace-ascii` 会**显著拖慢**上传（本次实测从 ~185 KB/s 掉到 ~5 KB/s），
要看进度就短时间开、或者干脆看 GitHub 那边的资产列表。

上行恢复到正常水平后，仍按 §4 的常规流程发（脚本会把二进制重新放回 `release-assets`）。

**v2.7.0 的最终落地（2026-10-25 21:30）**：APK 由人在浏览器里拖进 Release 资产后补齐。
补 Android 那一条不再需要手工改 JSON —— 用 `node tools/finish-android-release.mjs`：
它会先校验 APK 资产确实存在（大小与本地一致才继续），再重建两平台清单、覆盖 Release 的
`latest.json`、强推 `release-assets`（仅 6 KB），最后实测两个端点。
>`--dry-run` 只重建不推送。安装包的 `.sig` 在 `bundle/nsis/` 下、APK 的 `.sig` 在 `bundle/` 下，
>脚本两处都会找（第一版只找 `bundle/`，直接报"缺少签名文件"）。
