# repomap — AI 项目地图

> **当代码和架构发生实质变动时，更新本文档对应章节，避免重复扫描整个代码库。**

## 技术栈与命令

- ESP-IDF（兼容 v4.4/v5/v6，条件编译宏 `REQUIRES_V4/REQUIRES_V5`、`IDF_TARGET_V4`），芯片 ESP32/ESP32-S3。固件为单组件 `main/`，公共头在 `main/include/`。
- 前端 Vue3.4+Vuetify3+Vite5（pnpm），构建产物 gzip-only 写入 `data/www` 打进固件 storage 分区。
- 构建：`idf.py -B build-xxx build/flash/monitor`（多目标并存 build-eth/build-mini/build-s3，目标名=目录名）；前端 `pnpm -C web build`（idf prebuild 检测 mtime 自动触发）；sdkconfig 变体：`python helper.py sdkconfig +esp32s3 +camera +release [-B build-xxx]`；体积分析 `python helper.py blame -B build-xxx`；PC 假服务器 `python helper.py serve [--esphost IP]`（WSGI 9999，vite 代理 5172）。
- helper.py 可选依赖（requirements.txt）：bottle、detools（delta 补丁）、requests、zeroconf、numpy、turbojpeg、opencv；genfont 需 npm 全局 `lv_font_conv`。
- 版本号：顶层 `CMakeLists.txt project(espbase VERSION x.y.z)`；固件运行时读 `esp_app_get_description()`。

## 启动与运行时骨架

`app_main`(main/main.c)：

1. `esp_register_shutdown_handler(goodbye)`（关机前 dump 命令历史）；DEBUG 构建有崩溃熔断（`RTC_DATA_ATTR` 计数，panic>2 或 WDT/BOR>5 阻塞死循环，release 不熔断）。
2. 底层：`config_initialize()`（NVS→Config、counter 自增、TZ 生效）→ `driver_initialize()`（button/knob/tpad/led/uart/i2c/spi/i2s/adc/dac/pwm/scn）。
3. 核心：`filesys_initialize()` → `console_initialize()` → `network_initialize()` → `update_initialize()`。
4. 可选（`CONFIG_BASE_USE_*` 裁剪）：sensors/hidtool/usbmode/btmode/server → `scn_command(SCN_INIT)`。
5. 主任务进入 `console_handle_loop(NULL)` REPL 死循环（栈 8KB），app_main 不返回。

所有可选模块关闭时导出同名空壳函数（返回 `ESP_ERR_NOT_SUPPORTED`），无 #ifdef 散落调用方。

## 配置体系（config.c / include/config.h）

- `Config` 五域，值一律 `const char*`（`1/y/on`=真，`strtob`）：`sys`（TIMEZONE/HISTORY/PROMPT/DIR_DATA=/etc/ DIR_DOCS=/doc/ DIR_HTML=/www/ BTN_HIGH/INT_EDGE/ADC_MULT/USB_MODE/BT_MODE/BT_SCAN）、`net`（ETH_HOST/GATE、STA_SSID/PASS/HOST/GATE、AP_SSID/PASS/HOST="10.0.2.1/24"/CHAN/NCON/NAPT/HIDE/AUTO、SC_AUTO/SC_TYPE、DPP_AUTO/DPP_CHAN、NOW_LMK）、`web`（WS_NAME/PASS、HTTP_NAME/PASS、AUTH_BASE）、`app`（OTA_AUTO/OTA_URL、HBT_RUN/HBT_URL、HID_MODE/HID_HOST=10.0.2.255、MQTT_RUN/MQTT_URL、MDNS_RUN/MDNS_HOST、SNTP_RUN/SNTP_HOST、TSCN_MODE）、`info`（NAME/VER/UID 只读）。
- 内部两张表 `rwlst[]`(49 项可写)/`rolst[]`(3 项)，键格式 `net.ap.ssid`；`config_set`：strdup RAM→`nvs_set_str`+commit→`esp_event_post(CFG_EVENT, CFG_UPDATE, key)`（模块用 `REGEVT(CFG, handler)` 热更新，如 USB/BT 模式）；设 `""` 恢复编译默认并 `setenv(key,val)`。
- JSON：`config_loads`（嵌套对象递归展平）、`config_dumps`（平铺 JSON，`/api/config` 直接用）。
- NVS 命名空间：`info`（counter u32、uid）、`config`（49 项 str）、`pmap`（端口映射 blob ctx）、`mqtt`（订阅表 blob ctx）、`hbeat`（心跳上下文 blob ctx）。私有数据用 `config_nvs_read/write/jload/jdump`。
- 出厂镜像：`nvs_flash.csv`（gencfg 渲染变量 {NAME}=espbase、{UID}=uuid4 前 8 位、{URL}=http://本机IP:9999、{OTA}=espbase.bin、{HBT}=board）→ 热点名 espbase/密码 UID、web 登录 hank/espbase。
- **维护约定**：config.h 字段注释 ↔ `web/public/config.schema.json` description 逐字同步（曾发现 minumum 拼写错误）；schema 用 draft-07+ajv-formats（ipv4）。

