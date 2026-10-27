# 构建系统

本文档描述 espbase 的构建流水线：顶层 `CMakeLists.txt` 的编排逻辑、`helper.py` 的全部子命令、`sdkconfig` 变体矩阵、分区表与 NVS 出厂镜像、以及 `cmds/` 下的 ELF 动态加载子项目。

## 一、顶层 CMakeLists.txt 流程

```
idf.py build
  └─ 顶层 CMakeLists.txt
       ├─ SDKCONFIG 层叠：sdkconfig → sdkconfig.local → sdkconfig.defaults.v{major}
       ├─ execute_process(helper.py prebuild)     # configure 阶段执行一次
       ├─ project(espbase VERSION 1.1.0)          # MINIMAL_BUILD ON
       ├─ POST_BUILD: helper.py postbuild         # 每次链接后生成 delta 补丁
       ├─ FFS 镜像：spiffs/fatfs/littlefs_create_partition_image(storage, data/)
       │    └─ 对 cmds/* 每个子目录调用 elf_build()，产物复制进 data/bin/
       └─ nvs_create_partition_image(nvs, nvs_flash.csv FLASH_IN_PROJECT)
```

### 1.1 sdkconfig 层叠顺序

```cmake
set(SDKCONFIG_BASE "${CMAKE_CURRENT_LIST_DIR}/sdkconfig")
set(SDKCONFIG_LOCAL  "${SDKCONFIG_BASE}.local")           # 存在则追加
set(SDKCONFIG_IDFVER "${SDKCONFIG_BASE}.defaults.v${IDF_VERSION_MAJOR}")
set(SDKCONFIG_DEFAULTS "${SDKCONFIG_BASE}.defaults")      # 基础默认值
# 追加顺序：defaults → .local → .defaults.v{4|5}
```

即 `sdkconfig.defaults` 先生效，`sdkconfig.local`（开发者本地开关，gitignore）可覆盖，最后 `sdkconfig.defaults.v4/v5` 按当前 IDF 大版本覆盖芯片差异项。

另外支持通过 `SDKCONFIG` 环境变量多目标并存：实际构建目录名即目标名（`build-eth`、`build-mini`、`build-s3`），`helper.py -B/--bdir` 全程跟随 `CMAKE_BINARY_DIR`：

```bash
idf.py -B build-s3 set-target esp32s3
idf.py -B build-s3 build
```

### 1.2 elf_build() —— 子项目自动发现

```cmake
function(elf_build app_name app_path)
    # TYPE 未指定时读取子项目 CMakeLists.txt：
    #   含 project_elf() → ELF 目标（build_target = elf）
    #   含 project_so()  → SO  目标（build_target = so）
    # 用 externalproject_add 在 ${bdir}/elf_${app_name} 下独立配置构建，
    # 构建命令由生成器决定（ninja/make <elf|so>）
    # 产物拷贝：
    #   ELF → data/bin/${app_name}      （无后缀）
    #   SO  → data/bin/${app_name}.so
    # 通过 add_custom_target(elf_${app_name}_bin ALL) 挂进构建
endfunction()
```

顶层在 FFS 目标存在时自动 glob `cmds/*/CMakeLists.txt` 并注册，同时 `add_dependencies(${ffs_target} elf_${child}_bin)` 保证子项目先于文件系统镜像构建——**ELF/SO 产物因此被打进 `storage` 分区镜像**，设备端由 elf_loader 从文件系统加载执行（见 [filesys](filesys)）。

`cmds/` 当前包含 `hello`、`misc` 两个子项目，各自是独立 CMake 工程，可复用主工程的组件（`EXTRA_COMPONENT_DIRS` 已把 `$ENV{IDF_PATH}/../components` 加入搜索路径）。

### 1.3 nvs_create_partition_image()

自定义函数（优于 IDF 内置 nvs 工具链封装）：

1. 从 `partitions.csv` 解析 `nvs` 分区的 offset/size（`load_csv` 跳过注释行）；
2. 调用 `helper.py gencfg --tpl nvs_flash.csv --pack ${bdir}/nvs.bin --size ... --offset ...` 生成二进制；
3. 注册 `${partition}-flash` 目标；`FLASH_IN_PROJECT` 时同时挂进 `idf.py flash` 的镜像列表。

`gencfg` 渲染失败会在配置期直接 `fail_at_built_time`，避免静默产出坏镜像。

### 1.4 FFS（Flash File System）镜像三选一

按 `CONFIG_BASE_FFS_*`：

