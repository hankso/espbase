# 控制台与命令

固件的 REPL 由 console.c + commands.cpp 实现，替代 ESP-IDF 自带的 `esp_console_new_repl_xxx/start_repl`。整个命令体系可在 `CONFIG_BASE_USE_CONSOLE` 关闭时整体裁剪（commands.cpp 顶部注释标明了每个命令组的 flash 代价）。

## 一、REPL 实现（console.c）

### 1.1 初始化 `console_initialize()`

1. **控制台 VFS 按编译期选择配置**（`CONFIG_ESP_CONSOLE_*`）：
   - UART（默认/自定义端口）：RX 行结束 CR、TX 行结束 CRLF，`uart_vfs_dev_use_driver` 阻塞驱动模式；
   - USB-Serial-JTAG（S3 常用）：安装 `usb_serial_jtag_driver`，stdin/stdout 置非阻塞；
   - USB-CDC：`esp_vfs_dev_cdcacm_*` 同样处理。
   v4/v5 的 API 差异用宏别名抹平。
2. `setvbuf(stdin/stdout, NULL, _IONBF, 0)` 全无缓冲；
3. linenoise 配置：多行模式、单行上限 256、补全/提示回调挂 `esp_console_get_completion/hint`、历史容量 50；`linenoiseProbe()` 探测终端是否支持转义序列，不支持则进入 DumbMode（无行编辑/历史/颜色）；
4. `esp_console_init` + `console_register_commands()`（commands.cpp）；
5. `Config.sys.HISTORY` 非空则启动即 `linenoiseHistoryLoad`；
6. 创建互斥信号量：**命令执行全局串行**，`console_handle_command` 用 `ACQUIRE(mutex, 100)` 抢锁，抢不到直接返回 "Console task is busy"。

### 1.2 提示符与上下文

- 提示符格式 `<PROMPT>:<PWD>$ `，`PWD` 取进程环境变量（`cd` 命令 `setenv("PWD", ...)` 更新后调 `console_register_prompt(NULL, NULL)` 重绘）；`CONFIG_LOG_COLORS` 下提示符名紫色、路径蓝色（DumbMode 下去色）。
- `ctx <prefix>` 命令设置**命令前缀上下文**：提示符变为 `> <ctx> `，此后输入的每行自动拼成 `<ctx> <输入>` 执行；空输入或以 `ctx` 开头的输入按原样处理（用于退出/切换上下文）。适合 HID 等交互场景少打前缀。

### 1.3 命令执行与输出捕获

`char * console_handle_command(const char *cmd, bool pipe, bool history)`

- `pipe=true` 时用 `open_memstream` 把 stdout 重定向到动态缓冲，执行完恢复 stdout 并 trim 尾部空白后返回缓冲（调用方 free）。源码注释里详细对比了 setvbuf/memstream/pipe/VFS-ram 四种捕获方案的取舍，当前用 Method 2（open_memstream）。
- 返回码语义：`ESP_ERR_NOT_FOUND` → 未识别命令；`ESP_ERR_CONSOLE_ARGPARSE`（argtable 解析失败或 --help 打印后）静默；其他打印 `Command error`。
- `history=true` 时把命令加进 linenoise 内存历史。
- v4 目标下主循环每次喂 `esp_task_wdt_reset()`。

### 1.4 JSON-RPC 通道（WebSocket 用）

`char * console_handle_jsonrpc(const char *json, int len)`：

- 请求：`{"jsonrpc":"2.0","method":"<命令>","params":["arg1","arg2"],"id":"x"}`；
- `params` 数组元素以空格拼接回命令行字符串，交给 `console_handle_command(cmd, pipe=true, history=false)` 执行；
- 成功响应 `{"jsonrpc":"2.0","id":"x","result":"<命令输出>"}`，notify（无 id）不回包；
- 错误码沿用 JSON-RPC 2.0：-32700 Parse Error / -32600 Invalid Request / -32400 System Error。

前端 WebSocket 终端即通过此通道把任意命令发到设备（见 06/14）。

### 1.5 历史持久化

`console_history_command(cmd, hist)`：`on|off|load|dump` 四个子动作，文件路径经 `filesys_get_type` 判定所在文件系统；`off` 会 `config_set("sys.history", "")`。`goodbye()`（app_main 注册的 shutdown handler）在重启/关机前自动 `dump`。

## 二、命令注册框架（commands.cpp）

- 每个命令一个 `argtable3` 参数结构 + 处理函数，`ESP_CMD_ARG(d, c, h)` 宏按命名约定 `d_c` / `d_c_args` 拼 `esp_console_cmd_t`；v4/v5 结构体字段差异（`func_w_context/context`）由宏吸收；`ESP_CMD_CTX` 支持 context 回调。
- `ARG_PARSE`：含 `--help` 时打印语法与 glossary；解析失败打印错误并提示 `Try '<cmd> --help'`；成功后用 `ARG_STR/ARG_INT/ARG_DBL` 取值（未给参数用默认值）。
- 顶部 `CONSOLE_*` 宏按 `CONFIG_BASE_*` 条件编译各命令组，注释给出字节代价（如 `CONSOLE_NET_NOW` 15.5KB、`CONSOLE_NET_IPERF` 7.4KB）。
- `console_register_commands()` 末尾动态生成若干 argtable 的 datatype 提示（GPIO 范围、LED 索引范围、ADC 通道名、GPIO Expander 虚拟引脚范围 `PIN_I2C_BASE~PIN_I2C_MAX`）。

