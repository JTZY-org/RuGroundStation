# 运行与协议说明

完整 CMD 31 内容协议（独立文档）：[`docs/CMD31-自动化协议.md`](docs/CMD31-自动化协议.md)

## 打包 / 预览

1. 开发：`npm run dev` → Vite 开发服务器
2. 打包：`npm run build` → 单文件产物 `dist/index.html`
3. 预览产物：`npm run preview`

## 网页框人

```
视频栏「框人」（VideoPlayer.jsx）
  → ensurePersonModel()
  → loadLiteRt(public/litert) + loadAndCompile(public/models/person_detect.tflite)
  → 每 250ms 从 <video> 取一帧
  → detectPersons() 只保留 person
  → 画布绿框
```

模型文件与手机端相同：`public/models/person_detect.tflite`、`public/models/labelmap.txt`。输入是 192×192 uint8。输出是检测框（ymin、xmin、ymax、xmax），不是原始 YOLO 网格。浏览器运行时用 `@tensorflow/tfjs-tflite`，wasm 在 `public/tflite/`。视频默认 CSS 旋转 180°，推理前先转成正向，框画在未旋转的叠加层上。没开视频时只加载模型，不开画框。

同一时间只画一套框。没开「框人」时，`VideoPlayer` 只画机端 `0xFE` 框。开了「框人」后只画浏览器框，机端框仍收进缓存但不再描出来。关掉「框人」再回到机端框。`personOnly` 默认打开：`MspDashboard` 把 CMD 31 的 `0xFE` 框交给 `VideoPlayer`，缓存和绘制都丢掉 `classId !== 0`。点「全类别」才把椅子等其它类画出来。网页「框人」本身就只出人。

## 按钮 → 发送链路

```
UI 按钮（MspDashboard.jsx）
  → build*Payload() 组装 CMD31 内容字节
  → sendCmd31Payload(payload, label)
  → sendCommand(31, payload)
  → createMSPFrame(31, payload)   // mspProtocol.js
  → WebSocket ws://{deviceIp}:27015 发送整帧
```

诊断日志：`linshi/button-actions.log`（及 `button-actions.ndjson`，由 Vite 插件写入）。

## 外层 MSP 帧（所有自动化共用）

| 字段 | 字节 | 说明 |
|------|------|------|
| Header | `24 4D 3C` | `$M<` 请求 |
| Size | 1B | payload 长度 |
| Cmd | `1F` | CMD 31 = `MSP_RU_CUSTOM_MESSAGE` |
| Payload | N B | 下表「内容协议」 |
| Checksum | 1B | `size XOR cmd XOR payload…` |

## 内容协议（CMD 31 payload）

定义位置：`src/components/MspDashboard.jsx` 顶部 `build*` 函数。

| UI | Payload（hex） | 结构 |
|----|----------------|------|
| 解锁 | `CC 01` | `0xCC` + action(1=arm) |
| 上锁 | `CC 00` | `0xCC` + action(0=disarm) |
| 降落 | `B0 01` | `0xB0` + action(1=start) |
| 取消降落 | `B0 00` | `0xB0` + action(0=cancel) |
| 开始跟踪 | `D1 01` | 恰好 2 字节；机端开偏航跟踪 |
| 停止跟踪 | `D1 00` | 恰好 2 字节；机端关偏航跟踪 |
| 开始平移跟踪 | `D3 01` | 恰好 2 字节；机端按画面偏差平移 |
| 停止平移跟踪 | `D3 00` | 恰好 2 字节；机端关平移跟踪并清速度 |
| 水平位移 | `D1` + x_cm(i16 LE) + y_cm(i16 LE) | 恰好 5 字节，机体系 cm |
| 垂直高度 | `D2` + alt_cm(i16 LE) | 目标高度 cm |
| 云台+激光 | `00 FB` + servo(u16 LE) + laser(u16 LE) | PWM μs；激光关=1000 / 开=2000 |