| 配置 | 镜像函数 | 备注 |
| --- | --- | --- |
| `BASE_FFS_SPI` | `spiffs_create_partition_image` | 唯一支持 IDF v4 的选项 |
| `BASE_FFS_FAT` | `fatfs_create_spiflash_image` | `PRESERVE_TIME` 保留时间戳 |
| `BASE_FFS_LIT` | `littlefs_create_partition_image` | 掉电安全（joltwallet/littlefs） |

镜像源固定为 `${sdir}/data`，分区名 `CONFIG_BASE_FFS_PART`（默认 `storage`）。若三个目标都没匹配到会打印 WARNING 提示检查分区表。

## 二、helper.py 子命令

入口 `python helper.py [-q] [-B BUILD_DIR] <command> ...`，`-B` 决定 sdkconfig 读取与产物输出位置。公共能力：

- `load_gitignore()` / `walk_exclude()`：按 `.gitignore` 过滤文件遍历（`fnmatch._compile_pattern` 带 LRU 缓存）；
- 可选依赖按需 import：bottle、detools、requests、zeroconf、numpy、turbojpeg/PyTurboJPEG、opencv-python（缺哪个就禁用对应功能而不是直接报错）。

### 2.1 prebuild —— configure 阶段自动执行

`execute_process(COMMAND ${helper_py} prebuild)`，做三件事：

1. **重建前端**（IDF v4.4 时顺带删除 managed_components 的 `.component_hash` 强制重校验）：遍历 `web/`（gitignore 过滤），发现任一文件 mtime 晚于 `data/www` 的 mtime + 10s，就执行 `pnpm run -C web build`。**开发者改前端后直接 `idf.py build` 即可，无需手动 pnpm build**。
2. **gengbk**：生成 `data/etc/gbktable.bin`——GBK 区 `0x8100~0xFE50` 每个码位对应 Unicode 的 `<H` 小端表（共 24016 项，约 47KB），供固件 `gbk2unicode/unicode2gbk` 使用。
3. **gendeps**：扫描 `main/` 所有 `#include "..."`，扣除本地 `main/include/`、libc（xtensa-esp-elf include、driver/、soc/ 前缀），再在 `managed_components`、`$IDF_PATH/components`、`$IDF_PATH/../components` 里按各组件 CMakeLists 的 `INCLUDE_DIRS` 反查头文件归属组件，**自动重写 `main/CMakeLists.txt` 的 `REQUIRES_V4`/`REQUIRES_V5` 字段**（按 IDF 版本选变量名，字母序输出，保留原缩进）。

### 2.2 postbuild —— 差分 OTA 补丁

每次固件链接后执行（见 [update](update) 的设备端消费逻辑）：

1. 校验 `esptool`、`detools` 可用，读取 `$BDIR/sdkconfig` 得到芯片型号；
2. `new = $BDIR/espbase.bin`，`old = $BDIR/delta/espbase.bak`（首次构建直接拷贝 new→old 后跳过）；
3. SHA256 前 8 位比较，内容未变则跳过；
4. `esptool image_info` 提取新镜像的应用 sha256（64 位 hex）；
5. `detools.create_patch(old, new, compression='heatshrink')` 生成补丁体；
6. 写出 `espbase.patch`，头部 64 字节结构：

```c
struct patch_header {          // struct.pack('<4s 32s I 24s')
    uint8_t  magic[4];         // sha256(b"esp_delta_ota")[3::-1] 反序前4字节
    uint8_t  img_hash[32];     // 新镜像完整 sha256（esptool image_info）
    uint32_t patch_size;       // 补丁体长度
    uint8_t  reserved[24];
};
```

7. 归档命名带双哈希：`espbase-{oldhash}-{newhash}.bin`（补丁）与 `espbase-{newhash}.bin`（全量），`old` 备份同步改名 `espbase.bak → espbase-{oldhash}.bin`。发布服务器按 URL 里的版本哈希提供对应补丁。
8. `--patch` 参数只产出补丁不挪备份。

### 2.3 gencfg —— NVS 出厂配置

```bash
python helper.py gencfg [--len 8] [--tpl nvs_flash.csv] [--pack nvs.bin]
                        [--size ...] [--offset ...] [--flash COM]
                        [--output DEST]
```

- 渲染 `nvs_flash.csv`（若存在 `nvs_flash.local` 则按行覆盖合并同名 key）；
- 模板变量：`{NAME}`（从顶层 CMakeLists.txt 正则提取项目名 espbase）、`{UID}`（`uuid4().hex[:8].upper()`）、`{URL}`（`http://<本机IP>:9999`）、`{OTA}`（`espbase.bin`）、`{HBT}`（`board`）；
- `--pack` 时自动调 `process_nvs`：动态 import IDF 的 `nvs_partition_gen` 与 `esptool`，用临时 argv 调 `generate.main()` 编码二进制，`--flash` 时再直接 esptool 烧写。

