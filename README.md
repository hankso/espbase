# ESPBase

把一块 ESP32 / ESP32-S3 开发板变成一台开箱即用的**网络终端**：自带 Wi-Fi 热点与 Web 管理面板、串口命令行、文件管理、USB/蓝牙键鼠手柄、屏幕界面、摄像头推流和 OTA 升级。所有功能都可在编译期按需裁剪，既能做万能调试板，也能裁剪成体积很小的专用设备。

## 主要功能

| 能力 | 说明 |
| --- | --- |
| Web 管理面板 | 在线控制台、文件管理、代码编辑器、可视化配置表单、固件升级、摄像头/音频流播放 |
| 命令行（REPL） | 串口、网页、WebSocket 三处入口；支持补全、历史、命令前缀上下文 |
| 网络 | Wi-Fi STA/AP（失败自动回落热点）、有线以太网（W5500）、SmartConfig/DPP 扫码配网、mDNS、MQTT、SNTP、ESP-NOW 组网、ping/iperf/抓包等诊断工具 |
| 文件系统 | SPIFFS / FAT / LittleFS 三选一 + SD 卡；网页端上传下载、在线编辑 |
| 动态程序加载 | 可执行 ELF 与动态库（.so）放在文件系统里，运行时 `exec` 加载，不必重新烧写固件 |
| HID 外设 | USB / 蓝牙 键鼠与手柄；内置通用、XInput、Switch Pro、DualSense 四种手柄布局，可模拟成真实手柄 |
| USB | 设备模式（串口、U 盘、HID、网卡）与主机模式（接键鼠、U 盘、串口设备）共 8 种可切换 |
| 屏幕 | LVGL 图形界面（菜单/标签/动画，部分触摸屏板型为触摸 UI），支持中文字体按需裁剪 |
| 摄像头与音频 | 浏览器实时 MJPEG 预览、录音、录像（AVI/WAV）、二维码生成与识别 |
| 传感器 | 触摸屏/触摸板、激光测距、GY39 环境四合一、环境光追踪（云台）、电源管理芯片 |
| OTA | 网页上传升级、URL 拉取升级、**差分补丁升级**（只传差异部分，省流量省时间） |
| 心跳与云端 | 定期上报状态和设备 ID，服务器回包可远程下发配置（如热点名、上报周期） |

## 支持的硬件

- **ESP32**：DevKit、PICO-KIT、ESP-EYE、Ai-Thinker CAM、M5Stack TimerCAM、Freenove WRCAM
- **ESP32-S3**：LuaTOS CORE、Espressif USB-OTG 板、Waveshare S3-CAM-ETH、Freenove S3 WROOM CAM、NoLogo SuperMini / 1.91" 触摸屏、Waveshare 1.47"/1.69" LCD
- **自定义板**：menuconfig 中选择 `Custom Board`，所有引脚手工填写

摄像头、屏幕、以太网等外设按板型自动启用；目标是 4MB Flash 起步，8MB/16MB 有独立分区表。

## 快速开始

### 1. 准备环境

```bash
# ESP-IDF v4.4 或 v5.x（安装见 https://docs.espressif.com/projects/esp-idf/）
git clone <本仓库> && cd espbase
# 前端已随仓库提供源码，若需自行构建：
pnpm -C web install
pnpm -C web run build
```

### 2. 选择板型与功能

```bash
# 图形化配置：Board Selection 选板型；Project Config 里勾选需要的功能
idf.py menuconfig
```

常用命令：

```bash
# 按芯片/屏幕/摄像头/发布模式组合配置（自动写入 sdkconfig.local）
python helper.py sdkconfig +camera +release
python helper.py sdkconfig +flash16          # 16MB Flash 分区表
python helper.py sdkconfig                   # 不带参数：审计当前配置是否被覆盖
```

### 3. 编译与烧写

```bash
idf.py set-target esp32s3       # 或 esp32
idf.py build
idf.py -p COMx flash monitor    # Windows；Linux/macOS 用 /dev/ttyUSBx
```

说明：

- 前端改动无需手动 build，`idf.py build` 会自动检测 `web/` 变更并重新打包进固件文件系统。
- 支持多个构建目录并存：
    + `idf.py -B build set-target esp32 build`
    + `idf.py -B build-s3 set-target esp32s3 build`
- 烧写后可用 `python helper.py blame -B build` 查看各模块占用的 Flash/RAM。

### 4. 首次使用

设备上电后：

1. **连接热点**：SSID 为 `espbase`（多台设备会在名字后附加序列号），初始密码为设备唯一序列号 `UID`。
2. **打开网页**：浏览器访问 <http://10.0.2.1>，初始账号 `hank` / 密码 `espbase`，登录后请在「配置」页修改热点密码与网页密码。
3. **串口控制台**：波特率 115200，直接输入命令（如 `help`、`version`、`net ip sta info`）。

查询设备序列号：

