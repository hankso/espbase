# HTTP 服务器

`server.c` 基于 `esp_http_server`（ESP-IDF httpd）实现，由 `CONFIG_BASE_USE_WEBSERVER` 控制；受 `CONFIG_BASE_USE_WIFI` 约束（`server.c` 整个文件在两者任一缺失时编译为空函数）。监听 80 端口，`httpd_config_t`：栈 8KB、`max_open_sockets=12`、`lru_purge_enable`（满员踢最旧连接）、`enable_so_linger`、`max_uri_handlers` 按注册表长度、全局 wildcard 匹配 `rewrite_api`。

## 一、URI 概览

`rewrite_api` 把所有 `/api/xxx` 前缀剥掉再走通配匹配，因此下表所有路径均可用 `/api/` 前缀访问（前端统一走 `/api/*` 避免 SPA 路由吞掉）。

| URI | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/ws` | GET(握手) + WS | 无 | WebSocket REPL |
| `/alive` | GET | 无 | 健康检查，200 空体 |
| `/exec` | POST | **需要** | REPL over HTTP |
| `/media` | GET/POST | **需要** | 音视频流/配置 |
| `/edit` | GET | AP 限定 | 文件列表/下载/编辑页跳转 |
| `/edit` | PUT/DELETE/POST | AP+鉴权 | 建文件目录/删除/上传 |
| `/config` | GET | AP 限定 | 配置 JSON 导出 |
| `/config` | POST | AP+鉴权 | 配置 JSON 导入 |
| `/update` | GET | AP 限定 | OTA 页面（重定向 `/updation` 或内嵌 basic OTA HTML） |
| `/update` | POST | AP+鉴权 | 上传固件 |
| `/apmode` | GET | AP 限定 | AP 连通性探测 |
| `/data/*` | GET | AP 限定 | `Config.sys.DIR_DATA` 静态目录 |
| `/docs/*` | GET | 无 | `Config.sys.DIR_DOCS` 静态目录 |
| `/*` | GET | 无 | SPA 入口 `Config.sys.DIR_HTML` |

权限模型（`req->user_ctx` 位标志）：

- `FLAG_NEED_AUTH`：Basic/Digest HTTP 认证（见下）；
- `FLAG_AP_ONLY`：release 构建下校验请求 `Host` 头是 `Config.net.AP_HOST`（即 `10.0.2.1`），否则 403——**文件管理、配置写入、OTA 上传只能在 AP 模式做**（Debug 构建不限制）；
- `FLAG_DIR_*`：静态目录选择。

## 二、请求预处理（check_request）

每个 handler 开头 `CHECK_REQUEST(req)`：

1. `Access-Control-Allow-Origin: *`（CORS 全开）；
2. `sess_ctx` 维护参数链表 `http_param_t {key, val, body}`（哨兵节点 + `free_ctx=free_params` 自动释放）：
   - URL query 全量 `url_decode`（`%XX` 与 `+`→空格）后按 `&` 切分，同名 key 覆盖；
   - body 为 `application/x-www-form-urlencoded` 且 ≤2KB 时同样解析（`FROM_BODY` 标记）；
   - `get_param/has_param(req, key, FROM_QUERY|FROM_BODY|FROM_ANY)`；
3. AP_ONLY / NEED_AUTH 校验。

### HTTP 认证

`auth_init()` 预计算（存 `global_user_ctx`）：账号密码来自 `Config.web.HTTP_NAME/PASS`，realm 为 `Config.info.NAME`；Basic 用 `base64(user:pass)`，Digest 预算 `ha1 = md5(user:realm:pass)`。

- 质询：`Basic realm=` 或 `Digest realm=, nonce=md5(host:timestamp), opaque=timestamp, qop=auth, algorithm=MD5`（`AUTH_BASE` 配置二选一）；
- 校验 `auth_validate`：Basic 比对 b64；Digest 要求 10 个字段齐全，重算 `nonce`（**opaque 即签发时间戳，86400 秒（1 天）有效期**）、`ha2=md5(method:uri)`、`response=md5(ha1:nonce:nc:cnonce:auth:ha2)` 全量比对。

401 时附 `Connection: keep-alive` + `WWW-Authenticate`，错误码用自定义 `ESP_ERR_HTTPD_AUTH_DIGEST` 让 httpd 不再吞处理。

## 三、静态文件

- `get_static(path)`：目录自动找 `index.html`；找不到原文件名时**尝试追加 `.gz`**（构建产物是 gzip 预压缩的）。
- `guess_type`：按扩展名映射 mime（html/json/css/xml/ttf/woff/wav/png/gif/jpg/ico/svg/pdf/zip/js），`.gz` 双扩展剥外层取内层类型并回 `application/x-gzip`。
- `send_file`：支持 `If-Modified-Since` → 304；`Last-Modified`/`Content-Disposition`（inline 或 attachment 下载）；`Content-Encoding: gzip`；`Content-Length` + 2KB 分块流式发送（`CHUNK_SIZE=2048`）。
- 404 错误处理器 `on_error`：SPA 存在则回 index（前端路由接管），否则内置 ERROR_HTML。

## 四、REPL 通道

### 4.1 /exec

POST 表单 `cmd=<命令行>`（≤2KB），`console_handle_command(cmd, pipe=true, history=false)` 抓取 stdout 以 `text/plain` 返回。保留 `gcode=` 参数占位（501 未实现）。

### 4.2 /ws（WebSocket）

- 需 IDF `CONFIG_HTTPD_WS_SUPPORT`；GET 握手后每条 TEXT 帧独立处理：payload 首字节 `{` 走 `console_handle_jsonrpc`（JSON-RPC 2.0，见 [console](console)），否则按裸命令行；
- 帧大小上限 `2*CHUNK_SIZE=4KB` 且必须 final 帧；
- 回包 `httpd_ws_send_frame_async`。

## 五、媒体流（/media）

已知限制（源码 FIXME）：video/audio 不能同时推流（各自单例 `http_media_t ctx`）。

- **视频 MJPEG**：GET `?video=mjpg[&still]`。直接用 `httpd_socket_send` 手写 200 响应头 `multipart/x-mixed-replace;boundary=FRAME`，注册 AVC 事件回调；捕获任务每帧经 `httpd_queue_work` → `handle_video_streaming` 发 `--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<data>`；`&still` 只发一帧后 `httpd_sess_trigger_close`；`?video=config` 返回摄像头配置 JSON；POST `?video=<json>` 写配置。
- **音频 WAV**：GET `?audio=wav`，`audio/wav` 无限流（PCM 块直接 socket 写）；启动时若没有捕获任务（`xTaskGetHandle("audio") == NULL`）则 `AUDIO_START(-1)`，断开时 `AUDIO_STOP()`。
- 事件桥 `on_media_data`：sys_evt 任务里收到 capture 队列事件后转投 httpd 工作队列。
- 无参 GET 返回内嵌 MEDIA_HTML 简易测试页（点击图片切换动/静）。

## 六、文件管理（/edit）

- GET：`?path=DIR&list` → `filesys_listdir_json`（文件系统 JSON，含大小/时间）；`?path=FILE[&download]` → send_file；无 path 且 SPA 存在 → 303 重定向 `/editor`（前端路由）。
- PUT `?path=X&type=file|dir`：`ftouch/fmkdir`。
- DELETE `?path=X&type=...&from=url`：`unlink/frmdir`；`from` 存在则 303 回跳。
- POST：`parse_files()` 自研 **multipart/form-data 流式解析器**（CHUNK_SIZE 缓冲 + 状态机 PARSE_BDARY/HEADER/DATA，处理跨块 boundary、`name`/`filename` 提取），`?overwrite` 缺省时同名文件跳过（`ESP_ERR_HTTPD_SKIP_DATA`）；进度实时打 stderr。

## 七、OTA（/update）

- GET：`?raw` 返回内嵌 basic 上传表单，否则 303 到 `/updation`。
- POST 控制参数：`?reset` 清 OTA 状态；`?size=N` 预分配（`ota_updation_begin(size)`，配合前端先 HEAD 探测固件大小）；然后 multipart 上传，字段名必须是 `update`，逐块 `ota_updation_write`，结束时 `ota_updation_end()` + 500ms 延迟重启；期间 LED 闪烁 1 号效果。

## 八、生命周期

- `server_loop_begin/end` 由 app 层在网络就绪/失联时调用（`server_initialize` 只做日志降噪 + begin）；`server_loop_end` 在网络断开时 `httpd_stop` 释放。
- httpd 的 select 驱动模型约束见源码注释：accept → ctrl msg（含 queue_work）→ session handler，**handler 内绝不能死循环**。