## 三、命令总表

### CLI

| 命令 | 说明 |
| --- | --- |
| `cd [PATH]` | 改工作目录（`PWD` 环境变量 + 提示符联动） |
| `cls` | 清屏（linenoiseClearScreen） |
| `ctx [PREFIX]` | 设置/清除命令前缀上下文 |

### System

| 命令 | 说明 |
| --- | --- |
| `reboot [-h] [-c] [-t ms]` | 软重启；`-h` 改为关机；`-t` 延时重启（内部 `reboot(ctx)` 可被 `-c` 取消，重复调用更新已有任务） |
| `update [boot\|fetch\|reset] [-p LABEL] [-u URL]` | OTA：`boot` 打印槽位信息或从指定分区启动；`fetch` 从 URL 升级；`reset` 清 OTA 状态 |
| `sleep [light\|deep\|pm] [BT\|ULP\|VAD\|TPAD\|WIFI] [-t ms] [-p GPIO...] [-l 0\|1...]` | 睡眠：light（GPIO/UART/触摸等唤醒，醒来打印唤醒源）、deep（EXT1/RTC）、`pm` 配置自动 light-sleep（`wake y|n` 开关，打印 `esp_pm_dump_locks`） |
| `exec [-h] [-l] [-s SYMBOL] PATH [-- ARGV...]` | ELF 加载执行：`-h` 读 ELF header、`-l` 列模块/符号、无 `-s` 走 `filesys_execute`（main 入口）、带 `-s` 走 `filesys_dlcall`（`--` 后参数传给 ELF） |

### Utility

| 命令 | 说明 |
| --- | --- |
| `date` | 当前时间（含微秒）与开机时刻 |
| `version` | 固件/IDF 版本信息 |
| `lshw` | 硬件信息（芯片/闪存/rev 等） |
| `lspart` | 枚举 flash 分区 |
| `lstask [0~6] [-vv]` | 任务列表（按状态/TID/CPU/优先级/名字/栈/占用率排序）；`-v` 加 esp_timer dump、`-vv` 再加事件循环 dump |
| `lsmem [-vv] [-c]` | 内存信息；`-v` heap_caps 各 caps 详情；`-c` 堆完整性检查（1~3 级） |
| `lsfs [PATH] [--stat --norm --info --vfs]` | 目录列表/文件 stat/路径归一化/FS 信息/VFS fd 表（v5+） |
| `hist [on\|off\|load\|dump] [PATH]` | 命令历史持久化 |
| `config [KEY [VAL]] [--load --dump --list --all --env --del NS]` | 配置读写：无参=stats；`--load` NVS→RAM、`--dump` RAM→NVS、`--list/--all` 列 NVS 条目；`--env` 切到进程环境变量后端（get/set/unset/environ 全量打印）；`--del NS [KEY]` 擦命名空间或单键 |
| `logging [TAG] [0~5\|NEWIDV] [--test]` | `esp_log_level_set/get`；TAG 以 `*` 为全局。注意源码注释的 **tag 缓存陷阱**：IDF 以指针缓存 tag，栈上字符串改名后 get 命中旧缓存——本命令用 32 槽 strdup 池规避 |

### Driver

| 命令 | 说明 |
| --- | --- |
| `gpio [PIN] [0\|1] [--cfg MODE:IO,PULL:UD,DRV:0-3] [--i2c\|--spi]` | 读写 GPIO（支持 Expander 虚拟引脚）；无 PIN 列扩展器引脚表；`--cfg` 重配置 |
| `usb [0~7\|SCMHcmhn] [--now]` | USB 模式查询/切换（字母对应 SerialJTAG/Cdc-host/Msc-host/Hid-host/Cdc-dev/Msc-dev/Hid-dev/Ncm-dev） |
| `led [IDX] [-l 0~255] [-c 0xRRGGBB] [-b BLINK]` | LED 亮度/RGB/闪烁模式；`-b >= LED_BLINK_RESET` 设闪烁、等于则停止 |
| `i2c [BUS] [ADDR] [REG] [VAL] [-l NUM] [-w]` | 无 ADDR 总线扫描；读/写字节或字（`-w` 16 位）；`-l` 连续寄存器 dump（smbus 系列封装） |
| `adc [IDX] [--joy\|--hall] [-i ms] [-t ms]` | 单通道/3 通道循环采样（mV）、摇杆、霍尔；`-t` 限时循环打印 |
| `dac [0\|1] [--one 0~255] [--cos 0~255] [-f 130~55000] [-s 0~3] [-p 0\|180]` | 一次性输出或余弦波（频率/幅度/相位），电压换算 mV |
| `pwm [-y 0~180] [-p 0~160] [-f 0~5000] [-l 0~100]` | 舵机横/纵角度（`pwm_set_degree`）或蜂鸣器音调/响度；无参查询当前值 |

