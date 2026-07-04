# RuAPS GClient - WebSocket MSP Protocol API Reference

This document describes the binary API interface of the RuAPS GClient WebSocket Server. It allows Ground Control Station (GCS) developers to decode telemetry and sensor packets without copying C++ structure definitions.

---

## 1. Connection Details
- **Host Binding**: `0.0.0.0`
- **Port**: `27015`
- **Protocol**: WebSocket (Binary Frames)
- **Model**: Passive Request-Response (Pull Model)

---

## 2. Packet Framing (MSPv1 Format)

### Client Request Frame (Client -> Server)
Sent as a WebSocket binary frame to request a specific data structure:

```
+---------+---------+---------+--------------+------------+--------------------+----------+
|  '$'    |  'M'    |  '<'    | Payload Size | Command ID |      Payload       | Checksum |
| (1 byte)| (1 byte)| (1 byte)|   (1 byte)   |  (1 byte)  | (Size bytes, if >0)| (1 byte) |
+---------+---------+---------+--------------+------------+--------------------+----------+
```
* **Header**: Always `"$M<"` (ASCII hex: `0x24 0x4D 0x3C`)
* **Payload Size**: Typically `0` for basic pull requests.
* **Checksum**: XOR of `Payload Size` ^ `Command ID` ^ `Payload bytes`.

### Server Response Frame (Server -> Client)
Sent back as a WebSocket binary frame:

```
+---------+---------+---------+--------------+------------+--------------------+----------+
|  '$'    |  'M'    |  '>'    | Payload Size | Command ID |    Payload Data    | Checksum |
| (1 byte)| (1 byte)| (1 byte)|   (1 byte)   |  (1 byte)  | (Size bytes, if >0)| (1 byte) |
+---------+---------+---------+--------------+------------+--------------------+----------+
```
* **Header**: Always `"$M>"` (ASCII hex: `0x24 0x4D 0x3E`)
* **Payload Size**: Number of bytes in the `Payload Data`.
* **Checksum**: XOR of `Payload Size` ^ `Command ID` ^ `Payload Data bytes`.

---

## 3. Payload Binary Layouts

Below are the exact byte layouts of the payloads returned inside the **Payload Data** section of the Server Response Frame. All values are packed in **Little-Endian** byte order.

### A. MSP_STATUS (Command ID: 101 / 0x65)
*Payload Size: 45 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `uint16_t` | `cycleTime` | microseconds | Controller cycle duration |
| `2` | `uint16_t` | `i2cErrorCounter` | count | Number of I2C bus errors |
| `4` | `uint16_t` | `activeSensors` | bitmask | `1`=ACC, `2`=BARO, `4`=MAG, `8`=GPS, `16`=RANGEFINDER, `32`=GYRO, `64`=FLOW |
| `6` | `uint32_t` | `flightModeFlagsLow` | bitmask | Mode flags (e.g. Angle, Horizon, Horizon hold) |
| `10` | `uint8_t` | `currentPidProfileIndex` | index | Active PID profile |
| `11` | `uint16_t` | `averageSystemLoadPercent` | % | Average CPU load |
| `13` | `uint16_t` | `gyroCycleTime_DEPRECATED` | microseconds | Gyro sampling cycle duration (deprecated) |
| `15` | `uint8_t` | `flightModeFlagsHeader` | - | Lower 4 bits indicate byte count of upper mode flags |
| `16` | `uint8_t[15]`| `flightModeFlagsHigh` | - | Upper bits of flight mode flags |
| `31` | `uint8_t` | `armingDisableFlagCount` | - | Number of arming disable flags present |
| `32` | `uint32_t` | `armingDisableFlags` | bitmask | Reasons why arming is disabled (gyro calibration, tilt, etc.) |
| `36` | `uint8_t` | `configStateFlags` | bitmask | Bit `0` = reboot required |
| `37` | `uint16_t` | `coreTemperatureCelsius` | °C | SoC / Flight Controller internal temperature |
| `39` | `uint8_t` | `controlRateProfileCount` | - | Number of rate profiles |
| `40` | `uint8_t` | `isdisarm` | flag | `0` = ARMED, `1` = DISARMED |
| `41-44`| `uint8_t[4]`| Padding | - | Real-time structure alignment padding |

---

### B. MSP_RAW_IMU (Command ID: 102 / 0x66)
*Payload Size: 18 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `int16_t` | `accX` | - | Raw accelerometer X-axis |
| `2` | `int16_t` | `accY` | - | Raw accelerometer Y-axis |
| `4` | `int16_t` | `accZ` | - | Raw accelerometer Z-axis |
| `6` | `int16_t` | `gyroX` | - | Raw gyroscope X-axis |
| `8` | `int16_t` | `gyroY` | - | Raw gyroscope Y-axis |
| `10` | `int16_t` | `gyroZ` | - | Raw gyroscope Z-axis |
| `12` | `int16_t` | `magX` | - | Raw magnetometer X-axis |
| `14` | `int16_t` | `magY` | - | Raw magnetometer Y-axis |
| `16` | `int16_t` | `magZ` | - | Raw magnetometer Z-axis |

---

### C. MSP_RAW_GPS (Command ID: 106 / 0x6A)
*Payload Size: 18 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `uint8_t` | `gpsFix` | enum | `0` = No fix, `1` = 2D fix, `2` = 3D fix |
| `1` | `uint8_t` | `numSat` | count | Number of tracked satellites |
| `2` | `uint32_t` | `lat` | 1e7 degrees | Latitude (divide by `10,000,000` to get float degrees) |
| `6` | `uint32_t` | `lon` | 1e7 degrees | Longitude (divide by `10,000,000` to get float degrees) |
| `10` | `uint16_t` | `alt` | meters | Altitude |
| `12` | `uint16_t` | `groundSpeed` | cm/s | Ground speed |
| `14` | `uint16_t` | `groundCourse` | degrees * 10 | Direction of travel (divide by `10` to get float degrees) |
| `16` | `uint16_t` | `pdop` | - | Dilution of precision (divide by `100` to get float value) |

