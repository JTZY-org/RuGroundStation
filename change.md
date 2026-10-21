# 变更记录

## 2026-10-20 三套跟踪增益加快

- 平移 `TRACK_PAN_GAIN_CM_S_PER_PX` 改为 0.5 cm/s 每像素，限幅仍是 25 cm/s。
- 后退 `TRACK_RANGE_GAIN_CM_S_PER_PX` 改为 0.5 cm/s 每像素，限幅仍是 25 cm/s。
- 偏航跟踪 `TRACK_YAW_GAIN_DEG_S_PER_PX` 改为 0.6 °/s 每像素，限幅仍是 60 °/s。
- 地面站说明、`run.md`、`docs/CMD31-自动化协议.md` 改成这三组数。
- 已在上锁状态下部署。机端三组增益已是 0.6 / 0.5 / 0.5，新进程 `init()` 成功，状态为 `LOCKED (DISARMED)`。这次电调初始化是 `ESCControllerIniting ......DONE`。

## 2026-10-20 后退模式，偏航和平移共用

- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`、`protocol.py`：新增 `D4 01` / `D4 00`。按下时记住行人框等效边长。框变大写负 X 后退，框变小写正 X 前进。偏航跟踪写成 `set_speed(x, 0, 0, yaw)`，平移跟踪写成 `set_speed(x, y, z, 0)`。回传 `0xFD 0x03`。
- `src/components/MspDashboard.jsx`、`mspProtocol.js`：单独的「后退模式」按钮，偏航跟踪和平移跟踪共用。
- `docs/CMD31-自动化协议.md`、`run.md`：写明包格式和轴符号。头文件未定义 X 方向，沿用地面站 +X 前进、−X 后退。
- 已在上锁状态下部署。机端 `protocol.py` 含 `RANGE_HOLD = 0xD4`，新进程 `init()` 成功，状态为 `LOCKED (DISARMED)`。这次电调初始化仍是 `ESCControllerIniting ......ERROR`。

## 2026-10-20 平移跟踪增益改为 0.25

- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`：`TRACK_PAN_GAIN_CM_S_PER_PX` 从 0.15 改为 0.25 cm/s 每像素。死区仍是 24 像素，限幅仍是 25 cm/s。
- `src/components/MspDashboard.jsx`、`run.md`、`docs/CMD31-自动化协议.md`：说明改成 0.25。
- 已在上锁状态下部署到飞机。`/etc/rknn/user_app.py` 的 `TRACK_PAN_GAIN_CM_S_PER_PX = 0.25`，新进程 `init()` 成功，状态为 `LOCKED (DISARMED)`。这次日志里电调初始化是 `ESCControllerIniting ......ERROR`。

## 2026-10-20 画面框只保留当前模型的一套

- `src/components/VideoPlayer.jsx`：浏览器「框人」关闭时只画机端检测框。打开后只画浏览器模型的框，机端框不再叠上去。
- `run.md`：写明两套框互斥，以及从「框人」回到机端框的切换。

## 2026-10-19 实机跟踪去掉固定自动化

- `src/components/MspDashboard.jsx`：去掉「固定自动化」按钮。这一块改成偏航跟踪。`fixedBoxMode` 固定为 false，位移、高度、降落、云台不再被这个模式锁住。
- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`：`E0` 只记日志，不进入固定自动化，1000→1200 油门斜坡不会启动。
- `docs/CMD31-自动化协议.md`、`run.md`：写明当前实机跟踪没有这个模式。平移跟踪仍是原来的解锁起飞后发 `D3 01`。
- 已在上锁状态下部署。机端 `user_app.py` 含「E0 不进模式」，新进程 `init()` 成功，状态为 `LOCKED (DISARMED)`。电调初始化完成。

## 2026-10-19 撤回自定义油门，实机跟踪不走固定模式

- 地面站去掉「自定义油门」输入。固定自动化恢复为恰好 2 字节的 `E0 01` / `E0 00`。
- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`：去掉 4 字节油门包和从 0 起步。油门斜坡只在固定自动化打开后才从 1000 收到 1200，上限 1250。没开这个模式时不跑。
- 实机平移跟踪仍是 `D3 01`，走原来的解锁起飞，不进固定自动化。
- 已在上锁状态下部署到飞机。机端 `/etc/rknn/user_app.py` 的 `FIXED_THROTTLE_FROM` 恢复为 1000，进程已重启并打印 `LOCKED (DISARMED)`。

## 2026-10-19 固定自动化油门从 0 起步

- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`：解锁后的油门斜坡起点从 1000 改成 0，上锁也收回 0。终点仍是解锁前设的值，限制在 500–1250。斜坡过程中的 PWM 不再被 500 下限抬高。
- `src/components/MspDashboard.jsx`、`docs/CMD31-自动化协议.md`、`run.md`：说明改成从 0 收到目标。
- 已部署到 `root@192.168.222.1` 并重启 `aps`。飞机上 `FIXED_THROTTLE_FROM = 0`，新进程 `init()` 成功，状态为上锁。

## 2026-10-19 固定自动化油门可在解锁前设置

- `src/components/MspDashboard.jsx`：固定自动化里增加油门输入和「自定义油门」。顺序是先 `E0 01` 进入，再发 4 字节 `E0 01` + PWM，最后解锁。
- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`、`protocol.py`：2 字节 `E0 01` 只进模式并把目标放回 1200。4 字节包在模式已开时记住 500–1250 的目标。解锁后 3 秒从 1000 斜坡到这个值。模式没开时丢掉油门包。
- `docs/CMD31-自动化协议.md`、`run.md`：写明这两步和包长。

