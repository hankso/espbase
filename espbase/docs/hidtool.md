# USB 与 HID 子系统

固件把 USB（esp_tinyusb 设备栈 / usb_host 主机栈）与蓝牙 HID 统一到一个 **HID 事件层**（hidtool），USB/BT/网络/屏幕都是它的"目标端"。

## 一、HID 统一层（hidtool.c / hidtool.h）

### 1.1 Report ID 体系

```c
enum {
    REPORT_ID_KEYBD = 1,    // 8B: modifier + reserved + 6 keycodes
    REPORT_ID_MOUSE,        // 5B: buttons + int8 x,y,wheel,pan（相对）
    REPORT_ID_ABMSE,        // 8B: buttons + uint16 x,y（绝对 0~4095）+ int8 wheel,pan
    REPORT_ID_POINT,        // digitizer: tip/rng + uint16 x,y
    REPORT_ID_TOUCH,        // 5 指多点触摸（每指 tip/cid/x/y 0~10000‰）+ rate + count
    REPORT_ID_GMPAD,        // 手柄，长度按布局（见下）
    REPORT_ID_SCTRL,        // 系统控制（power/sleep/wake/menu/dpad...19 键）
    REPORT_ID_SDIAL,        // Surface Dial（press/release + ±56 旋转）
};
```

统一发送入口 `hid_report_send(hid_target_t to, hid_report_t *rpt)`，`to` 位掩码 `HID_TARGET_USB|BLE|NET|SCN`：

- USB：`hidu_send_report`（usbdev.c，TinyUSB HID endpoint）；
- BT：`hidb_send_report`（btmode.c → btdev/bthost）；
- NET：UDP 单播/广播到 `Config.app.HID_HOST`（默认 `10.0.2.255`，即 AP 网段广播），端口 4950；
- SCN：`scn_command(SCN_INP, rpt)` 注入屏幕虚拟输入。

路由约束：非 GENERAL 布局时只放行 GMPAD 报文；GENERAL 布局时 GMPAD 也走 general 布局。发送成功后按 report 类型打人类可读日志（键名/按钮名/摇杆值）。

### 1.2 手柄布局与描述符（hiddesc.h / Config.app.HID_MODE）

| 模式 | VID:PID | GMPAD 报文 | 描述符来源 |
| --- | --- | --- | --- |
| GENERAL（默认） | 0x05DF:0x4000 | `general`：6 轴 int8 + dpad + 16 btn | 内置 7 段描述符宏拼接（keybd+mouse+abmse+point+gmpad+sctrl+sdial ≈ 405B） |
| XINPUT | 0x045E:0x0B13（微软） | `xinput`：uint16 轴 + uint16 扳机 | `data/etc/xinput.hid`（283B 文件加载） |
| SWITCH | 0x057E:0x2009（任天堂 Pro） | `nswitch` | `switch.hid`（170B） |
| DSENSE | 0x054C:0x0CE6（PS5） | `dsense` | `dsense.hid`（279B） |

按钮语义统一在 `hid_gmpad_data_t`（A/B/X/Y/LB/RB/LS/RS/PREV/NEXT/HOME/SHARE/U/R/D/L 共 16 位），`gmpad_dump_data()` 按目标布局重排位序并缩放轴值（如 xinput 轴 `+0x8000` 变 uint16、扳机 `<<2` 到 10bit）。XInput 还支持输出报告（马达震动 8 字节 `hid_gmpad_output_xinput_t`）。

API 便利层：`hid_report_keybd_press`（`"a|b|Ctrl|F1|Enter"` 字符串语法，`str2keycodes` 解析，超 6 键截断）、`hid_report_mouse_click/moveto`、`hid_report_gmpad_click`（含 dpad 名 UR/DR/DL/UL）、`hid_report_sctrl`（按后 50ms 自动释放）、`hid_report_sdial`。

接收侧：`hid_handle_keybd/mouse/abmse(from, rpt, cbs)` 按 from 位（最多一路）维护 8 槽历史状态，产出按下/释放沿回调（`hid_key_cb`）与累计位移回调（`hid_pos_cb`）——供按钮驱动/屏幕光标等使用。

## 二、USB 模式仲裁（usbmode.c）

`usbmode_t`：`SERIAL_JTAG, CDC_HOST, MSC_HOST, HID_HOST, CDC_DEV, MSC_DEV, HID_DEV, NCM_DEV`。单模式独占（同一时刻只能一个 init）。