## 固件模块速查

| 模块 | 文件 | 关键接口/行为 |
| --- | --- | --- |
| 控制台 | console.c, commands.cpp | `console_handle_command(cmd, pipe, history)` pipe=true 用 open_memstream 捕获 stdout 返回 malloc 字符串；`console_handle_jsonrpc`（JSON-RPC 2.0，params 数组拼空格）；互斥全局串行（busy 报错）；linenoise 256 列/历史 50/DumbMode 探测；`ctx <prefix>` 前缀模式；`ctx`、`cd`、`reboot [-h][-c][-t]`、`sleep light|deep|pm`、`exec [-l][-s SYMBOL]`（ELF）、`config`、`logging`（tag 用 32 槽 strdup 池避 IDF 缓存陷阱）、`lsmem/lstask/lsfs/lspart/lshw/date/version/hist`、driver 组 `gpio/usb/led/i2c/adc/dac/pwm`、network 组 `net bt/ip/now/ftm/pmap/pcap/mqtt/mdns/sntp/ping/iperf/tsync/hbeat`、app 组 `app hid/scn/als/avc/qrc/sen` |
| 网络 | network.c | 事件组位 STA_CONN/FAIL/STOP/WAIT/SCAN、NOW_STOP、FTM_DONE/FAIL、PCAP_STOP、MQTT_CONN、TSS/TSC_STOP、HBT_STOP；`if_ap/if_sta/if_eth`；STA 失败自动回落链：静默重试3次→AP_AUTO 开 AP→DPP/SC_AUTO 配网任务（10 分钟超时，DPP 打二维码）；GOT_IP 触发 OTA 检查→MQTT→SNTP→心跳四件套；ESP-NOW 自定义协议（1B crc+1B flag+payload，flag PING/PONG/TEXT），LMK=MD5(NOW_LMK‖minMAC‖maxMAC) 自动加密，陌生源自动 add，任务广播 1s/单播保活 5s；NAPT 端口映射持久化；pcap 写 data/wifi.pcap|eth.pcap；MQTT ctx 存 NVS（tpc 表 msgid）；TimeSync 端口 9777（mDNS `_tss._tcp`）；hbeat 双周期任务：info POST JSON（响应可反配 deviceid/location/apssid/appass/hbtime/intval/hurl/iurl，改 apssid 即云端遥控热点）、data multipart 上传摄像头帧 |
| Web 服务器 | server.c | 80 端口 httpd，栈 8KB，max_open_sockets=12+lru_purge；`rewrite_api` 剥 `/api` 前缀；权限位 FLAG_NEED_AUTH/FLAG_AP_ONLY（release 校验 Host=AP_HOST）；Basic/Digest（ha1 预算，nonce=md5(host:ts)，opaque=时间戳 1 天有效）；静态文件 404 尝试 `.gz` 回落（前端 .gz-only 的对端）；`check_request` 解析 query+form 到 `http_param_t` 链表（`get_param`）；404 回 SPA index |
| 文件系统 | filesys.c | 三选一 FFS：SPIFFS（哨兵文件 `_SENTINEL` 模拟目录、walk 折叠虚拟目录）/FAT(wear-levelling)/LittleFS(grow_on_mount)；SD 三路径（SDSPI/SDMMC S3/SDMMC esp32）；`filesys_norm_r/join_r/get_type`；`filesys_execute`（load_elf，>10KB 重新读）、`filesys_dlcall`（dlopen/dlsym，**故意不 dlclose**；PSRAM 加载时函数指针 DROM→IROM 偏移 hack；memprot 开启时拒绝） |
| OTA | update.c | 首包双格式探测：全量 `header_normal_t`(esp_image_header+seg+app_desc) 校验 chip_id+版本去重；delta `header_patched_t{magic(sha256(b"esp_delta_ota")反序前4),sha256[32],len,rsrv[24]}` 校验 sha256==running 分区哈希→`esp_delta_ota_init(handle, delta_read=esp_partition_read, delta_write)`；`ota_updation_{begin(size,=分区大小减1)/write/end/url/boot/info}`；状态 New/Pending/Valid/Invalid/Aborted/Running/OTANext；双 silver 槽 rollback |
| HID | hidtool.c, hiddesc.h, include/hidtool.h | Report ID：1 KEYBD(8B)/2 MOUSE(相对)/3 ABMSE(绝对4095)/4 POINT/5 TOUCH(5指)/6 GMPAD(按布局)/7 SCTRL/8 SDIAL；`hid_report_send(to=USB|BLE|NET|SCN 位掩码)`；布局 GENERAL(VID 0x05DF:0x4000，内置 7 段描述符~405B)/XINPUT(0x045E:0x0B13，desc 文件 xinput.hid 283B)/SWITCH(0x057E:0x2009)/DSENSE(0x054C:0x0CE6)；键值字符串语法 `"a|Ctrl|F1"`（str2keycodes）；接收侧 8 槽状态机产按下/释放沿回调 |
| USB | usbmode.c/usbdev.c/usbhost.c, include/usbmode.h | 8 模式单选枚举 SERIAL_JTAG/CDC_HOST/MSC_HOST/HID_HOST/CDC_DEV/MSC_DEV/HID_DEV/NCM_DEV；`usbmode_switch(mode, reboot)`：exit 失败（v4 tinyusb 不可卸载）→reboot 或 PENDING_REBOOT；设备描述符运行时拼装（tud_disconnect→desc_cfg→connect）；CDC_DEV 回环/控制台重定向、MSC_DEV 挂 storage 分区、HID_DEV 描述符=HIDTool.desc、NCM_DEV 用 esp_read_mac(NET)（v4 不支持）；主机端 usb_lib_task+client 任务（CDC 演示发 "help"、MSC VFS 挂 /msc、HID 报文注入统一层）；`usbdev_interest` 按 VID/class 过滤 |
| 蓝牙 | btmode.c/btdev.c/bthost.c | 三模式 BT_HIDD（Bluedroid esp_bt_hid_device，不用 esp_hidd BT transport）/BLE_HIDD（esp_hidd_dev_init，report map=HIDTool.desc，gamepad appearance）/BLE_HIDH（esp_hidh/gattc）；`bt_common_init`（GAP 名 `<NAME>-<UID>`、IO_CAP_OUT+MITM+bond）；`btmode_scan/config/battery/connect`；`hidb_send_report` |
| 驱动 | drivers.c, include/drivers.h | 引脚宏模式：先板型特判（S3ECAM SPI=5/6/7 LED=21...）否则 `CONFIG_BASE_GPIO_*`；`gpio_usage(pin,usage)` 占用登记；SMBus API+寄存器表 DSL `smbus_regval_t{reg,val}`（reg 高 16 位操作码：RT_WBYTE/WWORD/RBYTE/RWORD/CBITS/SBITS/TOGGLE/WAIT0/1/2/SLEEP，`smbus_regtable` 顺序执行）；gexp 虚拟引脚 PCF8574(I2C 限位/温度/阀)+74HC595(SPI 步进)，枚举从 `GPIO_PIN_COUNT-1` 逆序向下；`i2c_wtrd/i2c_detect` |
| 传感器 | sensors.c, include/sensors.h | `temp_celsius`、`tscn_read/command`(16 指坐标+手势，apply 套旋转，投 LVGL)、`mscn_status`(IST3931)、`vlx_read`(VL53L0X mm)、`gy39_read`(照度/温/湿/压/海拔)、`als_brightness/als_tracking`(光追云台→pwm_set_degree)、`pwr_status`(BQ25895) |
| 屏幕/LED | scndrv.c/scnlvgl.c, include/screen.h; ledmode.c | `scn_command`：SCN_INIT/EXIT/STAT/INP(hid_report_t)/FONT(bin 字体)/DPI/ROT/GAP/FPS/BTN(0-6)/PBAR(0-100)；后端 LVGL(esp_lvgl_port，v8/v9 别名映射层)/u8g2(v4)；screen_t{init/exit/enter/leave}，内置 menu/label/anim（S3NL191 单触摸屏）；indev pointer/keypad/encoder 全由 HID 报文驱动；字体级联链 bin→scnfont.c→unscii8→default；`dump_obj` 树打印；LED：led_indicator，RMT 模式扩展 LED_BLINK_HSV/HSV_RING/IHSV，内置列表白呼吸/蓝呼吸/双红/色环/流光 |
| 音视频 | avitool.c, include/avitool.h | `CONFIG_BASE_USE_AVC`=CAM||I2S；事件 `AVC_EVENT` AUD/VID_EVENT_START/DATA/STOP，**payload 是二级指针**（AVC_POST 宏）；`avi_command(tgt=AUDIO|VIDEO|IMAGE_TARGET, ctrl, ms, ptr)` 及语义宏 AUDIO_START/VIDEO_START/CAMERA_FETCH/YIELD/LOADS/DUMPS；手写 44B WAV、192+116B AVI 头（MJPG/RGB，收尾补 idx1）、BMP；qrenc flags(BIN/BMP/SVG/FULL/MINI/DOTS/ANSI/INV)+qrdec(quirc)；DPP 用反色终端二维码 |
| ELF 子项目 | ../cmds/* | 独立 CMake 工程，CMakeLists 含 `project_elf()`(→bin 无后缀)或 `project_so()`(→.so)；构建期拷进 data/bin 随 FFS 镜像烧写；运行 `exec <path>` 或 dlopen |

## HTTP API 全表（server.c，均可用 /api 前缀）

| URI | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| /ws | WS | 无 | TEXT 帧首字节 `{`→JSON-RPC 否则裸命令；4KB 上限；httpd_queue_work 异步回包 |
| /alive /apmode | GET | 无 | 探活 / AP 模式判定（前端控制菜单显隐） |
| /exec | POST | 需 | 表单 `cmd=`，返回 stdout 文本 |
| /media | GET/POST | 需 | `?video=mjpg[&still]` multipart 流、`?audio=wav`、`?video=config` GET/POST JSON；video/audio 单例互斥 |
| /edit | GET | AP | `?path&list` JSON 列表 / `?path[&download]` 文件 |
| /edit | PUT/DELETE/POST | AP+鉴权 | 建文件目录 / 删除 / multipart 上传（`?overwrite`；自研状态机解析） |
| /config | GET/POST | AP(+写鉴权) | dumps / loads（`json=` 表单） |
| /update | GET/POST | AP(+写鉴权) | 303→/updation；POST `?size=` 预擦除→multipart 字段 `update`→end+重启 |
| /data /docs /* | GET | AP/无 | DIR_DATA 静态 / DIR_DOCS / SPA（DIR_HTML） |

## 构建系统（顶层 CMakeLists.txt + helper.py）

- sdkconfig 层叠：`defaults` → `.local`（gitignore，sdkconfig 命令维护）→ `.defaults.v{4|5}`；变体库：camera/esp32/esp32s3/flash8/flash16/release/v4/v5。
- `elf_build()`：glob cmds/*/CMakeLists.txt → externalproject_add（产物拷 data/bin）→ 挂依赖到 FFS 目标；FFS 镜像三选一（`CONFIG_BASE_FFS_SPI/FAT/LIT`，分区 `CONFIG_BASE_FFS_PART`=storage）；`nvs_create_partition_image(nvs, nvs_flash.csv)`。
- helper.py 子命令：`prebuild`（前端 mtime 检测→pnpm build；gengbk 生成 data/etc/gbktable.bin 24016 项 GBK→Unicode 表；gendeps 扫 include 反查组件重写 main/CMakeLists.txt REQUIRES_V4/V5——**勿手改**）；`postbuild`（detools heatshrink 补丁，命名 espbase-{old8}-{new8}.bin，备份改名）；`gencfg`（NVS 渲染+打包，--flash 直烧）；`genfont`（扫描 main/ 汉字→lv_font_conv→main/scnfont.c 或 data/etc/chinese_{size}.bin，附加 UNSCII/块元素/盲文/FA 图标）；`sdkconfig [+-]变体`（+/−/toggle 写入 .local 标记块，无参=审计模式打印被覆盖项）；`blame`（idf_size 封装）；`serve`（假服务器全路由+WebSocket permessage-deflate+`--test` 自检+zeroconf 搜设备）；`search`。
- 分区表：partitions.csv 4MB 双 1728K ota+576K storage；-8m 双 2368K+1M；-16m 双 3M+7104K；nvs 固定 16KB。
- 依赖：main/idf_component.yml（elf_loader、esp32-camera、esp_delta_ota、lvgl+esp_lvgl_port、esp_tinyusb、usb_host_cdc_acm/msc/hid、quirc、qrcode、button/knob/led_indicator/touch_element、pcap、iperf、mdns、littlefs，多含按版本/芯片条件规则）。

