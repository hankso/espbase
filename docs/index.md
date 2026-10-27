# 项目总览

ESPBase 是一个基于 ESP-IDF 的固件基础工程，目标是把一块 ESP32 / ESP32-S3 开发板变成功能完备的"网络终端"：Web 控制台、REPL 命令行、文件管理、USB/BT 外设、传感器、摄像头推流、OTA 升级等能力全部内置，并配有一个 Vue 3 前端作为图形管理界面。

- 固件框架：ESP-IDF（同时兼容 v4.4 与 v5.x/v6，通过条件编译与 `REQUIRES_V4` / `REQUIRES_V5` 区分）
- 支持芯片：ESP32、ESP32-S3（USB/以太网/摄像头等特性按芯片条件启用）
- 前端：Vue 3 + Vuetify + Vite（构建产物直接打进固件文件系统 `data/www`）
- 构建辅助：根目录 `helper.py`（prebuild / postbuild / gencfg / genfont / gendeps / sdkconfig / blame / serve / search）

## 目录结构

```
espbase/
├── CMakeLists.txt          # 顶层构建脚本：ELF 子项目、FFS 镜像、NVS 镜像
├── helper.py               # 构建辅助工具集（详见 02-build-system）
├── partitions*.csv         # 分区表（默认 / 8MB / 16MB）
├── nvs_flash.csv           # NVS 出厂配置模板（gencfg 渲染）
├── sdkconfig.defaults*     # sdkconfig 变体矩阵（详见 02-build-system）
├── main/                   # 固件主组件（单个 IDF component）
│   ├── include/            # 公共头文件（API 契约）
│   ├── Kconfig.projbuild   # "Project Config" 菜单（板型/外设/GPIO）
│   ├── CMakeLists.txt      # REQUIRES_V4/V5 依赖（由 gendeps 自动维护）
│   ├── idf_component.yml   # IDF Component Manager 依赖清单
│   └── *.c / *.cpp         # 各功能模块源码
├── cmds/                   # ELF 动态加载子项目（hello, misc）
├── data/                   # 文件系统镜像源（www 前端产物、etc 字体/证书等）
└── web/                    # 前端工程（Vue3 + Vite）
    ├── src/                # 前端源码（详见 14-web-frontend）
    ├── public/             # config.schema.json 等静态资源
    └── docs/               # VitePress + 项目文档
```

## 固件模块划分

| 组 | 模块 | 文件 | 说明 |
| --- | --- | --- | --- |
| 1. 底层 | 配置 | `config.c` | NVS 初始化、Config 结构体装载 |
| | 驱动 | `drivers.c` | button/knob/led_indicator/u8g2/LCD/LVGL |
| 2. 核心 | 文件系统 | `filesys.c` | SPIFFS/FAT/LittleFS/SD 挂载、ELF loader |
| | 控制台 | `console.c` + `commands.cpp` | REPL、命令注册、历史记录 |
| | 网络 | `network.c` | WiFi STA/AP、以太网、mDNS、ESP-NOW |
| | 升级 | `update.c` | OTA、心跳上报 |
| 3. 可选 | 传感器 | `sensors.c` | 温度、触摸板 |
| | HID | `hidtool.c` | 统一 HID 事件分发（USB/BT 共用） |
| | USB | `usbdev.c` `usbhost.c` `usbmode.c` | TinyUSB 设备/主机模式 |
| | 蓝牙 | `btdev.c` `bthost.c` `btmode.c` | BLE/BT HID、SPP、iBeacon、ESP-NOW over BT |
| | 服务器 | `server.c` | HTTP + WebSocket（REST API） |
| | 显示 | `scndrv.c` `scnlvgl.c` | LCD/LVGL 屏幕驱动与控件 |
| | LED | `ledmode.c` | LED 闪烁模式 |
| | 音视频 | `avitool.c` | 摄像头、视频/音频流、二维码识别 |

## 启动流程（app_main）

