# 驱动与传感器

## 一、底层驱动（drivers.c + drivers.h）

`drivers.h` 用 Kconfig + 板型宏生成**引脚常量表**：每类外设的 `PIN_XXX` 都先按 `CONFIG_BASE_BOARD_*` 特判（如 S3ECAM 板 SPI 硬编码 5/6/7、LED=21），否则回落 `CONFIG_BASE_GPIO_*` 自定义值。板型选择在 `main/Kconfig.projbuild` 的 "Project Config" 菜单。

`driver_initialize()`（app_main 第一步之后）按 `CONFIG_BASE_USE_*` 依次初始化：

| 外设 | 组件 | 说明 |
| --- | --- | --- |
| Button | `espressif/button` | `CONFIG_BASE_BTN_INPUT`（GPIO0 类物理按键）、`CONFIG_BASE_BTN_POWER`（PWR 唤醒键）；按下/释放/连按回调 → hidtool 虚拟手柄键 |
| Knob | `espressif/knob` | EC11 旋转编码器 A/B 相 |
| TouchPad | `espressif/touch_element` | 电容触摸板（`tpad_read` 返回触点值） |
| LED | 见 [display](display) | `led_initialize` |
| UART | IDF uart 驱动 | `NUM_UART/PIN_TXD/RXD`，8N1 |
| I2C | v4 `driver/i2c.h` / v5 `i2c_master` | `NUM_I2C`（0/1），`Config.sys.INT_EDGE` 可调中断沿 |
| SPI | spi_master | `NUM_SPI`，与以太网共享时避让（见 [network](network)） |
| I2S | v4 `driver/i2s.h` / v5 `i2s_pdm` | MIC/PDM 采集（avitool 音频源） |
| ADC | oneshot/连续 | 最多 3 通道（摇杆 X/Y + 通用）、霍尔（esp32 专用 36/39） |
| DAC | oneshot/CW | 2 通道；`dac_output_t` 打包 freq/phase/scale |
| PWM (LEDC) | ledc | 舵机（H/V 双轴 `pwm_set_degree` 0-180°）+ 蜂鸣器（`pwm_set_tone` 130Hz~55kHz） |
| Screen | scn_command | 见 [display](display) |

### 1.1 GPIO 使用登记

`gpio_usage(pin, usage)`：返回当前用途名；传入非 NULL 新用途时若已占用返回旧值（调用方据此判断冲突），否则登记。所有模块占用 GPIO 前登记，避免板级复用冲突。

### 1.2 SMBus 与寄存器表引擎

I2C 之上封装 SMBus 风格 API（`smbus_read/write_byte/word`、`clrbits/setbits/toggle`、`i2c_wtrd` 写后读、`i2c_detect` 总线扫描）。

**寄存器表 DSL**（`smbus_regval_t {reg, val}`，高 16 位 reg 字段是操作码）：

```c
RT_WBYTE(r, v)   // 写字节        RT_RBYTE(r)      // 读字节
RT_WWORD(r, v)   // 写 16 位      RT_RWORD(r)      // 读 16 位
RT_CBITS(r, m) / RT_SBITS(r, m) / RT_TOGGLE(r, b)      // 位操作
RT_WAIT0/1/2(r, m, ms)   // 等待位域清零/任一置位/全部置位（超时 ms）
RT_SLEEP(ms)             // 延时
RT_FIND_OPT / RT_FIND_REG // 表内查找
```

`smbus_regtable(bus, addr, table, len)` 按顺序执行整张表——新传感器的 bring-up 只需一张表。`smbus_detect(bus, smbus_device_t{addr,init}, n)` 探测并调用匹配设备的 init。

### 1.3 GPIO 扩展器（gexp）

虚拟引脚号 `PIN_I2C_BASE~PIN_I2C_MAX`（PCF8574，I2C）与 `PIN_SPI_BASE~PIN_SPI_MAX`（级联 74HC595，SPI），语义枚举面向 CNC/3D 打印机场景（限位开关 XMIN/XMAX、热床/喷头温度、电磁阀 VLV1-8、步进电机 DIR/STEP/EN）。`gexp_set/get_level` 对上层完全透明——`gpio` 命令可直接读写扩展器引脚。**注意枚举的逆序基址设计**（`PIN_I2C_MIN = GPIO_PIN_COUNT - 1` 向下生长），保证未启用的板型常量仍编译通过。

## 二、传感器（sensors.c / sensors.h）

`sensors_initialize()`（`CONFIG_BASE_USE_SENSORS`）注册各 I2C 传感器（内部多用 1.2 的 regtable 引导）：

| API | 硬件 | 输出 |
| --- | --- | --- |
| `temp_celsius()` | 片上 temperature sensor | 摄氏度 |
| `tscn_read / tscn_command / mscn_status` | 电容触摸屏控制器 / IST3931 手势控制器 | `tscn_data_t`：手势（滑动四向/捏合）、最多 16 指坐标（像素 + 万分比）、压力/面积；`apply=true` 时套用屏幕旋转；`tscn_command("start|stop|stat")` 控制后台任务；数据投给 LVGL 指针 indev |
| `vlx_read()` | VL53L0X 激光测距 | 毫米 |
| `gy39_read()` | GY39 四合一 | 照度 lux / 温度 ℃ / 气压 Pa / 湿度 0-1 / 海拔 m（UART 协议帧解析） |
| `als_brightness(idx)` / `als_tracking()` | 环境光传感器阵列（最多 4 路） | 追踪模式：单路/双路 H+V/四路，输出舵机 H/V 角度（光追云台，联动 `pwm_set_degree`） |
| `pwr_status()` | BQ25895 充电管理 | 电池/充电状态（打印电流/电压/温度等寄存器解读） |

`app sen` 命令把以上传感器做成统一轮询接口（`-i` 间隔、`-t` 总时长，见 [console](console) ）。