## 2026-10-19 飞行平移跟踪

- `RuAPS-Extracustom-rk3566NPU/python/protocol.py`：增加 `0xD3`，恰好 2 字节。`D3 01` 开始平移跟踪，`D3 00` 停止。
- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`：平移跟踪按行人框偏差写 `APMControllerSpeed` 的 y、z，x 和偏航为 0。增益 0.15 cm/s 每像素，限幅 25 cm/s，死区 24 像素。和 `D1 01` 偏航跟踪互斥。固定自动化、降落、上锁会关掉它。回传 17 字节 `0xFD 0x02`。
- `src/utils/mspProtocol.js`、`src/components/MspDashboard.jsx`、`MspDashboard.css`：地面站增加「AI 飞行跟踪」。开始/停止按钮和左右、上下、偏差、下发速度。
- `docs/CMD31-自动化协议.md`、`run.md`：写明 `0xD3` 和 `0xFD 0x02`。
- 已用 WSL 打包安装到 `root@192.168.222.1` 并重启 tmux 会话 `aps`。飞机上 `/etc/rknn/user_app.py` 含 `TRACK_PAN_Y_SIGN = -1`，`protocol.py` 含 `FLIGHT_FOLLOW = 0xD3`。新进程 `init()` 成功，状态为上锁。

## 2026-10-19 固定自动化单独成块

- `src/components/MspDashboard.jsx`、`MspDashboard.css`：固定自动化从「自动化动作」里拆出来，单独一块。开始跟踪、停止跟踪和转向回传放到这块里。飞控组只留解锁、上锁、降落、取消降落。

## 2026-10-19 固定自动化模式

- `src/components/MspDashboard.jsx`、`MspDashboard.css`：增加「固定自动化」。发送 `E0 01` / `E0 00`。打开后禁用降落、水平位移、高度、云台、快捷指令和手动 CMD 31，保留解锁、上锁和跟踪。
- `RuAPS-Extracustom-rk3566NPU/python/user_app.py`：同样丢掉这些包。解锁后 3 秒把油门从 1000 收到 1200，上限 1250。`FIXED_MOTOR_PINS` 为空时不写 `set_servo`。跟踪增益改为 0.35 °/s 每像素，限幅 60 °/s。偏航累计超过 ±178° 后不再往外转。
- `python/protocol.py`、`docs/CMD31-自动化协议.md`、`run.md`：写明 `0xE0`。

## 2026-10-19 跟踪下发显示偏航速率

- `src/components/MspDashboard.jsx`：跟踪回包 `axis == 2` 时，下发一行显示「偏航 ±N °/s」。`axis` 0/1 仍显示 x/y 的 cm/s。bit2 为 0 仍是「未下发」。
- `src/utils/mspProtocol.js`、`docs/CMD31-自动化协议.md`、`run.md`：写明 speed 字段在 axis 2 时单位是 deg/s。

## 2026-10-19 视频只画人框

- `src/components/VideoPlayer.jsx`：机端 YOLO 叠加默认只画 `class_id === 0`（person）。Class 56 这类椅子框不再进缓存，绘制循环里也会清掉。全类别按钮还在，点开才恢复。

## 2026-10-19 网页框人

- 视频栏增加「框人」。打开后在浏览器加载 `public/models/person_detect.tflite`，对当前 WebRTC 画面做人物检测并画绿框。
- 推理在 `src/vision/personBoxMode.js`，运行时用 LiteRT.wasm。wasm 由 Vite 从 `@litertjs/core` 复制到 `public/litert/`。
- 修正框人：模型是 192×192 的检测后处理输出（ymin/xmin/ymax/xmax），按张量形状解析。LiteRT.wasm 跑这个后处理算子会内存越界，推理改走 `@tensorflow/tfjs-tflite`。视频 CSS 旋转 180° 时，先把正向画面送给模型，再画到未旋转的叠加层上。

## 2026-10-17 跟踪判断显示

- 机端 `PersonTracker` 在下发速度后回传 11 字节 `0xFD 0x01`（转向、速度、像素偏差、画面宽、是否已调用速度接口）。
- `src/utils/mspProtocol.js` 解析该包。`MspDashboard.jsx` 在开始跟踪旁显示转向、画面偏差角和下发速度。角度按半幅 90° 换算，不是航向指令。

## 2026-10-17

- `src/components/MspDashboard.jsx`：飞控组增加「开始跟踪」「停止跟踪」，载荷为恰好 2 字节的 `D1 01` / `D1 00`。只有发送成功才点亮开始跟踪；降落发送成功时清掉高亮。
- `src/components/MspDashboard.css`：跟踪按钮样式。
- `docs/CMD31-自动化协议.md`、`run.md`：写明 2 字节跟踪与 5 字节水平位移都用 `0xD1`，靠包长区分。

## 2026-10-11

- 执行 `npm run build`（Vite + singlefile），产物：`dist/index.html`（约 252.75 kB / gzip 77.61 kB）。
- 未改业务源码；从 `src/components/MspDashboard.jsx`、`src/utils/mspProtocol.js` 梳理图中自动化按钮的 CMD 31 内容协议（payload 字节）。
- 新增独立协议文档：`docs/CMD31-自动化协议.md`（MSP 外层帧 + CC/B0/D1/D2/0xFB 内容字节与示例整帧）。
