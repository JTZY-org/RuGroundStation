# CMD 31 自动化内容协议

> 地面站 → 机端（Extracustom）自定义消息协议说明。   

---

## 1. 传输与外层帧

| 项目 | 值 |
|------|-----|
| 通道 | WebSocket `ws://{deviceIp}:27015` |
| MSP Cmd | `31`（`0x1F`，`MSP_RU_CUSTOM_MESSAGE`） |
| 方向 | 地面站 → 机端：`$M<` 请求 |

### 1.1 MSP 帧布局

```
偏移  字段        长度   值/说明
0     Header      1      0x24  '$'
1     Version     1      0x4D  'M'
2     Type        1      0x3C  '<' （请求）
3     Size        1      payload 字节数 N
4     Command     1      0x1F  （CMD 31）
5     Payload     N      见第 2 节「内容协议」
5+N   Checksum    1      Size XOR Command XOR Payload[0]…Payload[N-1]
```

**内容协议**指 Payload 段；下文除非特别说明，均只写 Payload hex。

---

## 2. 内容协议总表

| CmdID（首字节） | 名称 | Payload 结构 | 说明 |
|-----------------|------|--------------|------|
| `0xCC` | ARM / DISARM | `CC` + `action`（1B） | `01` 解锁，`00` 上锁 |
| `0xB0` | LAND | `B0` + `action`（1B） | `01` 开始降落，`00` 取消降落 |
| `0xD1`（恰好 2B） | TRACK | `D1` + `action`（1B） | `01` 开始偏航跟踪，`00` 停止 |
| `0xD3`（恰好 2B） | FLIGHT_FOLLOW | `D3` + `action`（1B） | `01` 开始平移跟踪，`00` 停止 |
| `0xD4`（恰好 2B） | RANGE_HOLD | `D4` + `action`（1B） | `01` 开启后退模式，`00` 关闭。偏航和平移共用 |
| `0xD1`（恰好 5B） | POS_REL_HORIZ | `D1` + `x_cm`(i16 LE) + `y_cm`(i16 LE) | 机体系相对水平位移，cm |
| `0xD2` | POS_VERT | `D2` + `alt_cm`(i16 LE) | 目标垂直高度，cm |
| `0xE0`（恰好 2B） | FIXED_BOX | `E0` + `action`（1B） | 当前实机跟踪不使用。机端收到后丢掉，不进模式 |
| `0x00` + `0xFB` | 云台 + 激光 | `00 FB` + `servo`(u16 LE) + `laser`(u16 LE) | PWM μs |

整数约定：

- `i16 LE`：有符号 int16，小端（低字节在前）
- `u16 LE`：无符号 uint16，小端
- 范围（地面站钳制）：i16 ∈ [-32768, 32767]；云台舵机 PWM ∈ [800, 2200]

---

## 3. 飞控

### 3.1 解锁 / 上锁（`0xCC`）

| 按钮 | Payload | 整帧示例（含 MSP） |
|------|---------|-------------------|
| 解锁 | `CC 01` | `24 4D 3C 02 1F CC 01 D0` |
| 上锁 | `CC 00` | `24 4D 3C 02 1F CC 00 D1` |

```
Byte0  0xCC
Byte1  action  0x01=ARM(解锁)  0x00=DISARM(上锁)
```

### 3.2 降落 / 取消降落（`0xB0`）

| 按钮 | Payload | 整帧示例 |
|------|---------|----------|
| 降落 | `B0 01` | `24 4D 3C 02 1F B0 01 AC` |
| 取消降落 | `B0 00` | `24 4D 3C 02 1F B0 00 AD` |

```
Byte0  0xB0
Byte1  action  0x01=开始降落  0x00=取消降落
```

机端收到 `B0 01` 时会同时关掉人物跟踪，避免降落位置和跟踪速度一起出力。

### 3.3 人物跟踪（`0xD1` · 恰好 2 字节）

只开/关机端已有的画面跟踪。检出和速度都在 Extracustom：行人框水平偏差映射到偏航速率。增益 0.6 °/s 每像素，死区 24 像素，限幅 60 °/s。前后由第 3.6 节的后退模式写 x，没开时 x 为 0。头文件没有偏航参数，地面站不下发航向。

```
Byte0  0xD1
Byte1  action  0x01=开始跟踪  0x00=停止跟踪
```

| 按钮 | Payload | 整帧示例（含 MSP） |
|------|---------|-------------------|
| 开始跟踪 | `D1 01` | `24 4D 3C 02 1F D1 01 CD` |
| 停止跟踪 | `D1 00` | `24 4D 3C 02 1F D1 00 CC` |

`D1 01` 的 checksum：`0x02 ⊕ 0x1F ⊕ 0xD1 ⊕ 0x01 = 0xCD`。`D1 00` 为 `0xCC`。

### 3.4 固定自动化（`0xE0` · 当前不使用）

