# 网络模块

`network.c` 承载 WiFi STA/AP、SPI 以太网（W5500）、ESP-NOW、NAPT 端口映射、pcap 抓包、MQTT、mDNS/NetBIOS、SNTP、ping、iperf、TimeSync、心跳上报。整个模块受 `CONFIG_BASE_USE_NET`（WiFi 或 ETH 任一启用即定义）控制，关闭时全部函数退化为返回 `ESP_ERR_NOT_SUPPORTED` 的空壳。

## 一、总体结构

- **事件组** `evtgrp`：所有异步流程用事件位同步。完整位表（network.c:38-52）：

  | 位 | 含义 |
  | --- | --- |
  | STA_CONN | STA 已连上 AP |
  | STA_FAIL | 连接失败 |
  | STA_STOP | 手动断开 |
  | STA_WAIT | 状态变化通知 |
  | STA_SCAN | 扫描完成（内部） |
  | HBT_STOP | 心跳任务退出 |
  | NOW_STOP | espnow 任务退出 |
  | FTM_DONE / FTM_FAIL | FTM 会话结果 |
  | PCAP_STOP | pcap 任务退出 |
  | MQTT_CONN | MQTT 已连接 |
  | TSS/TSC_STOP / TS_STOPPED | TimeSync 服务端/客户端停止 |

- **netif 表**：`netifs[3]`，宏 `if_ap/if_sta/if_eth`；`CONFIG_ESP_NETIF_REPORT_DATA_TRAFFIC` 时附带 TX/RX 速率统计（IP_EVENT_TX_RX 里做 2s 窗口的滑动平均）。
- **本地地址工具**：`network_local_ipaddr(ifp, V4|V6|ANY)` 按默认 netif → eth → sta(已连) 顺序取 IPv4（无则取全局 IPv6）；`network_local_ipstr` 返回 `IPSTR` 或 `IPV6STR` 字符串。
- **日志降噪**：初始化时把 `wifi/net80211/esp_netif_lwip/mdns_mem/iperf/smartconfig` 等 tag 压到 WARN。

## 二、WiFi

### 2.1 模式与启停

`wifi_mode_switch(sta, ap)`：参数 1/0/-1 = 开/关/不变，计算 STA/AP/NULL/APSTA 目标模式后 `esp_wifi_set_mode`。

- `wifi_sta_start(ssid, pass, ip)`：缺省取 `Config.net.STA_SSID/PASS/HOST`；已连接同 SSID 直接返回；否则先 `network_ctrl_static(if_sta, ip, gw)` 设置静态 IP（ip 来自 Config 时自动带上 `Config.net.STA_GATE`），再写 `wifi_sta_config_t`（`sae_pwe_h2e = WPA3_SAE_PWE_BOTH` 支持 WPA3）并 `esp_wifi_connect()`。
- `wifi_sta_stop(down)`：置 `STA_STOP_BIT` 防止自动重连，`down=true` 时连模式一起关。
- `wifi_ap_start(ssid, pass, ip)`：SSID 会追加 `-<UID>`（长度允许时），使多台设备热点名唯一；密码 <8 字节自动降级 `WIFI_AUTH_OPEN`；支持 FTM responder（S3）；channel/max_connection 来自 `Config.net.AP_CHAN/AP_NCON`。
- `wifi_ap_stop()`：仅关 AP 侧模式位。

### 2.2 扫描与显示

`wifi_sta_scan(ssid, channel, tout, verbose)`：阻塞模式时按 timeout 换算 per-channel scan_time（min=t/15 限 10~1400、max=t/10 限 20~1500），完成后 `wifi_get_ap_records()` 缓存到 `s_aps/s_nap`。`wifi_print_apinfo` 列出 RSSI、11b/g/n/lr、WPS、FTM 能力、认证模式、国家码、信道；SSID 含 >0x7F 字节时用 `gbk2str` 转 GBK→UTF8 显示。

### 2.3 连接失败自动回落

`cb_network`（WIFI_EVENT/IP_EVENT 处理中心）：

- `STA_DISCONNECTED`：非手动断开时静默重试 3 次（reason != NO_AP_FOUND）；重试耗尽置 FAIL，然后依次：`AP_AUTO` → 开 AP；`DPP_AUTO/SC_AUTO` → `network_command("sta","prov","on")` 启动配网任务；
- `GOT_IP`（STA/ETH）：设默认路由到该 netif、补建 link-local IPv6；然后按配置自动触发 **OTA 检查 → MQTT → SNTP → 心跳** 四件套；STA 情形下 `AP_AUTO` 会关掉 AP、`AP_NAPT` 会 `wifi_update_napt()` 开 NAT；
- `AP_STAIPASSIGNED`/`AP_STACONNECTED`：若开 NAPT，从任一上行口刷新 DHCP/DNS 转发。

### 2.4 配网（prov）

`prov_task`（优先级 5，栈 4KB，10 分钟超时）：

