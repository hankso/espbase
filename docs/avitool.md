# 音视频与二维码

`avitool.h` 中 `CONFIG_BASE_USE_AVC` = 摄像头（esp32-camera）或 I2S 麦克风任一启用。`avi_initialize()` 由 drivers.c 调用。

## 一、事件驱动的采集模型

采集数据通过默认事件循环的 `AVC_EVENT` 广播（`AUD_EVENT_START/DATA/STOP`、`VID_EVENT_START/DATA/STOP`）。**为避免 esp_event_post 拷贝整个数据结构，事件 payload 传的是 `audio_data_t* / video_data_t*` 的二级指针**（`AVC_POST` 宏）；消费者（server 的流式发送、文件落盘）拿到 `pkt->data/len/id`。`START` 事件 data 是完整文件头（WAV/AVI header），`STOP` 时 data/len 置空。

控制入口统一为 `avi_command(int tgt, const char *ctrl, uint32_t tout_ms, void *ptr)`，`tgt` 位掩码 `AUDIO_TARGET|VIDEO_TARGET|IMAGE_TARGET`；头文件提供全套语义宏（`AUDIO_START(ms)`、`CAMERA_FETCH(&event)` 等）。

## 二、文件格式（纯手工二进制头）

- **WAV**：`wav_header_t`（44B，PACKED 字段直接写出）——I2S PDM 单声道，采样率/位宽来自 `audio_mode_t {srate, nch, bpc}`。
- **AVI**：`avi_header_t`（RIFF/AVI 三层 LIST：`avih` 56B + `strl` 116B，flags `0x110 = HAS_INDEX|IS_INTERLEAVED`）+ 每帧 `avi_chunk_t {ckid("00dc" mjpg / "01db" rgb / "02wb" wav), dlen}` + 结尾 `avi_tailer_t idx1` 索引（单视频流，KEYFRAME 标志）。视频模式 `video_mode_t {fps, width, height, bpp, fourcc}`（MJPG 或 RGB）。
- **BMP**：`bmp_header_t`（14+40B）——二维码/截图落盘。

录制流程：采集任务写文件时按帧追加 `avi_chunk_t`，停止时 seek 回头补 `idx1` 索引与总帧数——产物是标准可播 AVI。`app avc ... -o PATH` 指定输出文件（默认在 data 分区）。

## 三、摄像头

- 引脚组来自板型（`BASE_CAM_PINS`，Kconfig 按板 select 对应 `CAM_PIN_*` 集合）；
- 帧格式：`PIXFORMAT_JPEG`（网络流）或 `RGB565`（屏显），`fb_count`/PSRAM 依 `CONFIG_BASE_CAM_PSRAM`；
- 配置读写 `CAMERA_LOADS/CAMERA_DUMPS`（JSON）：`app avc cam <json>` 直接改 sensor 设置（分辨率/翻转/特效/曝光/AWB 等），`app avc cam print` 打 JSON；
- 单帧获取 `CAMERA_FETCH(e)`（阻塞队列收一帧，事件回调里也能拿）与 `CAMERA_YIELD`（归还帧缓冲）——心跳上传（[network](network)）、二维码解码、`?video=still` 都基于它。

## 四、流式分发

- **MJPEG**：server.c 注册 `AVC_EVENT` 回调（`on_media_data`，在 sys_evt 任务收队再 `httpd_queue_work` 转投 httpd 线程，见 [server](server)），每帧封 `--FRAME` multipart 块；`vid_event` 序号 `pkt.id` 供客户端检测断帧。
- **WAV 流**：`AUD_EVENT_START` 先发 44B 头，后续 DATA 直接 socket 写。
- 心跳的 image 周期上传复用 `CAMERA_FETCH`。

## 五、二维码

### 5.1 生成（qrenc，espressif/qrcode + 自带 qrcodegen）

`avi_qrenc(qrenc_config_t *)`：flags 位控制输出形态——`BIN/BMP/SVG` 落盘格式、`FULL/MINI/DOTS` 终端字符风格（2x 块/半块/盲文点阵 U+2800）、`ANSI` 彩虹色、`INV` 反色；`max` 版本 1~40、`ecl` 纠错级别 L/M/Q/H、`bdr` 静区边框。DPP 配网（[network](network)）就用反色 + 终端打印。

### 5.2 识别（qrdec，quirc）

`avi_qrdec(video_data_t *)`：`CAMERA_FETCH` 抓一帧灰度图 → `quirc_begin/feed/end/decode` → 解码成功打印 payload 与格式（文字直接输出，URL 提示扫码进入）；`app qrc dec` 命令封装。**识别环路与生成共用同一命令族**（`app qrc enc|dec`）。
