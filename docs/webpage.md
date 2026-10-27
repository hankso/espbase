# 网页前端

Vue 3 SPA，构建产物直接进入固件文件系统（`data/www`，gzip 预压缩），由固件 `/` 路由托管；也支持 PC 侧 `pnpm dev` 联调（代理到 `helper.py serve` 假服务器）。

## 一、工程配置

### 1.1 package.json

- 名称 `ESP Base`；`type: module`；
- 脚本：`dev` / `build` / `preview`；`docs:dev|build|preview`（VitePress，对应 `web/docs/`）；`lint`（ESLint + vue 插件 + prettier 集成）；`format`；
- 运行时依赖：vue 3.4、vue-router 4、vuetify 3、@vueuse/core、axios、ajv(+formats)、codejar(+linenumbers 行号编辑器)、prismjs、simple-keyboard（软键盘）、vue-web-terminal 3、path-browserify；
- 格式化约定：无分号、4 空格、单引号、CRLF、箭头单参去括号、尾逗号 es5。

### 1.2 vite.config.js

按 `command/mode` 生成配置，要点：

- **构建产物目录**：`../data/www`（存在时）否则 `./dist/www`——**前端 build 直接写入固件文件系统镜像源**，配合 prebuild 的 mtime 检测（[build](build)）；
- `define: process.env`：注入 `PROJECT_VERSION/PROJECT_NAME`（取自 npm 包字段）、`API_SERVER`（5172）、`BUILD_INFO`（NODE_JS/BUILD_OS/BUILD_TIME，build 时尝试读取 git 提交哈希进 SOURCE）、`VITE_PATH/VITE_CMD`；
- dev server：0.0.0.0:5173，`/api` 代理到 `http://localhost:5172`（sport），`sport` 同时传给 vite-python 插件；
- 插件：
    + `@vitejs/plugin-vue`（transformAssetUrls 扩展）
    + `vite-plugin-vuetify`（按需样式）
    + `vite-plugin-prismjs`（markup/json/css/js/clike 语言 + previewers/autolinker/inline-color/show-invisibles）
    + `unplugin-auto-import`（vue/vue-router/vue-i18n API 全局自动引入——源码里大量 `ref/watch/provide` 不需要 import 的原因）
    + `unplugin-vue-components`（组件自动注册）
    + `vite-plugin-compression2`（**deleteOriginalAssets: true，只留 .gz/.br**，固件端 404 时补 .gz/.br 的约定即源于此）
    + `rollup-plugin-visualizer`（treemap + gzip/brotli 体积分析
    + `vue-devtools`
    + `pythonServer`（dev 时以子进程方式跑 `helper.py serve`，前端无需手动起 Python 服务）
- 路由级代码分割：每个 Tab 页面独立 chunk 惰性加载（router.js 注释）。

## 二、应用骨架

- `main.js`：`createApp(App).use(router).use(vuetify).use(createTerminal()).mount('#app')`；
- `App.vue`：
  - 侧边导航按 **AP/STA 模式分组**：`isAPmode()`（调 `/api/apmode`）成功才显示 AP 区（File Manager / Editor / Configs / OTA / About）；STA 区始终显示（Home 控制台 / Gamepad / Socket / Stream）；
  - 全局 provide：`notify`（snackbar）、`confirm`（红字警告对话框）、`progbar`（顶部加载条）、`theme`（dark/light 切换 + 持久化 via useDark）、`fullscreen`；
  - `?to=` 查询参数重定向（从固件 303 到 SPA 内路由）。

## 三、路由（router.js）

文件名约定式自动路由：`import.meta.glob('@/views/Tab*.vue')` / `App*.vue`，`routePages` 把文件名剥掉前缀后小写为路径（`TabFileman.vue` → `/fileman`）。全部分类页挂在 `/` 下；`/redirect/:url?` 处理固件端 303（支持 path/query/hash 三种目标）；未匹配路径一律重定向 `/notfound`（带 reason）。

| 路由 | 视图 | 功能 |
| --- | --- | --- |
| /home | TabHome | Web Console：`vue-web-terminal` 本地终端 + 命令补全 |
| /gamepad | TabGamepad | 虚拟手柄/键鼠（HID 报文经 WebSocket 下发） |
| /socket | TabSocket | WebSocket 直连 REPL（JSON-RPC） |
| /stream | TabStream + MediaStream | MJPEG/WAV 流播放 |
| /fileman | TabFileman | 文件管理（TreeView + 上传下载） |
| /editor | TabEditor | CodeJar 在线编辑器（SchemaEditor 辅助） |
| /configs | TabConfigs | SchemaForm 驱动的配置页 |
| /updation | TabUpdation | OTA 上传（先 `?size=` 探测再传） |
| /about | TabAbout / Info* | 版本信息 |
| /serial | TabSerial | WebSerial 浏览器直连串口（chrome 实验特性） |
| /notfound | TabNotfound | 404 |