实机飞行跟踪没有这个模式。地面站没有进入按钮。机端收到恰好 2 字节的 `E0 01` / `E0 00` 只记一条日志，然后丢掉，不改飞行状态，也不跑 1000→1200 的油门斜坡。

下面第 4 节的水平位移以 `D1` 开头，但是 5 字节；机端只把恰好 2 字节的 `D1 01` / `D1 00` 当成偏航跟踪开关。

### 3.5 飞行平移跟踪（`0xD3` · 恰好 2 字节）

脱离万向节后的跟踪。机端不转偏航，按行人框相对画面中心的偏差写 `APMControllerSpeed` 的 y 和 z，x 和偏航保持 0。和 `D1 01` 互斥：开其中一个会关掉另一个。

```
Byte0  0xD3
Byte1  action  0x01=开始平移跟踪  0x00=停止
```

| 按钮 | Payload | 整帧示例（含 MSP） |
|------|---------|-------------------|
| 开始平移跟踪 | `D3 01` | `24 4D 3C 02 1F D3 01 CF` |
| 停止平移跟踪 | `D3 00` | `24 4D 3C 02 1F D3 00 CE` |

`D3 01` 的 checksum：`0x02 ⊕ 0x1F ⊕ 0xD3 ⊕ 0x01 = 0xCF`。`D3 00` 为 `0xCE`。

降落、上锁会停掉平移跟踪并把速度清零。

速度：死区 24 像素，增益 0.5 cm/s 每像素，限幅 25 cm/s。人在画面右侧时 y 为负（沿用地面站「−Y = 右移」，头文件未写 Y 正方向）。人在画面下方时 z 为正，与机端降落 `set_speed(0, 0, +50, 0)` 的下降方向相同。前后由第 3.6 节的后退模式写 x，没开时 x 为 0。

### 3.6 后退模式（`0xD4` · 恰好 2 字节）

偏航跟踪和平移跟踪共用。按下时记住当前行人框的等效边长 `sqrt(宽×高)`。之后边长比记住的更大就后退，更小就前进。

```
Byte0  0xD4
Byte1  action  0x01=开启  0x00=关闭
```

| 按钮 | Payload | 整帧示例（含 MSP） |
|------|---------|-------------------|
| 开启后退模式 | `D4 01` | `24 4D 3C 02 1F D4 01 C8` |
| 关闭后退模式 | `D4 00` | `24 4D 3C 02 1F D4 00 C9` |

边长差 16 像素以内速度为 0。增益 0.5 cm/s 每像素，限幅 25 cm/s。`PLGUserDefine.hpp` 没写 X 谁是机头。地面站按钮约定 +X 前进、−X 后退，框变大时写负 X。飞测若前后反了，只改机端 `TRACK_RANGE_X_SIGN`。

回传 11 字节 `0xFD 0x03`：flags、x cm/s、边长差像素、记住的边长、当前边长。降落、上锁、水平位移会关掉这个模式。

---

## 4. 水平位移（`0xD1` · 恰好 5 字节 · 机体系 XY）

```
Byte0     0xD1
Byte1-2   x_cm   int16 LE
Byte3-4   y_cm   int16 LE
```

与第 3.3 节的区别只在长度：这里固定 5 字节。`D1 00 00 00 00`（保持 XY）不是停止跟踪。

当前 UI 约定（待飞测确认）：

| 按钮 | (x, y) cm | Payload（步长=100） | 整帧示例 |
|------|-----------|---------------------|----------|
| ↑ 前进 | (+step, 0) | `D1 64 00 00 00` | `24 4D 3C 05 1F D1 64 00 00 00 AF` |
| ↓ 后退 | (−step, 0) | `D1 9C FF 00 00` | `24 4D 3C 05 1F D1 9C FF 00 00 A8` |
| ← 左移 | (0, +step) | `D1 00 00 64 00` | `24 4D 3C 05 1F D1 00 00 64 00 AF` |
| → 右移 | (0, −step) | `D1 00 00 9C FF` | `24 4D 3C 05 1F D1 00 00 9C FF A8` |
| 保持 XY | (0, 0) | `D1 00 00 00 00` | `24 4D 3C 05 1F D1 00 00 00 00 CB` |

`100 = 0x0064 → LE 64 00`；`-100 = 0xFF9C → LE 9C FF`。

---

## 5. 垂直高度（`0xD2`）

```
Byte0     0xD2
Byte1-2   alt_cm   int16 LE（目标高度，cm）
```

| 按钮 | alt_cm | Payload | 整帧示例 |
|------|--------|---------|----------|
| 去 200 cm / 2 m | 200 | `D2 C8 00` | `24 4D 3C 03 1F D2 C8 00 06` |
| 1 m | 100 | `D2 64 00` | — |
| 3 m | 300 | `D2 2C 01` | — |
| 5 m | 500 | `D2 F4 01` | — |