1. **DPP / EasyConnect**（`CONFIG_BASE_USE_EASYCONNECT`）：`esp_supp_dpp_bootstrap_gen(Config.net.DPP_CHAN, QR_CODE)` 生成 URI 后用内置 qrenc 在串口打二维码（反色），`dpp_qrcode` 缓存供 `net ip sta prov qrcode` 再打印；`CFG_RECVD` 事件直接拿凭据连 AP；失败重试 5 次。
2. **SmartConfig**（`CONFIG_BASE_USE_SMARTCONFIG`）：`SC_TYPE` 字符串包含 `v2/kiss/touch/fast` 关键字映射 ESPTOUCH_V2/AIRKISS/组合/快速模式；`GOT_SSID_PSWD` 后 `wifi_sta_start`，`SEND_ACK_DONE` 收尾。

### 2.5 NAPT

`WITH_NAPT` = WiFi + `CONFIG_LWIP_IPV4_NAPT`。`wifi_update_napt(if_src)`：AP 口 DHCP 停 → 设 `OFFER_DNS` 选项 → 把上行口主 DNS 抄给 AP → DHCP 重启 → `esp_netif_napt_enable(if_ap)` → `pmap_control("on")` 恢复端口映射。

### 2.6 FTM 测距

- `ftm_respond(on|off, offset_cm)`：AP 侧开关 + T1 偏移校正；
- `ftm_request(ssid, count)`：STA 侧找目标 AP（可现场扫描），frm_count 支持 8/16/24/32/64，burst_period=2（200ms），3 秒超时；成功打印逐帧 RTT 报告（ID/RSSI/RTT ns），事件里换算 `dist_est` cm。

## 三、以太网（SPI W5500）

`network_eth_init()`：引脚组 `RST/INT/MOSI/MISO/SCLK/CS`（`CONFIG_BASE_ETH_SPI`，来自 Kconfig 的 `BASE_ETH_PINS` 或自定义）；挂到 `SPI2_HOST`（与屏幕冲突时自动切 `SPI3_HOST`）；W5500 MAC/PHY 驱动 + netif glue；**会用 `ESP_MAC_ETH` 的 efuse MAC 覆盖 W5500 模块默认 MAC**。当前 EMAC（RMII）分支是 `ESP_ERR_NOT_SUPPORTED` 占位。

事件：`CONNECTED` 时按 `Config.net.ETH_HOST/ETH_GATE` 应用静态 IP；lost IP 时把默认路由让给 STA/ETH 存活方。

## 四、ESP-NOW

自定义轻量协议（`now_data_t`：1B crc + 1B flag + payload，CRC8 校验）：

| flag | 含义 |
| --- | --- |
| NOW_FLAG_PING / PONG | 发现保活（广播 ping 带 4 字节计数，单播 ping 无 payload） |
| NOW_FLAG_TEXT | 文本消息 |
| recv/send/cast/fail | 事件侧标记 |

- **自动组网**：收到陌生源 MAC 自动 `now_command("add")`；加密对端用 `now_calc_lmk`：`MD5(Config.net.NOW_LMK || min(MAC) || max(MAC))` 生成 16 字节 LMK（双方对称，无需预共享每对密钥）；广播对端不加密。加密 peer 上限 `ESP_NOW_MAX_ENCRYPT_PEER_NUM`，满员不再加密。
- **任务** `now_task`（栈 8KB，优先级 4）：广播 ping 1s 间隔（`cast_ms`）、单播保活 ping 5s、队列 10 深度；`send fail` 的单播对端自动移除；启动时广播 3 次宣告。
- `now_command`：`on/off/add/mod/del/set/pmk/send/cast`。`set` 控制 LongRange 协议（`WIFI_PROTOCOL_LR`）与省电（wake window 50ms / connless interval 100）；`pmk` 设 16 字节 PMK；无参数列出 peer 表（CH/ITF/ENC/LMK sha）。
- 静态断言保证 `now_param_t.mac/lmk` 与 ESP-NOW 结构长度一致。

## 五、NAPT 端口映射（pmap）

`IP_PORTMAP_MAX` 条静态表项 `{proto, sport, daddr, dport}`，持久化在 NVS 命名空间 `pmap` 的 blob `ctx`（`config_nvs_read/write` 整块读写）。`pmap_command`：`on/off`（`ip_portmap_add/remove` 到本机 IPv4）、`add/del`（proto 可 `tcp|udp|both`，同端口双协议两条目）、`sync/load/dump`。无参打印映射表。

## 六、抓包（pcap）

`WITH_PCAP`（espressif/pcap 组件）。`pcap_task`（栈 8KB，优先级 10）：

- WiFi 侧：混杂模式回调，剔除 MISC/FCS 4 字节，802.11 link type；ETH 侧：`esp_eth_update_input_path` + 混杂；
- 队列 10 深度，写 `data/` 下 `wifi.pcap` / `eth.pcap`（时区 CST-8），`--num N` 限包数停止；
- `on|off` + 无参打印 `pcap_print_summary`。

