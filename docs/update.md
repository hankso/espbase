# 差分升级

`update.c` 由 `CONFIG_BASE_USE_UPDATE` 控制，提供 HTTP 上传 OTA、URL 拉取 OTA、**差分（delta）补丁 OTA** 三种升级方式，外加心跳上报（在 [network](network) 已述，代码同在本文件）。

## 一、OTA 上下文

```c
static struct {
    const esp_partition_t * running, * target;   // 当前运行分区 / 升级目标分区
    esp_ota_handle_t handle;                     // esp_ota_begin 句柄
    size_t saved, total, percent;                // 已写字节 / 分区大小 / 进度百分比
    void *delta;                                 // WITH_DELTA 时 esp_delta_ota 句柄
    bool check;                                  // 头部校验已通过
    esp_err_t error;
} ctx;
```

`update_initialize()`（app_main 阶段 2 末尾）：running = 当前分区；target = 最后一个 invalid 分区，否则下一个更新分区；`CONFIG_APP_ROLLBACK_ENABLE` 时检查 pending-verify 状态（新固件首启需主动确认，见下文 rollback）。

## 二、写入流水线（ota_updation_write）

接受任意来源（HTTP /update 上传、URL 拉取）的固件流，**首包做双格式探测**：

1. **全量镜像**（`header_normal_t` = esp_image_header + segment header + app_desc，PACKED 64B）：
   - `chip_id != CONFIG_IDF_FIRMWARE_CHIP_ID` → 拒绝；
   - 与 running / target 分区的 `version + date + time` 都相同 → `ESP_ERR_INVALID_STATE`（重复下载跳过）；
   - 通过后 `esp_ota_begin` 逐块写入。
2. **差分补丁**（`header_patched_t`，见 [build](build) 的 64B 结构）：
   - `WITH_DELTA`（`CONFIG_BASE_OTA_DELTA`，依赖 `esp_delta_ota` 组件 + detools）：
     - `verify_patched`：头中 32B sha256 必须等于**当前运行分区的 sha256**（补丁只能打在它指定的基线上）；
     - `esp_delta_ota_init(handle, delta_read, delta_write)`：读取侧直接 `esp_partition_read(running, offset)` 从当前固件取旧数据；写入侧回调 `delta_write` 先自行解析出 esp_image_header 校验 chip_id，再 `esp_ota_write`——最终把重构出的新固件写入 OTA 分区；
     - 结束时 `esp_delta_ota_finalize/deinit`。
   - 未开 delta 编译时报 `Patched firmware is not supported`。

`ota_updation_end()`：`esp_ota_end` + 设 boot 分区为 target（差分路径在 finalize 内已写完整镜像）；上传过程中 LED 闪烁、进度百分比实时打 stderr。

## 三、升级入口

| API | 说明 |
| --- | --- |
| `ota_updation_begin(size)` | 预擦除；size == 分区大小时减 1（esp_ota_begin 会按 `(size/sector+1)*sector` 擦除）或用 `OTA_SIZE_UNKNOWN` |
| `ota_updation_write/end` | 喂数据 / 收尾并切换启动 |
| `ota_updation_url(url)` | `CONFIG_BASE_OTA_FETCH` 时用 esp_http_client 流式拉取 `Config.app.OTA_URL` 或显式 URL，内部仍走 write 流水线 |
| `ota_updation_boot(label)` | 仅切 boot 分区（如回滚到 silver0） |
| `ota_updation_reset / error / info` | 重置上下文 / 最近错误 / 打印全部分区表 |

`ota_updation_info()` 输出格式：`State Label Offset Size IDF SHA256[:8] Version Build time`，状态机为 `New/Pending/Valid/Invalid/Aborted/Running/OTANext`。

## 四、Rollback 与自动确认

分区表采用双 silver 槽（ota_0/ota_1，见 [build](build)）。启用 `CONFIG_APP_ROLLBACK_ENABLE` 后：

- 新固件首次启动处于 `ESP_OTA_IMG_PENDING_VERIFY`；
- `update_initialize` 里检测到 pending 状态会启动守护（心跳/网络正常即标记 valid，超时未确认则下次启动回滚旧分区）；
- `update` 命令的 `boot <label>` 可手动切槽。

## 五、HTTP 侧对接

- `/update` POST multipart：前端先 `?size=N` 预擦除再流式上传，字段名 `update`；
- `app update fetch [-u URL]` → `ota_updation_url`；
- 差分发布流：`helper.py postbuild` 在 PC 产出 `espbase-{old8}-{new8}.bin` 补丁并改写备份镜像名；OTA 服务器按请求版本哈希返回全量或补丁，设备端 `verify_patched` 保证基线匹配后才套用。
