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
  if (arrayBuffer.byteLength < 6) return null;

  const frame = new Uint8Array(arrayBuffer);
  if (frame[0] !== MSP_PROTOCOL.HEADER || frame[1] !== MSP_PROTOCOL.VERSION) return null;

  const type = frame[2];
  const payloadSize = frame[3];
  const command = frame[4];

  if (frame.byteLength < 6 + payloadSize) return null;

  const payload = frame.slice(5, 5 + payloadSize);
  const receivedChecksum = frame[5 + payloadSize];

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
      if (payload.length < 18) return null;
      const fixEnum = ['No Fix', '2D Fix', '3D Fix'];
      return {
        gpsFix: fixEnum[view.getUint8(0)] || 'Unknown',
        numSat: view.getUint8(1),
        lat: view.getUint32(2, true) / 10000000,
        lon: view.getUint32(6, true) / 10000000,
        alt: view.getUint16(10, true),
        groundSpeed: view.getUint16(12, true),
        groundCourse: view.getUint16(14, true) / 10,
        pdop: view.getUint16(16, true) / 100
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
      const length = view.getUint8(0);

      // Case A1: length byte is present (length = 17, first byte of data is 0xFE, total >= 18)
      if (length === 17 && payload.length >= 18 && view.getUint8(1) === 0xFE) {
        return {
          isYolo: true,
          id: view.getUint16(2, true),
          targetId: view.getUint16(2, true),
          classId: view.getUint16(4, true),
          confidence: view.getUint16(6, true),
          x1: view.getUint16(8, true),
          y1: view.getUint16(10, true),
          x2: view.getUint16(12, true),
          y2: view.getUint16(14, true),
          trackId: view.getUint16(16, true)
        };
      }

      // Case A2: length byte is omitted (first byte of payload is 0xFE, payload size is 17)
      if (payload.length === 17 && view.getUint8(0) === 0xFE) {
        return {
          isYolo: true,
          id: view.getUint16(1, true),
          targetId: view.getUint16(1, true),
          classId: view.getUint16(3, true),
          confidence: view.getUint16(5, true),
          x1: view.getUint16(7, true),
          y1: view.getUint16(9, true),
          x2: view.getUint16(11, true),
          y2: view.getUint16(13, true),
          trackId: view.getUint16(15, true)
        };
      }

      // Case B1: legacy length = 15
      if (length === 15 && payload.length >= 16 && view.getUint8(1) === 0xFE) {
        return {
          isYolo: true,
          id: view.getUint16(2, true),
          targetId: view.getUint16(2, true),
          classId: view.getUint16(4, true),
          confidence: view.getUint16(6, true),
          x1: view.getUint16(8, true),
          y1: view.getUint16(10, true),
          x2: view.getUint16(12, true),
          y2: view.getUint16(14, true),
          trackId: view.getUint16(2, true)
        };
      }

      // Case B2: legacy payload.length = 15
      if (payload.length === 15 && view.getUint8(0) === 0xFE) {
        return {
          isYolo: true,
          id: view.getUint16(1, true),
          targetId: view.getUint16(1, true),
          classId: view.getUint16(3, true),
          confidence: view.getUint16(5, true),
          x1: view.getUint16(7, true),
          y1: view.getUint16(9, true),
          x2: view.getUint16(11, true),
          y2: view.getUint16(13, true),
          trackId: view.getUint16(1, true)
        };
      }

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