```
> lshw
Chip UID: espbase-XXXXXXXX
   Model: ESP32-XXX
   Cores: X
Revision: X.X
Features: Embedded Flash | Embedded PSRAM | WiFi 802.11bgn | BLE | BT
```

想让设备连接家里的路由器：在网页「配置」里填 `net.sta.ssid` / `net.sta.pass` 后重启，或直接命令：

```
ip sta up -s "你的WiFi名" -p "密码"
```

连接失败时设备会自动回落到热点模式，不会失联；也可用手机 App 扫码（DPP）或 SmartConfig 配网。

## Web 管理面板一览

| 页面 | 用途 |
| --- | --- |
| 控制台 | 在浏览器里执行任意设备命令，支持自动补全与历史 |
| 游戏手柄 / 触摸板 / 键盘 | 把浏览器变成 HID 外设，控制电脑或手机 |
| 串流 | 实时查看摄像头画面、收听麦克风音频 |
| 文件管理 | 浏览/上传/下载/删除文件，在线编辑文本 |
| 配置 | 按 JSON Schema 自动生成的表单，带输入校验；也可直接编辑 JSON |
| 升级 | 选择固件文件上传升级（支持差分补丁） |
| 关于 | 固件版本、编译信息、分区状态 |

> 出于安全考虑，文件管理、配置修改和固件上传仅在直连设备热点（AP 模式）时可用。

## 常用命令示例

```
help                          # 列出全部命令
version / lshw / lspart       # 版本、硬件、分区信息
lsmem / lstask / lsfs         # 内存、任务、文件系统
gpio 4 1                      # 拉高 GPIO4；gpio 4 读取
adc 0 -t 2000                 # 连续采样 2 秒
ip sta info                   # 查看 Wi-Fi 状态
ping 8.8.8.8                  # 网络连通性
qrc enc -t "hello"            # 在串口打印二维码
avc cam print                 # 查看摄像头参数
reboot                        # 重启
```

输入 `<命令> --help` 查看某个命令的完整用法；`config --list` 查看所有可配置项。

## 配置与持久化

- 所有配置项都是字符串键值（如 `sys.timezone`、`net.ap.ssid`、`app.ota.url`），保存在 Flash 的 NVS 分区，断电不丢。
- 三种修改方式等价：网页配置页、`config <KEY> <VAL>` 命令、HTTP API `/api/config`。
- 出厂默认值在 `nvs_flash.csv`，可自行修改后用 `python helper.py gencfg --pack nvs.bin --flash COMx` 生成并烧写。
- 前端表单由 `web/public/config.schema.json` 驱动，新增配置项需同时更新 `main/include/config.h` 与 schema。

## OTA 升级

- **网页升级**：AP 模式下进入「升级」页上传 `espbase.bin`。
- **命令行**：`update fetch -u http://指定服务器/espbase.bin`。
- **差分升级**：每次编译后 `helper.py postbuild` 会自动生成 `espbase-{旧版本}-{新版本}.bin` 补丁，服务器按设备当前版本下发补丁即可，流量可降到全量固件的几个百分点。
- 采用双 OTA 分区，升级失败可回滚；`update boot` 可手动切换启动分区。

## 二次开发

```
espbase/
├── main/          # 固件源码（单组件），公共接口在 main/include/
├── cmds/          # 可动态加载的 ELF / SO 子项目（构建后自动打进文件系统）
├── data/          # 文件系统镜像源（www 前端产物、etc 字体证书、bin 程序）
├── web/           # Vue 前端工程
├── docs/          # 开发者文档
├── helper.py      # 构建辅助：预构建、差分补丁、配置镜像、字体裁剪、体积分析、本地假服务器
└── partitions*.csv / nvs_flash.csv / sdkconfig.defaults*
```

- 前端联调：`pnpm run dev`（自动启动 Python 假服务器，无硬件也能开发界面）；也可 `python helper.py serve --esphost <设备IP>` 代理到真实设备。
- 裁剪体积：`idf.py menuconfig → Project Config` 关闭不需要的功能（蓝牙约 500KB、屏幕约 200KB、命令行约 110KB）。
- 中文字体按需生成：`python helper.py genfont <字体文件>`（只打包源码中用到的汉字）。

## 文档

开发者文档位于 [`docs/`](./docs/index.md)，按模块分册：构建系统、配置、控制台、网络、Web 服务、文件系统、USB/HID、蓝牙、屏幕、驱动与传感器、音视频、OTA、前端、板级引脚。

`docs/repomap.md` 是给 AI 编码助手的项目地图，喂给模型可以在不扫描所有源码的情况下直接定位问题。

`pnpm -C web run dev` 启动服务器后，浏览器访问 `http://localhost:5173/guide`，或者固件烧写进 esp32 后访问 `http://ESP32的IP/guide` 也能看到开发者文档。

已在 ESP32、ESP32-PICO、ESP32-S3 上编译并验证：摄像头、LVGL 屏幕、Web UI、串口命令行、USB/蓝牙 HID 主机与设备模式。
