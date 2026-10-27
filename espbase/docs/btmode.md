# 蓝牙模式

蓝牙部分只做 HID（键鼠/手柄外设或主机），与 USB 共用 hidtool 报文层（见 [hidtool](hidtool)），受 `CONFIG_BASE_USE_BT` 控制。Bluedroid 依赖（`CONFIG_BT_HID_DEVICE_ENABLED` 等）缺失时编译期 `#warning` 并自动降级。

## 一、模式仲裁（btmode.c）

```c
typedef enum { BT_HIDD, BLE_HIDD, BLE_HIDH } btmode_t;
// 语义宏：ISBT/ISBLE/ISSRV/ISCLI
```

三种模式的 `init(prev)/exit(next)` 注册在静态表 `modes[]`：

| 模式 | init | 传输栈 |
| --- | --- | --- |
| BT_HIDD | 经典蓝牙 HID Device | Bluedroid GAP(COD=Peripheral) + `esp_bt_hid_device` |
| BLE_HIDD | BLE HID Device | Bluedroid GATT + `esp_hidd_dev_init(ESP_HID_TRANSPORT_BLE)` |
| BLE_HIDH | BLE HID Host | GATTC + `esp_hidh_init` |

`btmode_switch(mode, reboot)` 与 USB 模式仲裁同构：先旧模式 exit → `config_set("sys.bt.mode", ...)` 持久化 → 未干净退出时 `reboot ? esp_restart() : PENDING_REBOOT` → 新模式 init。`btmode_initialize()` 按 `Config.sys.BT_MODE` 字符串（大小写不敏感）匹配启动，空串视为软件禁用（`ESP_ERR_BTMODE_DISABLED`）。

对外 API（btmode.h）：

- `btmode_scan(timeout_ms)`：server/client 通用扫描（设备列表打印含 RSSI/名称/COD/UUID）；
- `btmode_config(connectable, discoverable)`：server 侧 GAP 可连/可发现开关；
- `btmode_battery(pcent)`：server 侧 BAS 电量上报；
- `btmode_connect(name, bda)`：client 侧按名称或地址连接。

`bt_common_init(mode, fresh)`：`esp_bt_controller_init`（内存不足时提示 `btmem`）、enable、`esp_bluedroid_init/enable`、GAP 名称 `<NAME>-<UID>`、配对安全参数（IO_CAP_OUT，MITM，bond）。

## 二、HID 设备（btdev.c）

- **BLE_HIDD**：report map 直接用 `HIDTool.desc`（与 USB 描述符一致）；广播名同 GAP 名，`HIDTool.pad != GENERAL` 时 appearance 置 `ESP_HID_APPEARANCE_GAMEPAD`；GATTS 回调用 IDF 的 `esp_hidd_gatts_event_handler`。
- **BT_HIDD**：不用 IDF 的 `esp_hidd` BT transport（注释明确说明），直接 Bluedroid `esp_bt_hid_device` + GAP COD 设置，虚拟 SDP 记录注册 HID 描述符。
- 输出方向 `hidb_send_report(rpt)`：经典走 `esp_bt_hid_device_send_report(INTRDATA, id, size)`，BLE 走 `esp_hidd_dev_input_set`；未连接/报文非法静默丢。
- Host→Device 输出报告（如 XInput 震动）与按键/电量状态在 `bt_hidd_cb/ble_hidd_cb` 中处理并回传 hidtool。

## 三、HID 主机（bthost.c）

`BLE_HIDH`：`esp_hidh_init`（gattc 回调 `esp_hidh_gattc_event_handler`）+ 扫描结果过滤 HID 服务 UUID，`esp_hidh_dev_open` 连接；输入报告按 report id 反解为 `hid_report_t` 后走统一接收层（鼠标/键盘状态机见 hidtool）。`ble_hidh_exit` 反初始化并在下一模式非 BLE 时连控制器一起关。

## 四、与系统的交互

- `bt` 命令（[console](console)）封装 `btmode_scan/config/battery/connect`；
- `sys.bt.mode` 配置热更新：config 事件处理里 `btmode_switch(..., --now 时立即重启)`；
- `sys.bt.scan` 控制 GAP 可发现性；
- 心跳/上位机可经 `hid_report_send(HID_TARGET_BLE, ...)` 把手柄输入直接注入已连接主机。