```c
void app_main(void) {
    // 崩溃保护：DEBUG 构建下，panic 连续 >2 次或 WDT/BOR 连续 >5 次则
    // 阻塞在死循环，防止崩溃循环烧写设备（计数存于 RTC_DATA_ATTR，深睡不清零）
    esp_register_shutdown_handler(goodbye);   // 关机时 dump 命令历史

    // 1. 低层驱动
    config_initialize();    // 依赖 nvs
    driver_initialize();    // button, knob, led_indicator, u8g2, lvgl, lcd

    // 2. 必要模块
    filesys_initialize();   // 依赖 elf_loader
    console_initialize();   // 依赖 filesys
    network_initialize();   // wifi, eth, mdns, iperf
    update_initialize();    // filesys, network

    // 3. 可选模块（受 CONFIG_BASE_USE_* 裁剪）
    sensors_initialize();
    hidtool_initialize();
    usbmode_initialize();   // 依赖 hidtool, esp_tinyusb, usb_host_xxx
    btmode_initialize();    // 依赖 hidtool, bluedroid
    server_initialize();    // 依赖 network, update, filesys, console

    scn_command(SCN_INIT, NULL);
    console_handle_loop(NULL);  // 主任务进入 REPL 死循环
}
```

要点：

- **主任务即 REPL**：`console_handle_loop(NULL)` 复用 ESP-IDF 主任务（栈 8KB，见 `CONFIG_ESP_MAIN_TASK_STACK_SIZE`）跑命令行，`app_main` 不返回。
- **崩溃熔断**：`esp_reset_reason()` 分类计数（`RTC_DATA_ATTR uint8_t count[3]`），仅 `CONFIG_BASE_DEBUG` 生效，量产（release）构建不熔断。
- **优雅关机**：`goodbye()` 在 shutdown handler 中把命令历史写入 `Config.sys.HISTORY` 指定的文件。

## 编译期裁剪体系

所有可选功能都由 `main/Kconfig.projbuild` 中的 `CONFIG_BASE_*` 选项控制，源码内用 `#if CONFIG_BASE_USE_XXX` 宏裁剪，Kconfig help 中标注了各功能的大致体积代价（例如 BT ~500KB、屏幕 ~200KB、命令行 ~110KB、OTA URL ~110KB、摄像头 ~60KB、USB ~60KB）。

板级支持通过 `BASE_BOARD_*` choice 选择，每个板型 `select` 所需能力（PSRAM/CAM/ETH/SCN），并给 `BASE_GPIO_*`、`BASE_CAM_PINS` 等引脚配置提供默认值。内置板型：

- ESP32：DevKit、PicoKit、ESP-EYE、Ai-Thinker CAM、M5Stack TimerCAM、Freenove WRCAM
- ESP32-S3：LuaTOS CORE、Espressif USB-OTG、Waveshare S3-CAM-ETH、Freenove S3 WROOM CAM、NoLogo SuperMini / 1.91" LCD、Waveshare 1.47"/1.69" LCD
- `BASE_BOARD_CUSTOM`：自定义板，引脚全部走 menuconfig 手工配置

## 各文档索引

| 文档 | 内容 |
| --- | --- |
| [build](build) | CMake 结构、helper.py 全部子命令、sdkconfig 矩阵、分区表、NVS 出厂镜像、cmds ELF 子项目 |
| [config](config) | Config 体系：config.c/config.h、NVS 读写、配置事件、schema 同步 |
| [console](console) | REPL 控制台与全部内置命令 |
| [drivers](drivers) | GPIO/ADC/PWM/I2C/SPI 驱动与传感器 |
| [filesys](filesys) | 文件系统与 ELF 动态加载 |
| [network](network) | WiFi/以太网/ESP-NOW/mDNS/网络诊断、时间同步 |
| [server](server) | HTTP/WebSocket 服务与 REST API |
| [btmode](btmode) | 蓝牙 HID/BLE/经典蓝牙 |
| [hidtool](hidtool) | USB 设备/主机模式与 HID 子系统 |
| [avitool](avitool) | 摄像头、音视频流、二维码 |
| [display](display) | 屏幕驱动、LVGL、LED 模式 |
| [update](update) | OTA 与差分升级 |
| [pinout](pinout) | 板级引脚信息 |
| [webpage](webpage) | Vue 前端工程 |
