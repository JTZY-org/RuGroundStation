// MSP Protocol Constants
export const MSP_PROTOCOL = {
  HEADER: 0x24,        // '$'
  VERSION: 0x4D,       // 'M'
  TYPE_REQUEST: 0x3C,  // '<'
  TYPE_RESPONSE: 0x3E, // '>'
  TYPE_ERROR: 0x21     // '!'
};

// MSP Message IDs
export const MSP_COMMANDS = {
  MSP_STATUS: 101,
  MSP_RAW_IMU: 102,
  MSP_RAW_GPS: 106,
  MSP_ATTITUDE: 108,
  MSP_ALTITUDE: 109,
  MSP_ANALOG: 110,
  MSP_VTXTABLE_POWERLEVEL: 138,
  MSP_MOTOR_TELEMETRY: 139,
  MSP_HOME_GPS: 140,
  MSP_WP_GPS: 141,
  MSP_RU_VIDEO_INFO: 20,
  MSP_RU_CUSTOM_MESSAGE: 31
};

export const calculateChecksum = (data) => {
  let checksum = 0;
  for (let i = 0; i < data.length; i++) {
    checksum ^= data[i];
  }
  return checksum;
};

export const createMSPFrame = (command, payload = []) => {
  const payloadSize = payload.length;
  const frame = new Uint8Array(6 + payloadSize);
  let index = 0;

  frame[index++] = MSP_PROTOCOL.HEADER;       // '$'
  frame[index++] = MSP_PROTOCOL.VERSION;      // 'M'
  frame[index++] = MSP_PROTOCOL.TYPE_REQUEST; // '<'
  frame[index++] = payloadSize;
  frame[index++] = command;

  for (let i = 0; i < payloadSize; i++) {
    frame[index++] = payload[i];
  }

  const checksumData = new Uint8Array(2 + payloadSize);
  checksumData[0] = payloadSize;
  checksumData[1] = command;
  for (let i = 0; i < payloadSize; i++) {
    checksumData[2 + i] = payload[i];
  }

  frame[index] = calculateChecksum(checksumData);
  return frame;
};

export const parseMSPFrame = (arrayBuffer) => {
  if (!arrayBuffer || arrayBuffer.byteLength < 6) return null;

  const frame = new Uint8Array(arrayBuffer);
  // 查找第一个有效帧头  (兼容前面存在额外前缀或字节对齐偏移)
  let startIdx = 0;
  while (startIdx <= frame.byteLength - 6) {
    if (frame[startIdx] === MSP_PROTOCOL.HEADER && frame[startIdx + 1] === MSP_PROTOCOL.VERSION) {
      break;
    }
    startIdx++;
  }
  if (startIdx > frame.byteLength - 6) return null;

  const type = frame[startIdx + 2];
  const payloadSize = frame[startIdx + 3];
  const command = frame[startIdx + 4];

  if (frame.byteLength < startIdx + 6 + payloadSize) return null;

  const payload = frame.slice(startIdx + 5, startIdx + 5 + payloadSize);
  const receivedChecksum = frame[startIdx + 5 + payloadSize];

  const checksumData = new Uint8Array(2 + payloadSize);
  checksumData[0] = payloadSize;
  checksumData[1] = command;
  for (let i = 0; i < payloadSize; i++) {
    checksumData[2 + i] = payload[i];
  }

  const calculatedChecksum = calculateChecksum(checksumData);
  if (receivedChecksum !== calculatedChecksum) {
    console.warn(`[MSP] Checksum mismatch for cmd ${command}: expected 0x${calculatedChecksum.toString(16)}, got 0x${receivedChecksum.toString(16)}.`);
    return null;
  }

  return { type, command, payload, payloadSize };
};

export const getCommandName = (command) => {
  for (const [name, value] of Object.entries(MSP_COMMANDS)) {
    if (value === command) return name;
  }
  return `UNKNOWN_${command}`;
};