UI 约定（飞测待确认，非 PLGUserDefine 明文）：`+X` 前进、`−X` 后退、`+Y` 左移、`−Y` 右移。

## 人物跟踪按钮

```
开始跟踪 / 停止跟踪（MspDashboard.jsx）
  → buildTrackPayload(true|false)     // [0xD1, 0x01] 或 [0xD1, 0x00]
  → sendCmd31Payload
  → sendCommand(31) → createMSPFrame
  → WebSocket :27015
机端 FlightController::processCmd
  → 仅 packet.size()==2 时改 m_trackingEnabled
  → PersonTracker::update 读上一帧行人框
  → APMControllerSpeed 单轴水平速度（无偏航参数）
```

离线时 `sendCmd31Payload` 返回 false，按钮不会标成已跟踪。降落 `B0 01` 发送成功后，本地高亮一并关掉。

## 跟踪判断显示框

开始跟踪按钮旁边的小框读机端回传，不在网页里自己算速度。

```
PersonTracker::update 调用 APMControllerSpeed 后组 11 字节 0xFD 0x01
  → pushBoradcastData
  → 地面站 MSP cmd 31 轮询
  → decodeMSPPayload 认出 isTrackStatus
  → MspDashboard 跟踪判断框：转向 / 画面偏差角 / 下发速度
```

角度换算：`误差像素 / (画面宽/2) * 90`，半幅记为 90°。这一行不是飞控指令。下发一行看回包 `axis`：0/1 显示 x 或 y 的 cm/s，2 显示偏航 °/s。bit2 为 0 显示「未下发」。1 秒无新包显示「回传中断」。

## 飞行平移跟踪

人离开画面正中时，飞机左右、上下跟着平移，不转头。前后由共用的后退模式写 x，没开时 x 为 0。

```
地面站「AI 飞行跟踪」
  开始平移跟踪 → D3 01
  停止平移跟踪 → D3 00
  → sendCmd31Payload → CMD 31
机端 user_app._start_flight_follow
  → 关掉 D1 偏航跟踪和位置环
  → 每帧 process_flight_follow
  → 行人框中心减画面中心
  → 死区 24 像素内速度为 0
  → set_speed(x, y_cm_s, z_cm_s, 0)
  → 回传 17 字节 0xFD 0x02
地面站解析 isFlightTrackStatus
  → 左右 / 上下 / 偏差 / 下发

地面站「后退模式」（偏航跟踪和平移跟踪共用）
  → D4 01 / D4 00
  → 机端记下当前框等效边长 sqrt(宽×高)
  → 框变大写负 X（后退），框变小写正 X（前进）
  → 偏航跟踪时 set_speed(x, 0, 0, yaw)
  → 平移跟踪时 set_speed(x, y, z, 0)
  → 回传 11 字节 0xFD 0x03
```

速度：平移和后退都是 0.5 cm/s 每像素，限幅 25 cm/s。偏航跟踪是 0.6 °/s 每像素，限幅 60 °/s，死区 24 像素。人在右侧时 y 为负，沿用地面站「−Y = 右移」。人在下方时 z 为正，与机端降落的下降方向相同。`PLGUserDefine.hpp` 没写 Y 正方向；飞测若左右反了，只改机端 `TRACK_PAN_Y_SIGN`。上下反了只改 `TRACK_PAN_Z_SIGN`。前后反了只改 `TRACK_RANGE_X_SIGN`。后退模式边长差死区 16 像素。

开始偏航跟踪会停平移，开始平移会停偏航。后退模式两边都留着。降落、上锁和水平位移会把后退模式也停掉，并把速度写成 0。

## 固定自动化

```
当前实机飞行跟踪没有这个模式。
地面站没有「固定自动化」按钮，fixedBoxMode 固定为 false。
机端收到 E0 01 / E0 00 只写日志，不调用 _set_fixed_mode，油门斜坡不启动。
平移跟踪：原来的解锁起飞 → 悬停 → 「开始平移跟踪」D3 01。
```