### Network

| 命令 | 说明 |
| --- | --- |
| `bt [0~2\|dDH] [--now] [--scan] [-t ms] [-b 0~100] [-c BDA]` | BT 模式（经典 HIDD/BLE HIDD/BLE HIDH）、扫描、电量上报、连接） |
| `ip <IFACE> <CMD> [-s SSID] [-p PASS] [-i IP] [-t ms]` | 接口管理：`up/down/ip/gw/nm/dft/info/scan`，IFACE = sta\|ap\|eth |
| `now <on\|off\|add\|del\|pmk\|send\|cast> [MAC] [-m MSG] [-n NUM] [-k KEY16] [--ps y\|n] [--lr y\|n] [--ap]` | ESP-NOW：加删对端、广播/单播、LMK 密钥、省电/长距模式、走 AP 还是 STA 接口 |
| `ftm [-c on\|off] [-o cm] [SSID] [-n 0~32\|64]` | WiFi FTM 测距：发起端/应答端（S3 + `CONFIG_ESP_WIFI_FTM_ENABLE`） |
| `pmap <on\|off\|add\|del\|sync\|load\|dump> [-p tcp\|udp\|both] [-s PORT] [-h IP] [-d PORT]` | NAPT 端口映射管理（持久化到 NVS） |
| `pcap <on\|off> [eth\|wifi] [--num N]` | 抓包写 pcap 文件 |
| `mqtt <on\|off\|pub\|sub\|unsub\|load\|dump> [-u URL] [-t TOPIC] [-m MSG] [-q QOS] [--retain]` | MQTT 客户端（URL 格式 `schema://[user:pass@]host[:port][/path][#cid]`） |
| `mdns <on\|off> [-h HOST] [-s http\|smb] [-p tcp\|udp] [-t ms]` | mDNS 主机名/服务注册与查询 |
| `sntp <on\|off> [-h HOST] [-m immed\|smooth] [-i ms]` | SNTP 同步开关与模式 |
| `ping HOST [-i ms] [-l LEN] [-n NUM] [--stop] [-t]` | ICMP ping；`-t` 是地址解析器自测（v4/v6/带端口/十六进制化输出） |
| `iperf [-s\|-c HOST] [-p PORT] [-l LEN] [-i s] [-t s] [-u] [--stop] [-3]` | 带宽测试，`-3` 走 iperf3（默认端口 5201） |
| `tsync [-s\|-c HOST] [-p PORT] [-t ms] [--stat] [--stop]` | 自研 TimeSync 协议 |
| `hbeat <on\|off\|load\|dump> [--hurl URL] [--iurl URL] [--hdt SEC] [--idt SEC]` | 心跳上报：info/data 两个端点、两个周期 |

### Application

| 命令 | 说明 |
| --- | --- |
| `hid -k CODE / -s STR / -m B\|XYVH / -a XY / -p BTXYXY / -c 1~15 / -d LRUD [-t ms] [--ts ms] [--to 0~3\|UBNS]` | 统一 HID 报文：按键/打字/鼠标（相对+绝对+滚轮+按钮）/手柄（按钮/扳机/摇杆）/系统控制/Surface Dial；`--to` 选择 USB/BLE/NET/SCN 目标位掩码；无参打印当前 PAD 布局与 VID/PID；`--ts` 用于测量事件延迟 |
| `scn [BTN] [-r 0~3] [-g N] [-f FPS] [-p 0~100] [--font PATH]` | 屏幕控制：虚拟按键、软件旋转、间隙、LVGL FPS、进度条、加载字体 |
| `als [0~3] [-t 0~3\|HVA]` | 环境光传感器读数（lux）与光追踪（联动舵机输出 H/V 角度） |
| `avc [1~4\|audio\|video\|all\|cam] <on\|off\|print\|save\|{CFG}> [-t ms] [-o PATH] [-d]` | 音视频采集（AVI 录制/WAV 录音）；target=cam 时直接操作摄像头帧（print/fetch/yield/配置 JSON） |
| `qrc enc -t STR [-m 1~40] [-e 0~3] [-b 0~16] [-c inv\|ansi] [-f dots\|mini\|full] [-o out.bmp\|.svg] [-d]` / `app qrc dec` | 二维码生成（终端 ANSI 打印或落盘 BMP/SVG）与识别（抓一帧摄像头解码） |
| `sen <temp\|tpad\|tscn\|dist\|gy39\|pwr> [-i ms] [-t ms]` | 传感器轮询：片上温度/触摸板/触摸屏/VLX 测距/GY39 四合一（照度温湿压海拔）/电源状态 |

## 四、与其它模块的关系

- console 是设备上最通用的控制平面：HTTP `POST /api/exec`、WebSocket JSON-RPC、心跳/升级脚本都最终落到 `console_handle_command`；
- `ctx` 上下文 + linenoise 补全让串口交互接近 shell 体验；
- 所有命令都可直接从cmds ELF 子项目里通过 `console_handle_command` 编程调用。
