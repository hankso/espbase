# 配置系统

固件配置围绕一个全局结构体 `Config`（config.h）展开，RAM 中常驻、NVS 中持久化、HTTP/命令行/前端可改。所有值**一律以字符串存储**（`const char *`），`1`/`y`/`on` 视为真（见 `globals.h -> strtob`），数值字段用时再 `parse_*` 转换。

## 一、数据结构

`config_t` 分五个域：

```c
typedef struct {
    config_sys_t sys;    // timezone/history/prompt/目录/按键/USB/BT 模式
    config_net_t net;    // 以太网、STA、AP、SmartConfig、DPP、ESP-NOW LMK
    config_web_t web;    // WebSocket 与 HTTP 鉴权账号
    config_app_t app;    // OTA/心跳/HID/MQTT/mDNS/SNTP/触摸屏
    config_info_t info;  // name/ver/uid —— config_initialize 后只读
} config_t;
extern config_t Config;
```

## 二、扁平化键值（rwlst / rolst）

`config.c` 内部维护两张映射表，把 `Config.<group>.<FIELD>` 展平为 `<group>.<field>.<entry>` 小写键：

```c
typedef struct {
    const char * key;      // "sys.dir.data"
    const char ** val;     // &Config.sys.DIR_DATA（指向结构体字段的指针）
    char * freeval;        // config_set 写入时的 strdup 副本（标记 modified）
} config_entry_t;
```

- `rwlst[]`（可写）：sys 12 项 + net 19 项 + web 5 项 + app 13 项，共 49 项；
- `rolst[]`（只读）：`name` / `ver` / `uid`。

`config_get/config_set` 本质就是对这两张表的操作：`config_set` 改 RAM（strdup 到 `freeval`）→ `nvs_set_str` + `nvs_commit` → `esp_event_post(CFG_EVENT, CFG_UPDATE, key, ...)` 广播变更。任何模块都可 `REGEVT(CFG, handler)` 监听 `CFG_UPDATE` 事件做热更新（如 USB_MODE/BT_MODE 切换）。

空值语义：设为 `""` 时释放 `freeval` 并回指编译期默认串，同时 `setenv(key, value, true)` 把键值导出为进程环境变量（部分模块直接 `getenv` 读取）。

## 三、JSON 导入导出

```c
esp_err_t config_loads(const char *json);  // 递归展开嵌套对象 → config_set
char * config_dumps();                     // 平铺键值 → 未格式化 JSON（调用方 free）
```

`config_loads` 通过 `json_parse_object_recurse` 把 `{"net":{"ap":{"ssid":"x"}}}` 拼成 `net.ap.ssid` 再逐项 `config_set`；数字类型按真值转 `"1"/"0"`，其余类型报错跳过。`config_dumps` 输出平铺 JSON（前端直接用）。

## 四、NVS 命名空间

| 命名空间 | 内容 |
| --- | --- |
| `info` | `counter`（启动次数 u32，每次 `config_initialize` 自增并打印）、`uid` |
| `config` | 49 个可写配置项（全部 str 类型） |

核心函数：

- `config_nvs_init()`：找 NVS 默认分区 → `nvs_flash_init()`（必要时擦除重初始化）→ 打开 `config` 命名空间；
- `config_nvs_load()`：遍历 rwlst 逐键 `nvs_get_str`，键缺失走编译期默认值；
- `config_nvs_dump()`：遍历 rwlst 逐键 `nvs_set_str` + commit（命令行 `config save` 使用）；
- `config_nvs_list(bool all)`：迭代 NVS 条目打印。`all=true` 时附带分区统计（命名空间数、占用/总量、剩余百分比），config 命名空间的条目直接取 RAM 值，其余命名空间用 `nvs_repr_val` 实时读出（U8~I64 数字、STR、BLOB 转 hexdumps）。`pass/pswd` 结尾的键值打码为 `*`。

另有通用 blob/JSON 辅助（供其他模块存私有数据）：

```c
int config_nvs_read/write(void *hdl, const char *key, buf, len);   // blob
int config_nvs_jdump(void *hdl, const char *key, cJSON *obj);      // cJSON → str
void * config_nvs_jload(void *hdl, const char *key);               // str → cJSON（需 Delete）
```

## 五、启动初始化

`config_initialize()`（app_main 第一步）：

1. `config_nvs_load()` 把 NVS 值灌进 `Config`；
2. 打开 `info` 命名空间：读/自增/写回 `counter`；
3. 从应用描述符取 `NAME/VER`（`esp_app_get_description()`，v4 为 `esp_ota_get_app_description`），`UID` 从 NVS 读（出厂由 gencfg 写入）；
4. `Config.sys.TIMEZONE` 非空则 `setenv("TZ", ...) + tzset()` 生效时区（默认 `CST-8`）；
5. 创建默认事件循环（`CFG_EVENT` 与其他模块事件依赖它）。

## 六、出厂默认值要点

编译期默认值（`config.c` 顶部 `Config = {...}`）：

- `sys.PROMPT`：按芯片 esp32s3 / esp32 / esp；`DIR_DATA=/etc/`、`DIR_DOCS=/doc/`、`DIR_HTML=/www/`；
- `net.AP_HOST = "10.0.2.1/24"`（AP 网段）、`AP_NAPT="y"`（默认开 NAT 路由）、`AP_AUTO`/`SC_AUTO`/`DPP_AUTO = "y"`（STA 失败自动回落 AP + SmartConfig + DPP）；
- `web.AUTH_BASE="n"`（默认 digest 鉴权）；
- `app.MQTT_URL` 默认指向 `mqtt://rw:readwrite@test.mosquitto.org:1884`；`SNTP_HOST=pool.ntp.org`；`HID_HOST=10.0.2.255`（AP 网段广播）；
- 出厂镜像 `nvs_flash.csv`（gencfg 渲染）覆盖：`net.ap.ssid={NAME}`（即 espbase）、`net.ap.pass={UID}`、`web.http.name/pass`、`app.ota.url`、`app.hbt.url`。

## 七、前端 Schema 同步约定

`web/public/config.schema.json`（JSON Schema draft-07）由 `main/config.h` 手工生成，键与 rwlst 一一对应（平铺字符串键）。每个条目：

- `description` **必须与 config.h 中字段注释逐字一致**（维护约定：改 config.h 注释时同步 schema，反之亦然）；
- 按字段语义附验证规则：IP 字段 `anyOf: [{format: ipv4}, {maxLength: 0}]`、`sys.usb.mode` / `sys.bt.mode` 枚举（与 `usbmode.h`/`btmode.h` 枚举一致）、`sys.adc.mult` 数字范围、布尔字段 `pattern: ^[01yn]?$`。

前端用 ajv + ajv-formats 校验（`web/src/plugins/ajv.js`），SchemaForm/Schema* 组件按 schema 动态渲染表单（见 [webpage](webpage)）。

## 八、命令行接口

console 命令 `config`（详见 [console](console)）：

- `config list [all]` → `config_nvs_list`
- `config get <key>` / `config set <key> <val>` → `config_get/config_set`
- `config load <json>` / `config dump` → `config_loads/config_dumps`
- `config stats` → `config_stats`（modified 标记来自 `freeval` 非空）

HTTP 侧 `GET/POST /api/config` 直接映射 `config_dumps/config_loads`（见 [server](server)）。