## 前端（web/）

- vite.config.js：build.outDir=`../data/www`（不存在则 ./dist）；`process.env` 注入 PROJECT_VERSION/NAME、BUILD_INFO{NODE_JS,BUILD_OS,BUILD_TIME,SOURCE=git hash}、API_SERVER=5172；dev 0.0.0.0:5173，/api 代理 localhost:5172（vite-python 插件自动起 helper.py serve）；插件链 vue/vuetify/prismjs(5 语言)/autoimport(vue+router+i18n，源码免 import 的原因)/components/compression(deleteOriginFile 只留 .gz)/visualizer/vue-devtools/splitVendorChunk。
- router.js：`Tab*.vue→/小写` 约定路由（home 控制台/gamepad/socket/stream/fileman/editor/configs/updation/about/serial/notfound）；`/redirect/:url?` 承接固件 303；`?to=` 参数重定向。
- apis.js：`getSchema/isAPmode/getConfig/setConfig/getMedia/setCamera/listDir/readFile/download/createPath/deletePath/uploadFile(string 自动 gzip)/updateOTA(字段 update)/execCommand(拼命令行)/getCommands(解析 help 输出为补全数据)`；axios baseURL `/api/` 默认 5s。
- Schema 体系：ajv(allErrors)+ajv-formats 校验 public/config.schema.json；SchemaForm/String/Number/Boolean/Select/EInput/Editor 动态渲染。
- 通信：utils/serial.js（WebSerial 封装+OptionSchema 端口配置表单）、utils/timesync.js（`timeinit/timesync/timedone` double 小端，xsync 采样平均，recv/send 注入式）、looptask/strftime/cvtcase(键名驼峰↔平铺)/ipregex。
- 组件：GamePad/TouchPad/SurfaceDial/KeyBoard(simple-keyboard)→HID JSON 经 WS 下发；CodeJar(+linenumbers) 编辑器；TreeView 文件树；vue-web-terminal 控制台。
- 联调三方式：`pnpm dev`（Python 假服务器全功能）；`serve --esphost`；直接访问设备 IP。

## 约定与坑

- gendeps 自动维护 main/CMakeLists.txt；config.h 注释↔schema 同步；idf logging tag 缓存陷阱（栈串地址当 key）。
- IDF v4：tinyusb 不可卸载（切 USB 必重启）、无 mdns/littlefs 组件（条件依赖）、部分 API 名不同（别名宏集中在各文件头部）。
- SPIFFS 无真目录（哨兵方案）；digest opaque=签发时间戳（1 天过期）；静态路由 `.gz` 回落约定前后端一致。
- httpd handler 内禁止阻塞死循环（select 模型），耗时操作 `httpd_queue_work`；AVC 事件传二级指针；MQTT 断线重连后按 tpc 表重订阅。
- elf_loader：memprot+无 PSRAM 时 dlopen 拒绝；故意不 dlclose；`-ABS(返回值)` 错误码语义。
- 详版文档：本目录 index、build、config、console、network、server、filesys、hidtool、btmode、display、drivers、avitool、update、webpage。
