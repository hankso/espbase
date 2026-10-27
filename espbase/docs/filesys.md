# 文件系统

`filesys.c` 管理两套存储（Flash FFS + SD 卡），并提供基于 `espressif/elf_loader` 的运行时代码加载能力。

## 一、双存储模型

```c
typedef enum {
    FILESYS_VFS = -1,    // 未挂载（esp-idf 内建 VFS，如 /flash 等）
    FILESYS_FLASH = 1,   // CONFIG_BASE_USE_FFS：片上 flash 分区
    FILESYS_SDCARD = 2,  // CONFIG_BASE_USE_SDFS：SD/MMC
} filesys_type_t;
```

每个类型一个 `filesys_dev_t {type, mp, part, wlhdl|card}` 与一把互斥锁（`filesys_acquire/release(type, msec)` 供并发写保护，如 OTA 与摄像头同时落盘）。

### 1.1 Flash FFS（三选一）

| 配置 | 挂载 API | 特性 |
| --- | --- | --- |
| `BASE_FFS_FAT` | `esp_vfs_fat_spiflash_mount`（v5+ 映射为 `_rw_wl` 变体） | 磨损均衡 + FAT，`max_files=10`，不自动格式化 |
| `BASE_FFS_LIT` | `esp_vfs_littlefs_register` | `grow_on_mount=true`（自动扩容） |
| `BASE_FFS_SPI` | `esp_vfs_spiffs_register` | 默认兜底，无目录概念 |

挂载点/分区标签由 `CONFIG_BASE_FFS_MP/PART` 决定（默认 `/storage`）。挂载成功后 `setenv("PWD", mp)`。

**SPIFFS 目录模拟**（重要差异）：SPIFFS 是扁平的，项目用哨兵文件方案维护目录语义：

- `mkdir` 实际写 `<path>/_SENTINEL` 文件；
- `isdir`/`exists` 靠 `spiffs_childs()`（opendir 计数）判断；
- `rmdir` 仅当目录只含哨兵（`spiffs_childs > 1` 拒绝）时删除哨兵；
- `filesys_walk` 把含 `/` 的文件名折叠成虚拟目录项（`d_type=DT_DIR`，假 stat：size 4096 / mode 0755）并在遍历时跳过 `_SENTINEL`。

### 1.2 SD 卡（三路径）

`CONFIG_BASE_SDFS_SPI`：SDSPI 单线，挂在 `NUM_SPI`（与屏幕共享 SPI 时 CS 用独立 GPIO；S3ECAM 板硬编码 CS=GPIO4）。
ESP32-S3 SDMMC：按 `CONFIG_BASE_GPIO_MMC_*` 引脚，`CONFIG_BASE_SDFS_MMC` 1/4 线宽。
ESP32 SDMMC：默认槽位。
全部 `format_if_mount_failed=false`、`max_files=10`、`allocation_unit=16KB`；挂载后打印 CID/CSD/SCR 详情（`filesys_print_info`）。

## 二、路径处理

- `filesys_norm_r(type, buf, path)`：把任意路径归一化为 `<挂载点>/...`：自动剥离重复挂载点前缀、合并多余 `/`、`\\`→`/`、处理 `./` 与 `../`、去尾斜杠。非 reentrant 版本用静态 255 字节缓冲（`filesys_path_t`）。
- `filesys_join_r(type, buf, argc, ...)`：变参拼接（第一个参数若是 buf 自身则视作基路径，巧妙处理链式调用）。
- `filesys_get_type(path)`：按前缀判定文件系统；空路径用 `$PWD`。
- 快捷宏：`fnorm/fjoin/ftouch/fmkdir/frmdir/fisdir/fisfile/fexists/fload`（flash）、`snorm/...`（SD）。

## 三、目录遍历与列表

`filesys_walk`：不用 `scandir`（xtensa newlib 缺失），手写 readdir + 动态数组 + 双桶（目录优先、文件在后）+ `strverscmp` 排序（v1.0.1 > v1.0.10 自然序）。内存占用低于 glibc scandir。

两个消费者：

- `filesys_listdir` → `ls -alh` 风格输出（权限串/人类可读大小/`%b %d %H:%M` 或跨年 `%b %d  %Y`/名称，GBK 文件名自动转 UTF8）；
- `filesys_listdir_json` → `[{"name","size","date"(mtime 秒),"type":"dir|file"}]`，供 `/edit?list` 与前端文件管理器。

`filesys_readfile(type, path, &len)`：stat 校验大小（可传上限拒绝过大文件）→ 一次性 fread；`filesys_pstat` 打 stat 全字段（含纳秒时间戳、`statperm` 生成 `trwxrwxrwx` 权限串）。

## 四、ELF 动态加载

依赖 `espressif/elf_loader`（`CONFIG_BASE_USE_ELF`；`CONFIG_ELF_DYNAMIC_LOAD_SHARED_OBJECT` 开启时额外启用 dlopen 系 API）。

### 4.1 执行 ELF（独立可执行）

```c
filesys_execute(type, path, argc, argv)
  load_elf: esp_elf_init → filesys_readfile（上限 10KB，超出用真实 size）→ esp_elf_relocate
  esp_elf_request(&elf, 0, argc, argv)   # 跳转 main
  esp_elf_deinit
```

cmds 子项目产物（`data/bin/<name>`，见 [build](build)）即以此方式运行：`exec <路径> -- 参数...`。

### 4.2 ELF 元信息

`filesys_readelf(type, path, level 0~4)` 纯手工解析 ELF32：

- L1：ELF Header（magic/class/endian/OSABI/machine Xtensa 0x5e 特判/entry/各表偏移）；
- L2：Program Headers（LOAD/DYNAMIC 等，RWE 标志）；
- L3：Section Headers（常见 section 名映射）；
- L4：`esp_elf_t` 加载后的内存布局（text/bss/data/rodata 地址与大小、entry、加载基址）。

### 4.3 共享对象 dlopen（.so）

```c
filesys_dlcall(type, path, func, argc, argv)
  dlopen(norm(path)+1, RTLD_NOW) → dlsym(func) → ((int(*)(int,char**))ptr)(argc, argv)
```

- 内存保护限制：未开 PSRAM 加载且启用了 `CONFIG_ESP_SYSTEM_MEMPROT_FEATURE` 时直接拒绝（.text 无 EXEC 内存）；
- PSRAM 加载的已知 hack：函数指针落在 DROM 区间时手动 `+ (SOC_IROM_LOW - SOC_DROM_LOW)` 平移（警告"不完全支持"）；
- **故意不 dlclose**（注释：留作下次调用）；
- `filesys_dllist(module, symbol)` 列出已加载模块/符号。

返回值约定：`-ABS(返回值)`（esp_elf/dlcall 的负值错误码语义）。

## 五、挂载点布局（默认值）

```bash
/data/              # CONFIG_BASE_FFS_MP storage FFS 分区
├── www/            # Config.sys.DIR_HTML，Vue SPA 产物（gzip/brotli 预压缩）
├── doc/            # Config.sys.DIR_DOCS，生成的文档
├── etc/            # Config.sys.DIR_DATA：字体（chinese_*.bin、gbktable.bin）、证书、图标
└── bin/            # cmds 子项目 ELF/SO 产物
```

`Config.sys.DIR_*` 三个配置项只决定 **web 静态路由**与部分模块查找路径的相对起点，均以 FFS 挂载点为根。