- `usbmode_switch(mode, reboot)`：先调旧模式 `exit(next)`；`config_set("sys.usb.mode", ...)` 持久化；若旧模式退出失败（如 v4 无法卸载 tinyusb），`reboot=true` 则 `esp_restart()`，否则置 `PENDING_REBOOT` 状态待下次重启生效；然后 `init(prev)`。
- `usbmode_initialize()`：按 `Config.sys.USB_MODE` 字符串匹配启动（大小写不敏感）；空串视为软件禁用（`ESP_ERR_USBMODE_DISABLED`）。
- `usbmode_status()`：打印当前模式 + host/device 细分状态。
- CFG_UPDATE 事件（config.c）监听 `sys.usb.mode` 变更即时切换（`--now` 时立即 reboot 应用）。

## 三、USB 设备模式（usbdev.c，TinyUSB）

设备描述符**运行时拼装**（`desc_cfg()`）：按 `enabled[]` 位累加 CDC（IAD 复合类）/MSC/HID/NCM 接口描述符，端点号自动递增；VID/PID/字符串全部取自 `HIDTool`（即 HID_MODE 决定外观身份）。模式切换用 `tud_disconnect → desc_cfg() → msleep(100) → tud_connect` 重枚举。

| 模式 | 实现要点 |
| --- | --- |
| CDC_DEV | `tusb_cdc_acm_init`；`CONFIG_BASE_USB_CDC_DEVICE_SERIAL` 回环 echo + line coding 日志；`..._CONSOLE` 把 stdio 重定向到 USB（`esp_tusb_init_console`） |
| MSC_DEV | `tusb_msc_storage` 挂 **storage 分区镜像**（FAT 时用 wear-levelling 句柄，v4 走 sdmmc 接口）；拔出前需 busy 检查；`NUM_DISK=1` |
| HID_DEV | 报告描述符 = `HIDTool.desc`（见上），boot protocol 关闭（混合键鼠），轮询 10ms；`hidu_send_report` 按 report id 分发 `tud_hid_report` |
| NCM_DEV | `tinyusb_net` + 私有 `usb_descriptors.h`；MAC 用 esp_read_mac(NET)；**v4 不支持**（头文件里 `#warning` 并 undef） |

v4/v5 差异：v4 无法 `tinyusb_driver_uninstall`（`usbd_common_exit` 返回 NOT_SUPPORTED → 切模式必然要求重启）；v4 用弱符号覆盖 `tud_descriptor_configuration_cb`。

## 四、USB 主机模式（usbhost.c）

标准三段式生命周期（源码官方模板风格）：`usb_lib_task`（安装/卸载 host library，NO_CLIENTS/ALL_FREE 事件收敛）+ 每类一个 client 任务（`USB-CDC/MSC/HID`，优先级 6，栈 4KB）+ 事件位组握手（BIT_USBLIB_INIT/EXIT、BIT_CLIENT_INIT/EXIT、BIT_DEVICE_INIT/EXIT）。

- 设备过滤 `usbdev_interest(desc)`（usbdev.c）：新设备 VID 等于 `HIDTool.vid`，或 class 命中 CDC/MSC/HID/IAD 复合，才触发 `BIT_DEVICE_INIT`；否则打印完整描述符。
- **CDC_HOST**：`cdc_acm_host_open(vid,pid)` → 读 line coding → 演示发 `"help"` + DTR/RTS；RX 数据 hexdump 日志。
- **MSC_HOST**：`msc_host_vfs_register` 挂载到 `/msc`（FATFS），断开自动 unregister；`usbhost_status` 可打印挂载信息。
- **HID_HOST**：`hid_host_device_get_report` → 键盘走 `hid_handle_keybd(from=HID_TARGET_USB...)` 注入统一层（即 USB 键鼠输入也会路由到屏幕/网络等其他 target），鼠标走 `hid_handle_mouse`。
- 超时常量：idle 10ms / loop 250ms / wait 500ms。

## 五、按键虚拟化

`drivers.c` 的 button/knob 驱动（见 [drivers](drivers)）产生的物理按键事件也走 `hid_report_gmpad_click(HID_TARGET_xxx, "A", ms)` 一类 API，实现"板上按键 = 手柄按键/键鼠"的联动。