// Decoders for each packet payload based on README specifications
export const decodeMSPPayload = (command, payload) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  switch (command) {
    case MSP_COMMANDS.MSP_STATUS: {
      if (payload.length < 41) return null;
      // activeSensors ACC=1, BARO=2, MAG=4, GPS=8, RANGE=16, GYRO=32, FLOW=64
      const activeSensorsVal = view.getUint16(4, true);
      const sensors = [];
      if (activeSensorsVal & 1) sensors.push('ACC');
      if (activeSensorsVal & 2) sensors.push('BARO');
      if (activeSensorsVal & 4) sensors.push('MAG');
      if (activeSensorsVal & 8) sensors.push('GPS');
      if (activeSensorsVal & 16) sensors.push('RANGE');
      if (activeSensorsVal & 32) sensors.push('GYRO');
      if (activeSensorsVal & 64) sensors.push('FLOW');

      return {
        cycleTime: view.getUint16(0, true),
        i2cErrorCounter: view.getUint16(2, true),
        activeSensors: sensors.join(', '),
        flightModeFlagsLow: view.getUint32(6, true),
        currentPidProfileIndex: view.getUint8(10),
        averageSystemLoadPercent: view.getUint16(11, true),
        gyroCycleTime: view.getUint16(13, true),
        armingDisableFlags: view.getUint32(32, true),
        isArmed: view.getUint8(40) === 0 ? 'ARMED' : 'DISARMED'
      };
    }

    case MSP_COMMANDS.MSP_RAW_IMU: {
      if (payload.length < 18) return null;
      return {
        accX: view.getInt16(0, true),
        accY: view.getInt16(2, true),
        accZ: view.getInt16(4, true),
        gyroX: view.getInt16(6, true),
        gyroY: view.getInt16(8, true),
        gyroZ: view.getInt16(10, true),
        magX: view.getInt16(12, true),
        magY: view.getInt16(14, true),
        magZ: view.getInt16(16, true)
      };
    }

    case MSP_COMMANDS.MSP_RAW_GPS: {
      if (payload.length < 14) return null;
      const fixEnum = ['No Fix', '2D Fix', '3D Fix'];
      return {
        gpsFix: fixEnum[view.getUint8(0)] || (view.getUint8(0) > 0 ? 'Fix' : 'No Fix'),
        numSat: view.getUint8(1),
        lat: view.getInt32(2, true) / 10000000,
        lon: view.getInt32(6, true) / 10000000,
        alt: payload.length >= 12 ? view.getInt16(10, true) : 0,
        groundSpeed: payload.length >= 14 ? view.getUint16(12, true) : 0,
        groundCourse: payload.length >= 16 ? view.getUint16(14, true) / 10 : 0,
        pdop: payload.length >= 18 ? view.getUint16(16, true) / 100 : 0
      };
    }

    case MSP_COMMANDS.MSP_HOME_GPS: {
      if (payload.length < 10) return null;
      return {
        lat: view.getInt32(2, true) / 10000000,
        lon: view.getInt32(6, true) / 10000000,
        alt: payload.length >= 12 ? view.getInt16(10, true) : 0
      };
    }

    case MSP_COMMANDS.MSP_WP_GPS: {
      if (payload.length < 10) return null;
      return {
        isWaypoint: true,
        wpIndex: view.getUint8(0), // 机端 stuData.gpsFix 可作为航点序号
        numSat: view.getUint8(1),
        lat: view.getInt32(2, true) / 10000000,
        lon: view.getInt32(6, true) / 10000000,
        alt: payload.length >= 12 ? view.getInt16(10, true) : 0
      };
    }

    case MSP_COMMANDS.MSP_ATTITUDE: {
      if (payload.length < 6) return null;
      return {
        roll: view.getInt16(0, true) / 10,
        pitch: view.getInt16(2, true) / 10,
        yaw: view.getInt16(4, true)
      };
    }

    case MSP_COMMANDS.MSP_ALTITUDE: {
      if (payload.length < 6) return null;
      return {
        estimatedAltitude: view.getInt32(0, true) / 100, // convert cm to m
        varioSpeed: view.getInt16(4, true) // cm/s
      };
    }

    case MSP_COMMANDS.MSP_ANALOG: {
      if (payload.length < 7) return null;
      return {
        legacyBatteryVoltage: view.getUint8(0) / 10,
        mAhDrawn: view.getUint16(1, true),
        rssi: view.getUint16(3, true),
        amperage: view.getInt16(5, true) / 100,
        batteryVoltage: payload.length >= 9 ? view.getUint16(7, true) / 100 : view.getUint8(0) / 10
      };
    }

    case MSP_COMMANDS.MSP_RU_VIDEO_INFO: {
      if (payload.length < 2) return null;
      return {
        bitrateKbps: view.getUint16(0, true)
      };
    }

    case MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE: {
      if (payload.length === 0) return { message: "(No message / queue empty)" };

      // 机端跟踪判断：0xFD 0x01 是偏航跟踪。不是 YOLO（0xFE），也不是文本。
      // flags bit0=开关 bit1=有行人 bit2=本拍已调用 APMControllerSpeed
      // turn：人在画面右侧 +1，左侧 -1，死区 0
      // axis：0=水平 x cm/s，1=水平 y cm/s，2=偏航速率 deg/s（speed 字段同一位置）
      if (payload.length >= 11 && view.getUint8(0) === 0xFD && view.getUint8(1) === 0x03) {
        const flags = view.getUint8(2);
        return {
          isRangeHoldStatus: true,
          enabled: (flags & 0x01) !== 0,
          fresh: (flags & 0x02) !== 0,
          commanded: (flags & 0x04) !== 0,
          hasRef: (flags & 0x08) !== 0,
          speedXCmS: view.getInt16(3, true),
          sizeErrPx: view.getInt16(5, true),
          refPx: view.getUint16(7, true),
          curPx: view.getUint16(9, true)
        };
      }

      // 0xFD 0x02 是平移跟踪，17 字节：左右/上下、y/z 速度、两轴像素偏差、宽高。
      if (payload.length >= 17 && view.getUint8(0) === 0xFD && view.getUint8(1) === 0x02) {
        const flags = view.getUint8(2);
        return {
          isFlightTrackStatus: true,
          enabled: (flags & 0x01) !== 0,
          fresh: (flags & 0x02) !== 0,
          commanded: (flags & 0x04) !== 0,
          pan: view.getInt8(3),
          vert: view.getInt8(4),
          speedYCmS: view.getInt16(5, true),
          speedZCmS: view.getInt16(7, true),
          errorXPx: view.getInt16(9, true),
          errorYPx: view.getInt16(11, true),
          frameWidth: view.getUint16(13, true),
          frameHeight: view.getUint16(15, true)
        };
      }

      if (payload.length >= 11 && view.getUint8(0) === 0xFD && view.getUint8(1) === 0x01) {
        const flags = view.getUint8(2);
        return {
          isTrackStatus: true,
          enabled: (flags & 0x01) !== 0,
          fresh: (flags & 0x02) !== 0,
          commanded: (flags & 0x04) !== 0,
          turn: view.getInt8(3),
          speedCmS: view.getInt16(4, true),
          axis: view.getUint8(6),
          errorPx: view.getInt16(7, true),
          frameWidth: view.getUint16(9, true)
        };
      }

      // Helper to parse YOLO targets from a buffer starting at offset
      const parseYoloTargets = (startOffset) => {
        const targets = [];
        let curr = startOffset;
        while (curr + 15 <= payload.length) {
          if (view.getUint8(curr) !== 0xFE) break;
          // Determine if 17-byte (with trackId) or 15-byte target
          const hasTrackId = (curr + 17 <= payload.length) && (curr + 17 === payload.length || view.getUint8(curr + 17) === 0xFE || curr + 32 <= payload.length || curr + 34 <= payload.length);
          const targetId = view.getUint16(curr + 1, true);
          const classId = view.getUint16(curr + 3, true);
          const confidence = view.getUint16(curr + 5, true);
          const x1 = view.getUint16(curr + 7, true);
          const y1 = view.getUint16(curr + 9, true);
          const x2 = view.getUint16(curr + 11, true);
          const y2 = view.getUint16(curr + 13, true);
          const trackId = hasTrackId ? view.getUint16(curr + 15, true) : targetId;

          targets.push({
            isYolo: true,
            id: targetId,
            targetId,
            classId,
            confidence,
            x1,
            y1,
            x2,
            y2,
            trackId
          });

          curr += hasTrackId ? 17 : 15;
        }
        return targets;
      };

      // Check if payload starts directly with 0xFE or with a length byte followed by 0xFE
      if (payload.length >= 15 && view.getUint8(0) === 0xFE) {
        const targets = parseYoloTargets(0);
        if (targets.length > 0) {
          return targets.length === 1 ? targets[0] : targets;
        }
      } else if (payload.length >= 16 && view.getUint8(1) === 0xFE) {
        const targets = parseYoloTargets(1);
        if (targets.length > 0) {
          return targets.length === 1 ? targets[0] : targets;
        }
      }

      const length = view.getUint8(0);
      const textDecoder = new TextDecoder();
      const stringData = textDecoder.decode(payload.slice(1, 1 + length));
      const rawHex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[CMD31] Non-YOLO payload (len=${payload.length}): ${rawHex}`);
      return {
        length,
        message: stringData,
        rawHex
      };
    }

    default:
      return null;
  }
};
