# 显示模块

## 一、屏幕抽象（screen.h / scndrv.c）

统一命令接口 `esp_err_t scn_command(scn_cmd_t cmd, const void *arg)`：

| 命令 | 参数 | 用途 |
| --- | --- | --- |
| `SCN_INIT / SCN_EXIT` | NULL | 由 `drivers.c` 调用的生命周期 |
| `SCN_STAT` | NULL | 打印统计（FPS 等） |
| `SCN_INP` | `hid_report_t *` | 注入 HID 输入（`app hid --to S` / 网络 HID） |
| `SCN_FONT` | `char *path` | 从 `DIR_DATA` 加载 LVGL bin 字体 |
| `SCN_DPI` | `float *` | 鼠标灵敏度 |
| `SCN_ROT` | `int *` | 旋转（LV_DISPLAY_ROTATION_*） |
| `SCN_GAP` | `int *` | 屏幕间隙像素（x=高 8 位, y=低 8 位） |
| `SCN_FPS` | `int *` | 刷新率 0-1000 |
| `SCN_BTN` | `int *` | 虚拟按键 0-6 |
| `SCN_PBAR` | `int *` | 进度条 0-100（OTA/长时间操作） |

后端二选一：**LVGL**（`esp_lvgl_port` + lvgl 组件）或 **u8g2**（v4 + 单色屏，需手动 clone `u8g2` 与 `u8g2-hal-esp-idf`，`WITH_U8G2`）。`scn_initialize()` 由 drivers.c 调用（先于 app_main 的业务模块）。

## 二、LVGL UI（scnlvgl.c）

同时兼容 **LVGL 8 与 9**（文件头一大段 API 别名映射：`lv_obj_delete/lv_obj_del`、`lv_screen_load/lv_scr_load`、`lv_binfont_create/lv_font_load` 等；v9 的 `lv_timer_get_period` 用裸指针偏移 hack）。

### 2.1 Screen 对象模型

```c
struct screen {
    int index;
    lv_obj_t *root;
    screen_cb_t init;    // 可重入的初始化（每次进入都调用）
    screen_cb_t exit;    // 清理 root 之外的额外资源
    screen_cb_t enter;   // 进入后回调
    screen_cb_t leave;   // 离开前回调
    void *user_data;
    const char *name;
};
```

内置屏（`inits[]`）：默认板型为 `menu` / `label` / `anim` 三屏；S3NL191（1.91" 触摸屏板）替换为单屏 `screen_tscn`（触摸交互）。`screen_change(next, anim_ms)`：leave → `lv_screen_load_anim`（向左/向右按 index 前后关系自动选）→ enter → 更新 `ctx.curr`。

### 2.2 输入桥接

三种 LVGL indev（`LV_INDEV_TYPE_POINTER/KEYPAD/ENCODER`）全部由 hidtool 报文驱动：

- `SCN_INP` 收到 `hid_report_t` 后按类型分发：MOUSE/ABMSE → pointer（绝对报文按 `get_hres/vres` 缩放 + `ctx.pointer.scale` 灵敏度）、KEYBD → keypad（映射 lv_key）、SDIAL → encoder（旋转差值驱动 group 聚焦）；
- 物理按键（iot_button）同样映射为虚拟按键（`SCN_BTN`）；
- 触摸屏走 tscn（见 [drivers](drivers)）在 S3NL191 板型接入。

### 2.3 字体级联

`ctx.font` 是一条 `lv_font_t.fallback` 链：自定义加载字体（`SCN_FONT`，`lv_binfont_create` 从文件系统加载 `data/etc/chinese_*.bin`）→ 源内嵌 `scnfont.c`（genfont 裁剪的中文字库）→ `lv_font_unscii_8` → default。用 `lv_theme` 包装（`theme_font`）把链应用到所有控件，`dump_font()` 打印级联树。**加载新字体不重启即可生效**（重建 style/theme）。

### 2.4 调试

`dump_obj()`：递归打印对象树（类型名 + 尺寸 + 位置 + 屏幕标记 `[IDX=x][NAME=..][Current]`，缩进前缀 `>-+*` 取自 0x2500 线框符号区）。`SCN_STAT` 输出 FPS/内存/树。

### 2.5 PC 侧仿真

文件用 `_WIN32` 分支把 LVGL 代码引入 Windows 原生工程（`CreateMutex` 模拟 `ACQUIRE` 宏、fprintf 代替 ESP_LOG），便于桌面端开发 UI 再移植到固件。

## 三、LED 模式（ledmode.c）

基于 `led_indicator` 组件（`CONFIG_BASE_LED_MODE_RMT` 时 RMT RGB；否则默认 GPIO blink 列表）。要点：

- `CONFIG_BASE_LED_NUM` 个 LED，索引从 0；`led_initialize()` 建句柄；
- 内置闪烁序列表 `LED_BLINK_LIST[]`：白呼吸慢/快、蓝呼吸、双红闪、HSV 色环、RGB 色环、流光（SET_IHSV 按 index 流动）——均为 `blink_step_t {type, value, time}` 数组，`LED_BLINK_LOOP` 循环；
- 自定义扩展类型：`LED_BLINK_HSV/HSV_RING/IHSV`（RMT 后端逐帧渐变）；
- `led_command(idx, lum, color, blink)`（`led` 命令）：`-l` 亮度 0-255、`-c 0xRRGGBB`、`-b` 模式号（≥LED_BLINK_RESET 启动、=RESET 停止）；
- OTA/网络等模块用 `led_indicator_start(hdl, LED_BLINK_XXX)` 做状态指示（如固件上传中 1 号灯闪）。