---

### D. MSP_ATTITUDE (Command ID: 108 / 0x6C)
*Payload Size: 6 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `int16_t` | `roll` | degrees * 10 | Roll angle (divide by `10` to get float degrees) |
| `2` | `int16_t` | `pitch` | degrees * 10 | Pitch angle (divide by `10` to get float degrees) |
| `4` | `int16_t` | `yaw` | degrees | Yaw angle (range `[0, 360)`) |

---

### E. MSP_ALTITUDE (Command ID: 109 / 0x6D)
*Payload Size: 6 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `int32_t` | `estimatedAltitudeCm` | centimeters | Barometric/Estimated altitude |
| `4` | `int16_t` | `varioCmS` | cm/s | Vertical rate / variometer speed |

---

### F. MSP_ANALOG (Command ID: 110 / 0x6E)
*Payload Size: 8 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `uint8_t` | `legacyBatteryVoltage` | decivolts (0.1V) | Battery voltage (legacy support) |
| `1` | `uint16_t` | `mAhDrawn` | mAh | Total capacity consumed |
| `3` | `uint16_t` | `rssi` | - | Receiver signal strength index (usually `0 - 1023`) |
| `5` | `int16_t` | `amperage` | centiamps (0.01A)| Current draw (divide by `100` to get Amperes) |
| `7` | `uint16_t` | `batteryVoltage` | centivolts (0.01V)| Real-time battery voltage (divide by `100` for Volts) |

---

### G. MSP_RU_VIDEO_INFO (Command ID: 20 / 0x14)
*Payload Size: 2 bytes*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `uint16_t` | `bitrateKbps` | kbps | Downlink wireless video bitrate |

---

### H. MSP_RU_CUSTOM_MESSAGE (Command ID: 31 / 0x1F)
*Payload Size: Variable (Up to 256 bytes)*

| Offset | Type | Name | Scale/Unit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `uint8_t` | `length` | count | Number of bytes in the custom message |
| `1 ...`| `uint8_t[length]` | `data` | - | Raw custom data payload |

> **Note**: Custom messages are managed through a FIFO queue in GClient. Pulling ID 31 pops the oldest message. If no custom messages are in the queue, a response packet with `Payload Size` set to `0` is returned.

#### 1. YOLO Target Bounding Box Frame (Typical Payload Structure)
When the custom message has `length == 15` and the first byte of `data` is `0xFE`, it represents a tracked YOLO AI target box. GCS clients should parse the custom message's `data` payload using the following structure:

| Offset inside `data` | Type | Name | Description |
| :--- | :--- | :--- | :--- |
| `0` | `uint8_t` | `header` | Always `0xFE` (indicates YOLO Target Box packet) |
| `1` | `uint16_t` | `target_id` | Unique ID assigned to the tracked object |
| `3` | `uint16_t` | `cls_id` | Class index ID of the detected object |
| `5` | `uint16_t` | `confidence` | Detection confidence percentage (`0 - 100`) |
| `7` | `uint16_t` | `x1` | Bounding box top-left X coordinate |
| `9` | `uint16_t` | `y1` | Bounding box top-left Y coordinate |
| `11` | `uint16_t` | `x2` | Bounding box bottom-right X coordinate |
| `13` | `uint16_t` | `y2` | Bounding box bottom-right Y coordinate |

---

## 4. Example Decoding Code (JavaScript / Node.js)
```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:27015');

ws.on('open', () => {
    console.log('Connected to GClient');
    // Request MSP_ATTITUDE (Command ID: 108 / 0x6C)
    // Payload Size = 0, Command ID = 108, Checksum = 0 ^ 108 = 108
    const requestFrame = Buffer.from([0x24, 0x4D, 0x3C, 0x00, 0x6C, 0x6C]);
    ws.send(requestFrame);
});

ws.on('message', (data) => {
    // Check if it's a valid MSP response '$M>'
    if (data[0] === 0x24 && data[1] === 0x4D && data[2] === 0x3E) {
        const payloadSize = data[3];
        const commandId = data[4];
        const payload = data.slice(5, 5 + payloadSize);

        if (commandId === 108) { // MSP_ATTITUDE
            const roll = payload.readInt16LE(0) / 10.0;
            const pitch = payload.readInt16LE(2) / 10.0;
            const yaw = payload.readInt16LE(4);
            console.log(`Attitude: Roll: ${roll}°, Pitch: ${pitch}°, Yaw: ${yaw}°`);
        }
        else if (commandId === 31 && payloadSize > 0) { // MSP_RU_CUSTOM_MESSAGE
            const msgLen = payload[0];
            const msgData = payload.slice(1, 1 + msgLen);
            
            // Check for YOLO Target Box Packet
            if (msgLen === 15 && msgData[0] === 0xFE) {
                const targetId = msgData.readUInt16LE(1);
                const classId = msgData.readUInt16LE(3);
                const confidence = msgData.readUInt16LE(5);
                const x1 = msgData.readUInt16LE(7);
                const y1 = msgData.readUInt16LE(9);
                const x2 = msgData.readUInt16LE(11);
                const y2 = msgData.readUInt16LE(13);
                
                console.log(`YOLO Target Box -> ID: ${targetId}, Class: ${classId}, Conf: ${confidence}%`);
                console.log(`Box Coordinates -> TopLeft: (${x1}, ${y1}), BottomRight: (${x2}, ${y2})`);
            }
        }
    }
});
```