## 四、API 层（apis.js）

axios 实例 `baseURL: '/api/'`、默认 5s 超时。函数与固件 REST 一一对应（见 [server](server)）：

| 函数 | 请求 |
| --- | --- |
| `getSchema(name)` | `/{name.}schema.json`（public/ 静态文件） |
| `isAPmode()` | GET apmode |
| `getConfig/setConfig(cfg)` | GET/POST config（POST body `json={...}` 表单） |
| `getMedia/setCamera(cfg)` | GET media 探测 + POST `video=<json>` |
| `listDir/readFile/download/createPath/deletePath/uploadFile` | /edit GET/PUT/DELETE/POST（上传统一 `toFormData`：string 自动 gzip——与固件 .gz 回落呼应；object 转 JSON Blob） |
| `updateOTA(firmware)` | POST /update multipart 字段 `update` |
| `execCommand(cmd)` | POST exec `cmd=...`（array/object 拼接成命令行） |
| `getCommands()` | `execCommand('help')` 输出按双换行切段，`parseCommand` 解析 argtable3 帮助格式（usage/description/example）成终端补全数据源 |

`execCommand` 里的 `'helpe' ↔ 'help'` 替换是配合 terminal 内建 help 命令避免重名的小 hack。

## 五、Schema 表单体系（plugins/ajv.js + Schema* 组件）

- `ajv` 实例开 `allErrors`，加 `ajv-formats`（ipv4 格式校验依赖它）；
- `SchemaForm` 读 `config.schema.json`（draft-07），按条目类型渲染 `SchemaString/Number/Boolean/Select/EInput`（枚举 IP 输入等），修改后 `setConfig` 提交平铺键值；`SchemaEditor` 组合编辑器；
- 校验失败信息直接来自 ajv（与 config.h 注释同步维护，见 [config](config) 第七节）。

## 六、通信工具

- **serial.js**：`SerialController` 封装 Web Serial API——端口枚举（VID:PID hex）、`OptionSchema`（JSON Schema 驱动的波特率/数据位/校验/流控表单，9600~921600）、TextEncoder/Decoder 行缓冲；不支持时给出各浏览器开关提示。用于脱离网络直连板子 REPL（`/serial` 页）。
- **timesync.js**：`TimeSyncClient` 实现固件 `net tsync` 同款 TimeSync 协议（`timeinit`(t1) → `timesync`(t2 回) → `timedone`(t3+t4, offset)，double 小端打包，monotonic 时钟）；`xsync(n)` 多次采样取平均消抖；recv/send 注入式设计（WebSocket/WebSerial 均可挂）。
- **looptask.js**：轮询循环任务工具（页面卸载自动停止）。
- **strftime.js / cvtcase.js / ipregex.js**：时间格式化（ls 输出同款）、camel/snake 键名转换（schema ↔ 平铺键）、IPv4/网段正则。

## 七、输入外设组件

- `GamePad.vue`：Vuetify 布局的虚拟手柄（双摇杆、十字键、16 键），输出 `hid_gmpad_data_t` 同构 JSON；
- `TouchPad.vue`：触摸板/鼠标手势转 HID 鼠标报文；
- `SurfaceDial.vue`：Surface Dial 旋钮控件；
- `KeyBoard.vue`：simple-keyboard 软键盘 → HID 按键序列；
- 以上报文经 WebSocket 以 JSON-RPC 或裸 `app hid` 命令下发（见 [console](console) / [hidtool](hidtool) 的路由路径）。

## 八、与固件的联调方式

1. `pnpm dev`：vite-python 自动起 `helper.py serve`（5172），浏览器 5173，`/api` 代理；无硬件时由 Python 假服务器提供全部 API（MJPEG 随机帧、假配置、文件系统沙箱）；
2. 有硬件：`helper.py serve --esphost <设备IP>` 或直接访问 `http://<设备IP>`（SPA 由固件托管，前端仅静态资源在设备上）；
3. 构建进固件：`pnpm build`（或直接 `idf.py build`，prebuild 检测变更自动执行）→ `data/www` → 随 storage 分区镜像烧写。