## 七、MQTT

`WITH_MQTT`（espressif/mqtt）。会话上下文存 NVS `mqtt` 命名空间 blob `ctx`，JSON 结构：

```json
{ "url": "mqtt://...", "cid": "...", "tpc": { "<topic>": <msgid> } }
```

- URL 解析用 `http_parser`：`#fragment` 作为 client id；无 fragment 有 userinfo 时 `set_null_client_id`（用 username）；都没有用平台默认 id。
- `mqtt_command`：`on/off/start/stop`、`sub/unsub <topic>`（订阅 QoS2，msgid 记入 tpc 表）、`pub [-q 0..2] [--retain]`（省略 topic 时需 tpc 表恰好只有一个主题）、`load/dump`（NVS 同步，dump 时把已订阅项归零、未完成的剔除）。
- `MQTT_CONNECTED` 时自动补订阅所有 valueint<=0 的主题；断线后 msgid 归零等待重连重订。

## 八、mDNS / NetBIOS

`mdns_initialize()`：主机名 `<MDNS_HOST|NAME>-<UID>`；注册服务：

| 服务 | 端口 | TXT |
| --- | --- | --- |
| `_id._tcp` | 1 | name / ver / uid |
| `_tss._tcp` | TIMESYNC_PORT（9777） | - |
| `_http._tcp` | 80（CONFIG_BASE_USE_WEBSERVER） | - |

并初始化 NetBIOS（名字截 15 字符）。查询：`mdns_query_a/aaaa` 主机名解析、`mdns_query_ptr` 服务发现（结果打印 PTR/SRV/TXT/A/AAAA）。

## 九、SNTP

`sntp_command`：`on/off/reset|sync`、`-h HOST`（占用第一个空槽；域名走 `setservername`，IP 走 `setserver`；DHCP 供服自动切换）、`-m immed|smooth`、`-i ms` 同步周期。无参打印状态/模式/间隔/服务器可达性。

## 十、诊断工具

- **ping**：`esp_ping` 会话封装，成功/超时/结束三回调打印 ICMP 行与统计；`--stop` 结束会话；`ping_command` 静态单会话句柄防并发。`network_parse_ipaddr` 用 `parse_address`（globals.h，支持 v4/v6/`host:port`/`[v6]:port`）。
- **iperf**：`WITH_IPERF`（espressif/iperf）。支持 v2 与 `-3`（iperf3，端口 5201）；自动填本地地址（缺 v4 或 v6 对应能力时报 INVALID_STATE）；`--stop` 停全部实例。
- **TimeSync**：自研协议（timesync.h 默认端口宏 `TIMESYNC_PORT`，mDNS 注册 `_tss._tcp`）。`tsync_command`：无 host 启 server 任务 `tss`（loop 周期 0.5s），带 host 启 client `tsc`（30s 周期，`timesync_client_xsync(&offset, 5)` 采样 5 次求时钟偏移，9 位小数精度日志）。停止用事件位（**不用 vTaskDelete**，保证 socket 清理）。

## 十一、心跳上报（hbeat）

上下文 NVS `hbeat` 命名空间 blob `ctx`（结构体除 nvs 指针外整块持久化）：`hbtime/intval/apssid/appass/hbturl/imgurl/location/deviceid`。

`hbeat_task`（栈 4KB，优先级 10）双周期循环：

- **info 周期**（hbturl，默认 30s）：POST JSON `{"sn": UID, "mac_address": ..., "beat_time": "...", "ip_address": ...}`；响应必须是 JSON，**服务器可通过响应反向下发配置**——`hbeat_update()` 解析 `deviceid/location/apssid/appass/hbtime/intval/hurl/iurl`，其中 apssid/appass 变化会直接重开/关闭 AP（云端遥控热点）。
- **data 周期**（imgurl，默认 5s，需摄像头）：multipart/form-data（boundary `FRAME`）上传 `ip_address/mac_address/image` 三段，图像来自 `CAMERA_FETCH`；响应含非 ASCII 时按 GBK 转 UTF8 打印。

`hbeat_command`：`on/off/load/dump`、`--hurl/--iurl/--hdt/--idt` 修改参数；无参打印当前全部字段（location 的 GBK 亦转换）。

## 十二、启动序列

`network_initialize()`：netif init → 默认事件循环（已存在则跳过）→ 日志降噪 → 事件组 → ETH（可选，立即起链路）→ WiFi init + AP/STA netif + `esp_wifi_start()`（先 NULL 模式）→ 注册三路事件 → `MDNS_RUN` → `SNTP_RUN` → STA 用 `wifi_config` 里残留或 NVS 中的凭据启动，失败且 `AP_AUTO` 时用上次的 `espbase-<UID>` AP 配置开热点。