`nvs_flash.csv` 内容（即设备出厂默认配置）：

```csv
info,           namespace,
counter,        data,       u32,        0
uid,            data,       string,     {UID}

config,         namespace,
net.ap.ssid,    data,       string,     {NAME}     # 热点名 = espbase
net.ap.pass,    data,       string,     {UID}      # 热点密码 = UID
web.http.name,  data,       string,     hank       # Web 登录用户
web.http.pass,  data,       string,     {NAME}     # Web 登录密码 = espbase
app.ota.url,    data,       string,     {URL}/{OTA}
app.hbt.url,    data,       string,     {URL}/{HBT}
```

### 2.4 genfont —— 中文 LVGL 字体按需裁剪

```bash
python helper.py genfont <font.ttf> [--bin] [--bpp 1] [--size 12] [--output PATH]
```

- 用 `[\u4E00-\u9FA5]` 扫描 `main/` 全部 `.c/.cpp`（gitignore 过滤），收集源码中实际出现的汉字；
- 调 `lv_font_conv`（需 `npm i -g lv_font_conv`）生成 LVGL C 源或 `.bin`；
- 附加字形：UNSCII-8（size 为 8 的倍数时）+ 块元素/几何图形 `0x2580-0x25FF`、杂项符号 `0x2600-0x26FF`、盲文 `0x2800-0x28FF` + FontAwesome 图标码位表（约 60 个，硬编码于 `font_icon()`）；
- C 源输出后做 `font_postproc`：`lvgl/lvgl.h → lvgl.h`、补 `.fallback = LV_FONT_DEFAULT`；
- 默认输出：C 源 → `main/scnfont.c`；`--bin` → `data/etc/chinese_{size}.bin`。

### 2.5 sdkconfig —— 变体矩阵管理

```bash
python helper.py sdkconfig [+]feat [-]feat feat ...   # 无 +/- 为切换（toggle）
```

- 收集根目录与 `$BDIR` 下所有 `sdkconfig*` 文件为映射（`sdkconfig.defaults.camera` → 名字 `camera`，`sdkconfig.local` → `local`）；
- `+name` 把 `sdkconfig.defaults.name` 的内容以 `# >>> path` / `# <<< path` 标记块追加进 `sdkconfig.local`；`-name` 删除同名标记块；
- 无参数时进入"审计模式"：把 `defaults + local` 合并后与当前 `$BDIR/sdkconfig` 对比，打印"被覆盖而无效"的行（`=n` 与 `# CONFIG_X is not set` 等价处理）。

内置变体：

| 文件 | 作用 |
| --- | --- |
| `sdkconfig.defaults` | 基础：4MB flash、自定义分区表、PM、tickless idle、LWIP NAPT/IPv6 forward、FATFS LFN、LVGL 配置、ELF loader |
| `.camera` | 摄像头驱动子集裁剪 + Octal PSRAM 80M + USB_SERIAL_JTAG 控制台 |
| `.esp32` / `.esp32s3` | 芯片级：CPU 240MHz、WiFi IRAM 优化关闭 |
| `.flash8` / `.flash16` | 换用 `partitions-8m/16m.csv` |
| `.release` | WARN 日志、size 优化、断言静默 |
| `.v4` / `.v5` | IDF 版本差异（v4 用旧配置键名） |
| `.local` | 开发者本地（gitignore，由 sdkconfig 命令维护） |

组合示例（16MB S3 摄像板 release）：

```bash
python helper.py sdkconfig -flash8 +flash16 +camera +release
```

### 2.6 blame —— Flash/RAM 占用分析

封装 `idf_size.py --format json --archives`，把 `libxxx.a`、`lib_a-xxx`、`xxx.obj` 规整为组件名（`espressif__` 前缀简化为 `esp-`），按 DRAM bss/data、IRAM text、FLASH text/rodata/total 列对齐输出，`-s <field|index>` 排序，`--files` 退到文件粒度。

### 2.7 serve —— PC 端假服务器

`python helper.py serve [--esphost IP] [--static] [--test] [--certfile data/etc/server.pem] [root]`

用于脱离硬件调试前端，路由与固件 `server.c` 的 `/api/*` 一一对应：