`200 = 0x00C8 → LE C8 00`；`300 = 0x012C → LE 2C 01`。

---

## 6. 云台 + 激光（`0x00 0xFB`）

```
Byte0-1   0x00 0xFB          固定头
Byte2-3   servo_pwm  u16 LE  舵机 PWM（μs），常用预设 1000/1250/1500/1750/2000
Byte4-5   laser_pwm  u16 LE  激光：关=1000，开=2000（阈值约 1500 二分）
```

| 操作 | Payload | 整帧示例 |
|------|---------|----------|
| 中位 1500 / 激光关 | `00 FB DC 05 E8 03` | `24 4D 3C 06 1F 00 FB DC 05 E8 03 D0` |
| 中位 1500 / 激光开 | `00 FB DC 05 D0 07` | `24 4D 3C 06 1F 00 FB DC 05 D0 07 EC` |

换算：

- `1500 = 0x05DC → LE DC 05`
- `1000 = 0x03E8 → LE E8 03`
- `2000 = 0x07D0 → LE D0 07`

机端需已部署含 `0xFB` 处理的 Extracustom，否则云台/激光无动作。

---

## 7. 手动自定义（同一 CMD 31）

UI「手动自定义消息」直接把用户输入的空格分隔 hex 作为 Payload，经 `createMSPFrame(31, payload)` 发送，无额外封装。

默认快捷指令与第 3 节飞控相同：`CC 01` / `CC 00` / `B0 01` / `B0 00`。

---

## 8. Checksum 计算示例

解锁 Payload = `[CC, 01]`，Size=2，Cmd=`1F`：

```
checksum = 0x02 ⊕ 0x1F ⊕ 0xCC ⊕ 0x01 = 0xD0
整帧     = 24 4D 3C 02 1F CC 01 D0
```

---

## 9. 发送链路（代码）

```
MspDashboard.jsx 按钮
  → buildArmPayload / buildLandPayload / buildTrackPayload
     / buildPosHorizPayload / buildPosVertPayload / buildGimbalPayload
  → sendCmd31Payload(payload, label)
  → sendCommand(31, payload)
  → createMSPFrame(31, payload)     // mspProtocol.js
  → WebSocket.send(frame)
```

诊断落盘：`linshi/button-actions.log`、`linshi/button-actions.ndjson`。

---

## 10. 机端回传：跟踪判断（CMD 31 响应载荷）

方向是机端 → 地面站，走同一条自定义消息队列，不是按钮发出的请求。首字节 `0xFD`，和检测框 `0xFE` 分开。

```
Byte0     0xFD
Byte1     0x01
Byte2     flags   bit0=跟踪开  bit1=有新鲜行人框  bit2=本拍已调用 APMControllerSpeed
Byte3     turn    int8   人在画面右侧=+1，左侧=-1，死区=0
Byte4-5   speed   int16 LE  本拍写进飞控的数。axis 为 0 或 1 时单位 cm/s；axis 为 2 时单位 deg/s
Byte6     axis    0=写入 x，1=写入 y，2=写入偏航速率（x/y/z 为 0）
Byte7-8   error   int16 LE  行人中心减画面中心，像素
Byte9-10  width   uint16 LE 画面宽，像素
```

地面站把 `error / (width/2) * 90` 显示成「角度」，半幅为 90°，只表示人偏了多少。真正发出去的数在「下发」那一行：`axis` 为 2 时显示「偏航 ±N °/s」，为 0 或 1 时显示「x/y ±N cm/s」。`flags` bit2 为 0 时显示「未下发」，表示这一拍没有调用速度接口，飞机不会因跟踪而动。超过 1 秒没有新包则显示「回传中断」。

### 10.1 平移跟踪判断（`0xFD 0x02` · 17 字节）

方向同样是机端 → 地面站。和 `0xFD 0x01` 分开，避免两轴速度挤进一个 speed 字段。

```
Byte0      0xFD
Byte1      0x02
Byte2      flags   bit0=平移跟踪开  bit1=有新鲜行人框  bit2=本拍已调用 APMControllerSpeed
Byte3      pan     int8   人在画面右侧=+1，左侧=-1，水平死区=0
Byte4      vert    int8   人在画面下方=+1，上方=-1，垂直死区=0
Byte5-6    y_cm_s  int16 LE  写入 APMControllerSpeed 的 y
Byte7-8    z_cm_s  int16 LE  写入 APMControllerSpeed 的 z
Byte9-10   err_x   int16 LE  行人中心减画面水平中心，像素
Byte11-12  err_y   int16 LE  行人中心减画面垂直中心，像素。向下为正
Byte13-14  width   uint16 LE
Byte15-16  height  uint16 LE
```

地面站把两个误差都按半幅 90° 显示。下发一行是 `y ±N cm/s · z ±N cm/s`。bit2 为 0 时显示「未下发」。超过 1 秒没有新包显示「回传中断」。