| 路由 | 行为 |
| --- | --- |
| `/api/ws` | WebSocket（自带 RFC6455 实现，支持 permessage-deflate） |
| `/api/alive` | 有 `--esphost` 时 307 重定向到设备 |
| `/api/exec` | 同上重定向 |
| `/api/media` | `?video=mjpg` 输出 multipart/x-mixed-replace MJPEG（numpy 随机帧 + turbojpeg/opencv 编码）；`?audio=wav` 输出无限 WAV 流；POST 更新像素格式 |
| `/api/edit` | 文件管理：`?list&path=` 列目录 JSON；`?path=` 下载；POST/PUT/DELETE 上传/写入/删除 |
| `/api/config` | GET 返回 `nvs_flash.csv` config 命名空间；POST `json=` 表单字段更新 |
| `/api/update` | GET 重定向 `/updation`（Vue 路由） |
| `/board` | POST 心跳接收（`image` 字段存 `snapshot.jpg`） |

实现细节：

- `Server(ThreadingMixIn, WSGIServer)`：多线程 WSGI；`get_request()` 用 `MSG_PEEK` 嗅探首字节 `0x16` 判断 TLS，按需 `wrap_socket`（HTTP/HTTPS 同端口）；
- 补丁 `bottle.Bottle.wsgi` 实现 WebSocket 握手（`Sec-WebSocket-Accept` SHA1 魔串、子协议、`premessage-deflate` 扩展协商，RSV1 位压缩帧处理）；
- `static_factory`：目录自动找 `index.html`，文件不存在时尝试追加 `.gz` 并置 `Content-Encoding: gzip`（**与固件端行为一致**），404 时回落到 SPA 的 `index.html`；
- `--test` 对每个 API 发真实请求（401/3xx 时带 gencfg 出的账号密码重试）做兼容性自检；
- `search`（mDNS/zeroconf 发现设备）与 `serve` 联动：未指定 `--esphost` 时自动搜 `_id._tcp.local`。

## 三、分区表

三套分区表（`partitions.csv` 默认 4MB，`partitions-8m.csv`、`partitions-16m.csv`）：

```csv
# partitions.csv（4MB，"Balance OTA" 方案，注释中还有 Basic/Mass Storage 两套备选）
otadata    data  ota     0x009000  0x002000
nvs        data  nvs     0x00B000  0x004000
phy_init   data  phy     0x00F000  0x001000
silver0    app   ota_0   0x010000  0x1B0000   # 1728KB
silver1    app   ota_1             0x1B0000
storage    data  (spiffs/fat/littlefs)  0x090000  # 576KB

# partitions-8m.csv：无 factory，双 ota_0/1 各 2368KB + storage 1MB
golden     app   factory 0x010000  0x250000
silver0/1  app   ota_x             0x250000
storage    data           0x100000

# partitions-16m.csv：双 3MB ota + 7104KB storage（ELF/前端/媒体文件空间充裕）
```

要点：固件更新走 ota_0/ota_1 双 silver 槽（`silver` 即"次级槽"命名），`storage` 分区标签必须与 `CONFIG_BASE_FFS_PART` 一致；NVS 固定 16KB（`gencfg` 默认 offset 0xB000 size 0x4000 即来源于此）。

## 四、组件依赖

`main/idf_component.yml`（IDF Component Manager）声明第三方组件，含大量按版本/芯片的条件规则：

| 组件 | 用途 |
| --- | --- |
| `elf_loader ^1.3.2` | 运行时加载 ELF/SO（cmds 子项目） |
| `esp32-camera ^2.1.7` | 摄像头 |
| `esp_delta_ota ^1.1.2` | 设备端应用差分补丁 |
| `lvgl/lvgl ^8` + `esp_lvgl_port` | 屏幕 UI |
| `esp_tinyusb ^1.7.6` | USB 设备栈（S2/S3） |
| `usb_host_cdc_acm/msc/hid` | USB 主机栈（S2/S3） |
| `quirc ^1.2.0` | 二维码识别 |
| `qrcode ^0.2.0` | 二维码生成 |
| `knob / button / led_indicator / touch_element` | 输入外设 |
| `pcap ^1.0.2` | 抓包文件格式 |
| `iperf ^1.0.3` | 网络测速 |
| `mdns`（IDF≥5）、`joltwallet/littlefs`（IDF≥5） | 条件依赖 |
| `usb / mqtt / cjson / touch_element` | IDF≥6 时从 IDF 内置组件改为外部 |

`main/CMakeLists.txt` 的 `REQUIRES_V4`/`REQUIRES_V5` 不手写，由 `gendeps` 依据源码头文件引用自动维护。
