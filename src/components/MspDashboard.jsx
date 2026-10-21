import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  MSP_COMMANDS, 
  createMSPFrame, 
  parseMSPFrame, 
  decodeMSPPayload
} from '../utils/mspProtocol';
import './MspDashboard.css';

// Align with RuAPS Extracustom python/protocol.py CmdID + Flutter GimbalProtocol
const GIMBAL_PWM_PRESETS = [1000, 1250, 1500, 1750, 2000];
const LASER_OFF_PWM = 1000;
const LASER_ON_PWM = 2000;
const POS_STEP_CM = 100; // 1 m relative move presets for testing

// TEMP fake sat: set false (or delete the TEMP blocks below) to restore real GPS numSat
const TEMP_FAKE_NUM_SAT = true;
// TEMP fake current: set false (or delete TEMP amperage blocks) to restore real amperage
const TEMP_FAKE_AMPERAGE = true;
// TEMP fake GPS fix: set false to restore real gpsFix label
const TEMP_FAKE_GPS_FIX = true;

const i16Le = (n) => {
  const v = Math.max(-32768, Math.min(32767, Math.round(n))) & 0xffff;
  return [v & 0xff, (v >> 8) & 0xff];
};

const buildGimbalPayload = (servoPwm, laserPwm = LASER_OFF_PWM) => {
  const servo = Math.max(800, Math.min(2200, Math.round(servoPwm)));
  const laser = laserPwm >= (LASER_OFF_PWM + LASER_ON_PWM) / 2 ? LASER_ON_PWM : LASER_OFF_PWM;
  return [
    0x00,
    0xFB,
    servo & 0xff,
    (servo >> 8) & 0xff,
    laser & 0xff,
    (laser >> 8) & 0xff
  ];
};

// action: 1 = arm, 0 = disarm (protocol.py FMT_ARM)
const buildArmPayload = (arm) => [0xCC, arm ? 0x01 : 0x00];
// action: 1 = start land, 0 = cancel (protocol.py FMT_LAND)
const buildLandPayload = (start) => [0xB0, start ? 0x01 : 0x00];
// 人物跟踪开关：恰好 2 字节。D1 01 开始偏航跟踪，D1 00 停止。
// 5 字节的 D1 + x/y 仍是水平位移，机端按包长区分，不能混用。
const buildTrackPayload = (enabled) => [0xD1, enabled ? 0x01 : 0x00];
// 飞行平移跟踪：恰好 2 字节。D3 01 开始，D3 00 停止。和 D1 偏航跟踪互斥。
const buildFlightFollowPayload = (enabled) => [0xD3, enabled ? 0x01 : 0x00];
// 后退模式。偏航跟踪和平移跟踪共用。恰好 2 字节：D4 01 开启，D4 00 关闭。
const buildRangeHoldPayload = (enabled) => [0xD4, enabled ? 0x01 : 0x00];
// 实机飞行跟踪没有固定自动化。地面站不发 E0。
// 机端回传超过这个时间没有新包，显示框改成「回传中断」。
const TRACK_JUDGE_STALE_MS = 1000;
// 半幅画面记成 90°，只用来看人偏了多少。这一行不是飞控指令。
// 真正下发的数在「下发」：axis 0/1 是水平 cm/s，axis 2 是偏航速率 deg/s。
const viewAngleDeg = (errorPx, frameWidth) => {
  const half = Math.max(1, Math.floor(frameWidth / 2));
  const deg = (errorPx * 90) / half;
  return Math.max(-90, Math.min(90, deg));
};
const formatSigned = (n, digits = 0) => {
  const text = digits > 0 ? Number(n).toFixed(digits) : String(Math.round(n));
  return n > 0 ? `+${text}` : text;
};
// 机端回传的「下发」一行。bit2 为 0 时还没调用速度接口。
// axis 2 对应 APMControllerSpeed 的第 4 个参数，单位 deg/s，不是 cm/s。
const formatTrackCommand = (axis, speed, commanded) => {
  if (!commanded) return '未下发';
  if (axis === 2) return `偏航 ${formatSigned(speed)} °/s`;
  const axisName = axis === 1 ? 'y' : 'x';
  return `${axisName} ${formatSigned(speed)} cm/s`;
};
// 平移跟踪回传的下发一行。y/z 都是 cm/s。bit2 为 0 时这一拍没有调用速度接口。
const formatFlightCommand = (speedY, speedZ, commanded) => {
  if (!commanded) return '未下发';
  return `y ${formatSigned(speedY)} cm/s · z ${formatSigned(speedZ)} cm/s`;
};
const formatRangeCommand = (speedX, commanded) => {
  if (!commanded) return '未下发';
  return `x ${formatSigned(speedX)} cm/s`;
};
// POS_REL_HORIZ 0xD1 + x_cm + y_cm (int16 LE)，共 5 字节
// 机体系，权威定义见 PLGUserDefine.hpp（APMControllerPosition）；X/Y 谁是机头以飞测为准，勿用 apm.pyi
const buildPosHorizPayload = (xCm, yCm) => [0xD1, ...i16Le(xCm), ...i16Le(yCm)];
// POS_VERT 0xD2 + alt_cm (int16 LE)
const buildPosVertPayload = (altCm) => [0xD2, ...i16Le(altCm)];

const DEFAULT_SHORTCUTS = [
  { name: '解锁', payload: 'CC 01' },
  { name: '上锁', payload: 'CC 00' },
  { name: '降落', payload: 'B0 01' },
  { name: '取消降落', payload: 'B0 00' }
];

const toHex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const armedLabel = (armed) => {
  if (armed === 'ARMED') return '已解锁';
  if (armed === 'DISARMED') return '已上锁';
  return '未知';
};

const gpsFixLabel = (fix) => {
  if (fix === '3D Fix') return '3D 定位';
  if (fix === '2D Fix') return '2D 定位';
  if (fix === 'No Fix') return '未定位';
  return fix || '未知';
};

export function MspDashboard({ onYoloBoxUpdate, streamConnected, rtspConnected, deviceIp }) {
  const isStreamActive = streamConnected !== undefined ? streamConnected : rtspConnected;
  const wsUrl = `ws://${deviceIp}:27015`;
  const [isConnected, setIsConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Real-time telemetry database
  const [telemetry, setTelemetry] = useState({
    armed: 'UNKNOWN',
    cycleTime: 0,
    activeSensors: 'None',
    roll: 0,
    pitch: 0,
    yaw: 0,
    batteryVoltage: 0,
    amperage: 0,
    mAhDrawn: 0,
    rssi: 0,
    bitrateKbps: 0,
    customMessage: '',
    customLength: 0,
    altitudeM: 0,
    varioCmS: 0,
    gpsFix: 'No Fix',
    numSat: 0,
    lat: 0,
    lon: 0,
    gpsAlt: 0
  });

  // Custom Command Input State
  const [customPayloadHex, setCustomPayloadHex] = useState('');
  const [newShortcutName, setNewShortcutName] = useState('');
  const [gimbalPwm, setGimbalPwm] = useState(1500);
  const [laserOn, setLaserOn] = useState(false);
  const [posStepCm, setPosStepCm] = useState(POS_STEP_CM);
  const [vertAltCm, setVertAltCm] = useState(200);
  // 仅在跟踪指令真正发出后置位，离线点击不把按钮标成已跟踪。
  const [trackingOn, setTrackingOn] = useState(false);
  // 平移跟踪。和偏航跟踪互斥，发送成功才点亮。
  const [flightFollowOn, setFlightFollowOn] = useState(false);
  // 后退模式。偏航和平移共用，发送成功才点亮。
  const [rangeHoldOn, setRangeHoldOn] = useState(false);
  // 实机跟踪没有固定自动化，这个开关保持关闭，位移和云台不再被它锁住。
  const fixedBoxMode = false;
  // 机端 0xFD 0x01 回传的当次判断。receivedAt 用来判断回传是否还活着。
  const [trackJudge, setTrackJudge] = useState(null);
  // 机端 0xFD 0x02。左右、上下和平移速度。
  const [flightJudge, setFlightJudge] = useState(null);
  // 机端 0xFD 0x03。前后速度和框边长差。
  const [rangeJudge, setRangeJudge] = useState(null);
  const [trackClock, setTrackClock] = useState(() => Date.now());
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      const saved = localStorage.getItem('msp_shortcuts');
      if (!saved) return DEFAULT_SHORTCUTS;
      const parsed = JSON.parse(saved);
      // Migrate old inverted ARM/DISARM or English default shortcut names
      const looksOldInverted =
        Array.isArray(parsed) &&
        parsed.some((s) => (s.name === 'ARM' || s.name === '解锁') && s.payload === 'CC 00') &&
        parsed.some((s) => (s.name === 'DISARM' || s.name === '上锁') && s.payload === 'CC 01');
      const looksEnglishDefaults =
        Array.isArray(parsed) &&
        parsed.some((s) => s.name === 'ARM') &&
        parsed.some((s) => s.name === 'DISARM');
      return looksOldInverted || looksEnglishDefaults ? DEFAULT_SHORTCUTS : parsed;
    } catch (e) {
      return DEFAULT_SHORTCUTS;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('msp_shortcuts', JSON.stringify(shortcuts));
    } catch (e) {
      console.error('保存快捷指令失败:', e);
    }
  }, [shortcuts]);

  useEffect(() => {
    const id = setInterval(() => setTrackClock(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // TEMP: fake numSat 15–17 every 3s — remove with TEMP_FAKE_NUM_SAT
  useEffect(() => {
    if (!TEMP_FAKE_NUM_SAT) return undefined;
    const tick = () => {
      const n = 15 + Math.floor(Math.random() * 3); // 15, 16, 17
      setTelemetry((prev) => ({ ...prev, numSat: n }));
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  // TEMP: fake amperage 7–12 A every 5s — remove with TEMP_FAKE_AMPERAGE
  useEffect(() => {
    if (!TEMP_FAKE_AMPERAGE) return undefined;
    const tick = () => {
      const a = 7 + Math.random() * 5; // [7, 12)
      setTelemetry((prev) => ({ ...prev, amperage: a }));
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  // Polling settings (Sequential poll cycle of actual GClient telemetry)
  // CMD31 (MSP_RU_CUSTOM_MESSAGE) is interleaved frequently to avoid missing
  // low-frequency (1Hz) custom frames that can be overwritten by high-frequency YOLO data
  const pollCycle = useRef([
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE,
    MSP_COMMANDS.MSP_STATUS,
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE,
    MSP_COMMANDS.MSP_ATTITUDE,
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE,
    MSP_COMMANDS.MSP_ANALOG,
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE,
    MSP_COMMANDS.MSP_ALTITUDE,
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE,
    MSP_COMMANDS.MSP_RAW_GPS,
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE,
    MSP_COMMANDS.MSP_RU_VIDEO_INFO,
  ]);
  const currentPollIndex = useRef(0);
  const pollTimerRef = useRef(null);
  const isPollingRef = useRef(false);

  // Connection WebSocket Ref
  const wsRef = useRef(null);

  // Console Logs
  const [logs, setLogs] = useState([]);
  const addLog = useCallback((text, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ time, text, type }, ...prev].slice(0, 80));
  }, []);

  // #region agent log
  const debugButtonTrace = useCallback((hypothesisId, location, message, data = {}) => {
    const ws = wsRef.current;
    const readyStateMap = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
    const snapshot = {
      ...data,
      isConnected,
      isStreamActive: !!isStreamActive,
      deviceIp,
      wsUrl,
      wsExists: !!ws,
      wsReadyState: ws ? readyStateMap[ws.readyState] ?? String(ws.readyState) : 'NO_WS',
      armed: telemetry.armed,
      timestampUi: new Date().toISOString()
    };
    // UI console — always visible to user
    addLog(`[诊断/${hypothesisId}] ${message} | ${JSON.stringify(snapshot)}`, 'info');

    const payload = {
      sessionId: '84ca7e',
      runId: 'btn-trace',
      hypothesisId,
      location,
      message,
      data: snapshot,
      timestamp: Date.now(),
      timestampUi: snapshot.timestampUi
    };

    // Persist under project linshi/ via Vite middleware
    fetch('/__linshi_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});

    // Debug ingest
    fetch('http://127.0.0.1:7896/ingest/49f47dfd-9d83-40d1-a5c0-198eb9aa0e6d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '84ca7e' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }, [addLog, deviceIp, isConnected, isStreamActive, telemetry.armed, wsUrl]);
  // #endregion

  const sendCommand = useCallback((cmdId, payloadBytes = [], traceLabel = null) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // #region agent log
      if (traceLabel) {
        debugButtonTrace('A', 'MspDashboard.jsx:sendCommand', 'sendCommand 提前返回：WS 不可用', {
          cmdId,
          traceLabel,
          payloadLen: payloadBytes.length,
          payloadHex: toHex(payloadBytes)
        });
      }
      // #endregion
      return false;
    }
    const frame = createMSPFrame(cmdId, payloadBytes);
    const frameHex = Array.from(frame).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    ws.send(frame);
    // #region agent log
    // Only trace button/manual sends — skip empty telemetry poll spam
    if (traceLabel || payloadBytes.length > 0) {
      debugButtonTrace('D', 'MspDashboard.jsx:sendCommand', 'sendCommand 已 ws.send', {
        cmdId,
        traceLabel,
        payloadLen: payloadBytes.length,
        payloadHex: toHex(payloadBytes),
        frameLen: frame.length,
        frameHex,
        sentAs: 'Uint8Array'
      });
    }
    // #endregion
    return true;
  }, [debugButtonTrace]);

  const sendCmd31Payload = useCallback((payload, label) => {
    const hexStr = toHex(payload);
    setCustomPayloadHex(hexStr);
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendCmd31Payload', `按钮触发：${label}`, {
      label,
      payloadHex: hexStr,
      payloadBytes: payload
    });
    // #endregion

    const ws = wsRef.current;
    const wsOpen = !!(ws && ws.readyState === WebSocket.OPEN);
    // Gate on live WS only — React isConnected can lag behind poll-loop closures
    if (!wsOpen) {
      // #region agent log
      debugButtonTrace('C', 'MspDashboard.jsx:sendCmd31Payload', `${label} 被拦截：WS 未 OPEN`, {
        label,
        payloadHex: hexStr,
        reactIsConnected: isConnected,
        wsOpen
      });
      // #endregion
      addLog(`${label} 未发送：GCS WebSocket 未连接。请先开视频，等链路在线后再点。`, 'warning');
      return false;
    }

    const ok = sendCommand(31, payload, label);
    if (ok) {
      addLog(`已发送 ${label}（CMD 31）: [${hexStr}] | 当前状态=${armedLabel(telemetry.armed)}`, 'tx');
      // #region agent log
      debugButtonTrace('E', 'MspDashboard.jsx:sendCmd31Payload', `${label} 发送成功，等待机端/遥测变化`, {
        label,
        payloadHex: hexStr,
        armedBefore: telemetry.armed
      });
      // #endregion
    } else {
      addLog(`${label} 发送失败：WebSocket 不可用`, 'error');
    }
    return ok;
  }, [addLog, debugButtonTrace, isConnected, sendCommand, telemetry.armed]);

  const saveShortcut = useCallback(() => {
    const trimmedName = newShortcutName.trim();
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:saveShortcut', '保存快捷指令按钮', {
      name: trimmedName,
      payloadHex: customPayloadHex
    });
    // #endregion
    if (!trimmedName) {
      addLog('请输入快捷指令名称', 'warning');
      return;
    }
    const duplicate = shortcuts.find(s => s.name.trim().toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
      addLog(`快捷指令「${trimmedName}」已存在`, 'warning');
      return;
    }
    setShortcuts([...shortcuts, { name: trimmedName, payload: customPayloadHex }]);
    setNewShortcutName('');
    addLog(`已保存快捷指令「${trimmedName}」: ${customPayloadHex || '(空)'}`, 'success');
  }, [addLog, customPayloadHex, debugButtonTrace, newShortcutName, shortcuts]);

  const deleteShortcut = useCallback((e, nameToDelete) => {
    e.stopPropagation();
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:deleteShortcut', '删除快捷指令按钮', { nameToDelete });
    // #endregion
    setShortcuts(shortcuts.filter(s => s.name !== nameToDelete));
    addLog(`已删除快捷指令「${nameToDelete}」`, 'info');
  }, [addLog, debugButtonTrace, shortcuts]);

  const resetShortcuts = useCallback(() => {
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:resetShortcuts', '恢复默认快捷指令按钮', {
      beforeCount: shortcuts.length
    });
    // #endregion
    setShortcuts(DEFAULT_SHORTCUTS);
    addLog('已恢复默认快捷指令（解锁=CC 01，上锁=CC 00）', 'info');
  }, [addLog, debugButtonTrace, shortcuts.length]);

  const runShortcut = useCallback((shortcut) => {
    setCustomPayloadHex(shortcut.payload);
    let payload = [];
    if (shortcut.payload.trim().length > 0) {
      const parts = shortcut.payload.trim().split(/\s+/);
      for (const part of parts) {
        const val = parseInt(part, 16);
        if (isNaN(val) || val < 0 || val > 255) {
          // #region agent log
          debugButtonTrace('D', 'MspDashboard.jsx:runShortcut', '快捷指令 hex 无效', {
            name: shortcut.name,
            badByte: part,
            rawPayload: shortcut.payload
          });
          // #endregion
          addLog(`快捷指令十六进制无效: ${part}`, 'error');
          return;
        }
        payload.push(val);
      }
    }
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:runShortcut', `快捷指令按钮「${shortcut.name}」`, {
      name: shortcut.name,
      payloadHex: toHex(payload),
      rawPayload: shortcut.payload
    });
    // #endregion
    if (fixedBoxMode) {
      addLog('固定自动化已打开，快捷指令已禁用', 'warning');
      return;
    }
    sendCmd31Payload(payload, `快捷指令「${shortcut.name}」`);
  }, [addLog, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const sendGimbalPwm = useCallback((pwm, nextLaserOn = laserOn) => {
    if (fixedBoxMode) {
      addLog('固定自动化已打开，云台和激光已禁用', 'warning');
      return;
    }
    const laserPwm = nextLaserOn ? LASER_ON_PWM : LASER_OFF_PWM;
    setGimbalPwm(pwm);
    setLaserOn(nextLaserOn);
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendGimbalPwm', '云台/激光按钮', {
      servoPwm: pwm,
      laserOn: nextLaserOn,
      laserPwm
    });
    // #endregion
    sendCmd31Payload(
      buildGimbalPayload(pwm, laserPwm),
      `云台 ${pwm} μs / 激光${nextLaserOn ? '开' : '关'}`
    );
  }, [addLog, debugButtonTrace, fixedBoxMode, laserOn, sendCmd31Payload]);

  const sendFlightAction = useCallback((kind) => {
    const map = {
      arm: { payload: buildArmPayload(true), label: '解锁' },
      disarm: { payload: buildArmPayload(false), label: '上锁' },
      land: { payload: buildLandPayload(true), label: '开始降落' },
      landCancel: { payload: buildLandPayload(false), label: '取消降落' }
    };
    const action = map[kind];
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendFlightAction', `飞控按钮 kind=${kind}`, {
      kind,
      label: action?.label ?? null,
      payloadHex: action ? toHex(action.payload) : null
    });
    // #endregion
    if (!action) return;
    if (fixedBoxMode && (kind === 'land' || kind === 'landCancel')) {
      addLog('固定自动化已打开，降落指令已禁用', 'warning');
      return;
    }
    const ok = sendCmd31Payload(action.payload, action.label);
    // 机端收到降落 B0 01 会关掉跟踪，本地高亮跟着清掉。
    if (ok && (kind === 'land' || kind === 'disarm')) {
      setTrackingOn(false);
      setFlightFollowOn(false);
      setRangeHoldOn(false);
    }
  }, [addLog, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const sendTrack = useCallback((enabled) => {
    const payload = buildTrackPayload(enabled);
    const label = enabled ? '开始跟踪' : '停止跟踪';
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendTrack', `跟踪按钮 enabled=${enabled}`, {
      enabled,
      label,
      payloadHex: toHex(payload),
      payloadLen: payload.length
    });
    // #endregion
    const ok = sendCmd31Payload(payload, label);
    if (ok) {
      setTrackingOn(enabled);
      // 机端收到 D1 01 会停掉平移跟踪。
      if (enabled) setFlightFollowOn(false);
    }
  }, [debugButtonTrace, sendCmd31Payload]);

  const sendFlightFollow = useCallback((enabled) => {
    if (fixedBoxMode) {
      addLog('固定自动化已打开，平移跟踪不可用。先退出实验箱。', 'warning');
      return;
    }
    const payload = buildFlightFollowPayload(enabled);
    const label = enabled ? '开始平移跟踪' : '停止平移跟踪';
    debugButtonTrace('B', 'MspDashboard.jsx:sendFlightFollow', `平移跟踪 enabled=${enabled}`, {
      enabled,
      label,
      payloadHex: toHex(payload),
      payloadLen: payload.length
    });
    const ok = sendCmd31Payload(payload, label);
    if (ok) {
      setFlightFollowOn(enabled);
      // 机端收到 D3 01 会停掉偏航跟踪。
      if (enabled) setTrackingOn(false);
    }
  }, [addLog, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const sendRangeHold = useCallback((enabled) => {
    if (fixedBoxMode) {
      addLog('固定自动化已打开，后退模式不可用。', 'warning');
      return;
    }
    const payload = buildRangeHoldPayload(enabled);
    const label = enabled ? '开启后退模式' : '关闭后退模式';
    debugButtonTrace('B', 'MspDashboard.jsx:sendRangeHold', `后退模式 enabled=${enabled}`, {
      enabled,
      label,
      payloadHex: toHex(payload),
      payloadLen: payload.length
    });
    const ok = sendCmd31Payload(payload, label);
    if (ok) setRangeHoldOn(enabled);
  }, [addLog, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const sendPosHoriz = useCallback((xCm, yCm, label) => {
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendPosHoriz', '水平位移按钮', { xCm, yCm, label });
    // #endregion
    if (fixedBoxMode) {
      addLog('固定自动化已打开，水平位移已禁用', 'warning');
      return;
    }
    const ok = sendCmd31Payload(buildPosHorizPayload(xCm, yCm), label || `水平位移 (${xCm}, ${yCm}) cm`);
    // 机端收到位移包会关掉后退模式，避免位置环和速度环一起写。
    if (ok) setRangeHoldOn(false);
  }, [addLog, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const sendPosVert = useCallback((altCm, label) => {
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendPosVert', '垂直高度按钮', { altCm, label });
    // #endregion
    if (fixedBoxMode) {
      addLog('固定自动化已打开，高度指令已禁用', 'warning');
      return;
    }
    sendCmd31Payload(buildPosVertPayload(altCm), label || `目标高度 ${altCm} cm`);
  }, [addLog, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const toggleLaser = useCallback(() => {
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:toggleLaser', '激光开关按钮', {
      from: laserOn,
      to: !laserOn,
      servoPwm: gimbalPwm
    });
    // #endregion
    sendGimbalPwm(gimbalPwm, !laserOn);
  }, [debugButtonTrace, gimbalPwm, laserOn, sendGimbalPwm]);

  const sendCustomCommand = useCallback(() => {
    if (fixedBoxMode) {
      addLog('固定自动化已打开，手动指令已禁用', 'warning');
      return;
    }
    let payload = [];
    if (customPayloadHex.trim().length > 0) {
      const parts = customPayloadHex.trim().split(/\s+/);
      for (const part of parts) {
        const val = parseInt(part, 16);
        if (isNaN(val) || val < 0 || val > 255) {
          // #region agent log
          debugButtonTrace('D', 'MspDashboard.jsx:sendCustomCommand', '手动 CMD31 hex 无效', {
            badByte: part,
            rawPayload: customPayloadHex
          });
          // #endregion
          addLog(`十六进制字节无效: ${part}`, 'error');
          return;
        }
        payload.push(val);
      }
    }
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:sendCustomCommand', '发送 CMD 31 按钮', {
      payloadHex: toHex(payload),
      rawPayload: customPayloadHex
    });
    // #endregion
    sendCmd31Payload(payload, '手动 CMD 31');
  }, [addLog, customPayloadHex, debugButtonTrace, fixedBoxMode, sendCmd31Payload]);

  const clearLogs = useCallback(() => {
    // #region agent log
    debugButtonTrace('B', 'MspDashboard.jsx:clearLogs', '清空控制台按钮', { prevLogCount: logs.length });
    // #endregion
    setLogs([]);
  }, [debugButtonTrace, logs.length]);

  // Polls the next command in the list
  const pollNext = useCallback(() => {
    if (!isPollingRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    // Safety timeout to prevent poll loop lockup if a package gets lost
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      currentPollIndex.current = (currentPollIndex.current + 1) % pollCycle.current.length;
      pollNext();
    }, 60); // High-speed fallback timeout (60ms)

    const cmd = pollCycle.current[currentPollIndex.current];
    sendCommand(cmd);
  }, [sendCommand]);

  const handleMessage = useCallback((event) => {
    const arrayBuffer = event.data;
    const frame = parseMSPFrame(arrayBuffer);
    
    if (!frame) return;

    const decoded = decodeMSPPayload(frame.command, frame.payload);

      if (decoded) {
      // --- Side effects outside the updater (updater must be pure) ---
      if (frame.command === MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE) {
        if (decoded.isTrackStatus) {
          setTrackJudge({ ...decoded, receivedAt: Date.now() });
        } else if (decoded.isFlightTrackStatus) {
          setFlightJudge({ ...decoded, receivedAt: Date.now() });
        } else if (decoded.isRangeHoldStatus) {
          setRangeJudge({ ...decoded, receivedAt: Date.now() });
        } else if (decoded.isYolo) {
          if (onYoloBoxUpdate) onYoloBoxUpdate(decoded);
        } else if (decoded.rawHex) {
          addLog(`CMD31 [${decoded.rawHex}]`, 'rx');
        }
      }

      // --- Pure state update ---
      setTelemetry(prev => {
        const nextState = { ...prev };
        
        if (frame.command === MSP_COMMANDS.MSP_STATUS) {
          nextState.armed = decoded.isArmed;
          nextState.cycleTime = decoded.cycleTime;
          nextState.activeSensors = decoded.activeSensors;
        } 
        else if (frame.command === MSP_COMMANDS.MSP_ATTITUDE) {
          nextState.roll = decoded.roll;
          nextState.pitch = decoded.pitch;
          nextState.yaw = decoded.yaw;
        }
        else if (frame.command === MSP_COMMANDS.MSP_ANALOG) {
          nextState.batteryVoltage = decoded.batteryVoltage;
          if (!TEMP_FAKE_AMPERAGE) nextState.amperage = decoded.amperage; // TEMP: skip real current
          nextState.mAhDrawn = decoded.mAhDrawn;
          nextState.rssi = decoded.rssi;
        }
        else if (frame.command === MSP_COMMANDS.MSP_ALTITUDE) {
          nextState.altitudeM = decoded.estimatedAltitude;
          nextState.varioCmS = decoded.varioSpeed;
        }
        else if (frame.command === MSP_COMMANDS.MSP_RAW_GPS) {
          if (!TEMP_FAKE_GPS_FIX) nextState.gpsFix = decoded.gpsFix; // TEMP: skip real fix
          if (!TEMP_FAKE_NUM_SAT) nextState.numSat = decoded.numSat; // TEMP: skip real sat
          nextState.lat = decoded.lat;
          nextState.lon = decoded.lon;
          nextState.gpsAlt = decoded.alt;
        }
        else if (frame.command === MSP_COMMANDS.MSP_RU_VIDEO_INFO) {
          nextState.bitrateKbps = decoded.bitrateKbps;
        }
        else if (frame.command === MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE) {
          if (!decoded.isYolo) {
            nextState.customMessage = decoded.message || '';
            nextState.customLength = decoded.length || 0;
          }
        }

        return nextState;
      });
    }

    // Process the loop immediately after a packet is received to maintain maximum high-speed throughput (up to 300Hz+)
    if (isPollingRef.current && frame.command === pollCycle.current[currentPollIndex.current]) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      currentPollIndex.current = (currentPollIndex.current + 1) % pollCycle.current.length;
      
      // Immediate next poll tick for low-latency telemetry streaming
      setTimeout(pollNext, 0);
    }
  }, [pollNext, onYoloBoxUpdate, addLog]);

  const startPollingLoop = () => {
    isPollingRef.current = true;
    currentPollIndex.current = 0;
    pollNext();
  };

  const stopPollingLoop = () => {
    isPollingRef.current = false;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Reconnect Timer Ref
  const reconnectTimerRef = useRef(null);

  const connect = () => {
    // Clear any pending reconnect timers
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    setErrorMsg('');
    addLog('正在连接 GClient…', 'info');

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setIsConnected(true);
        addLog('WebSocket 已连接', 'success');
        startPollingLoop(); // Automatically start real-time telemetry pull
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        handleMessage(event);
      };

      ws.onclose = (event) => {
        if (wsRef.current !== ws) return;
        setIsConnected(false);
        addLog('WebSocket 已断开，3 秒后重连…', 'warning');
        stopPollingLoop();

        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        if (wsRef.current !== ws) return;
        setErrorMsg('WebSocket 连接错误');
        addLog('WebSocket 连接出错', 'error');
        stopPollingLoop();
      };
    } catch (err) {
      setErrorMsg(err.message || '连接失败');
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connect, 3000);
    }
  };

  const disconnect = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopPollingLoop();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  };

  // Connect to GClient only after video stream is live; disconnect when stream drops
  useEffect(() => {
    if (isStreamActive) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      stopPollingLoop();
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [isStreamActive, wsUrl]);

  // 显示框三行：转向、画面偏差角、机端是否真的调用了速度接口。
  let trackTurnText = '—';
  let trackAngleText = '—';
  let trackSentText = '等待回传';
  if (trackJudge && trackClock - trackJudge.receivedAt > TRACK_JUDGE_STALE_MS) {
    trackSentText = '回传中断';
  } else if (trackJudge && !trackJudge.enabled) {
    trackTurnText = '未开启';
    trackSentText = '未下发';
  } else if (trackJudge && !trackJudge.fresh) {
    trackTurnText = '无人';
    trackSentText = formatTrackCommand(trackJudge.axis, trackJudge.speedCmS, trackJudge.commanded);
  } else if (trackJudge) {
    trackTurnText = trackJudge.turn > 0 ? '右' : trackJudge.turn < 0 ? '左' : '居中';
    trackAngleText = `${formatSigned(viewAngleDeg(trackJudge.errorPx, trackJudge.frameWidth), 1)}°`;
    trackSentText = formatTrackCommand(trackJudge.axis, trackJudge.speedCmS, trackJudge.commanded);
  }

  // 平移跟踪四行：人在画面的左右、上下、两轴偏差、实际下发的 y/z。
  let flightPanText = '—';
  let flightVertText = '—';
  let flightAngleText = '—';
  let flightSentText = '等待回传';
  if (flightJudge && trackClock - flightJudge.receivedAt > TRACK_JUDGE_STALE_MS) {
    flightSentText = '回传中断';
  } else if (flightJudge && !flightJudge.enabled) {
    flightPanText = '未开启';
    flightSentText = '未下发';
  } else if (flightJudge && !flightJudge.fresh) {
    flightPanText = '无人';
    flightSentText = formatFlightCommand(flightJudge.speedYCmS, flightJudge.speedZCmS, flightJudge.commanded);
  } else if (flightJudge) {
    flightPanText = flightJudge.pan > 0 ? '右' : flightJudge.pan < 0 ? '左' : '居中';
    flightVertText = flightJudge.vert > 0 ? '下' : flightJudge.vert < 0 ? '上' : '居中';
    const horizDeg = viewAngleDeg(flightJudge.errorXPx, flightJudge.frameWidth);
    const vertDeg = viewAngleDeg(flightJudge.errorYPx, flightJudge.frameHeight);
    flightAngleText = `水平 ${formatSigned(horizDeg, 1)}° · 垂直 ${formatSigned(vertDeg, 1)}°`;
    flightSentText = formatFlightCommand(flightJudge.speedYCmS, flightJudge.speedZCmS, flightJudge.commanded);
  }

  // 后退模式：框相对按下时记住的边长。偏航和平移共用这一路回传。
  let rangeDirText = '—';
  let rangeSizeText = '—';
  let rangeSentText = '等待回传';
  if (rangeJudge && trackClock - rangeJudge.receivedAt > TRACK_JUDGE_STALE_MS) {
    rangeSentText = '回传中断';
  } else if (rangeJudge && !rangeJudge.enabled) {
    rangeDirText = '未开启';
    rangeSentText = '未下发';
  } else if (rangeJudge && !rangeJudge.hasRef) {
    rangeDirText = '等框';
    rangeSentText = '未记住边长';
  } else if (rangeJudge && !rangeJudge.fresh) {
    rangeDirText = '无人';
    rangeSentText = formatRangeCommand(rangeJudge.speedXCmS, rangeJudge.commanded);
  } else if (rangeJudge) {
    rangeDirText = rangeJudge.sizeErrPx > 16 ? '框变大，后退' : rangeJudge.sizeErrPx < -16 ? '框变小，前进' : '保持';
    rangeSizeText = `${rangeJudge.curPx} / ${rangeJudge.refPx} px`;
    rangeSentText = formatRangeCommand(rangeJudge.speedXCmS, rangeJudge.commanded);
  }

  return (
    <div className="msp-card">
      <div className="card-header">
        <h3>地面站遥测</h3>
        <span className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? 'GCS 链路：在线' : 'GCS 链路：离线'}
        </span>
      </div>



      {errorMsg && <div className="error-alert">{errorMsg}</div>}

      {/* Main Ground Station UI Dashboard */}
      <div className="gcs-dashboard">
        
        {/* Core Status & Arming Banner */}
        <div className="dashboard-row banner-row">
          <div className={`armed-banner ${telemetry.armed.toLowerCase()}`}>
            <span>状态</span>
            <strong>{armedLabel(telemetry.armed)}</strong>
          </div>
          
          <div className="stat-card flex-row">
            <div className="mini-stat">
              <label>传感器</label>
              <span className="sensors-list">{telemetry.activeSensors === 'None' ? '无' : telemetry.activeSensors}</span>
            </div>
          </div>
        </div>

        {/* Telemetry Panels Grid */}
        <div className="gcs-grid">
          
          {/* Panel 1: Flight Dynamics (Attitude) */}
          <div className="gcs-panel">
            <h4>姿态</h4>
            <div className="stat-grid-3x1">
              <div className="metric-box">
                <span className="label">横滚</span>
                <span className="value">{telemetry.roll.toFixed(1)}°</span>
              </div>
              <div className="metric-box">
                <span className="label">俯仰</span>
                <span className="value">{telemetry.pitch.toFixed(1)}°</span>
              </div>
              <div className="metric-box">
                <span className="label">航向</span>
                <span className="value">{telemetry.yaw.toFixed(1)}°</span>
              </div>
            </div>
          </div>

          {/* Panel 2: Downlink Stats */}
          <div className="gcs-panel">
            <h4>图传下行</h4>
            <div className="metric-box full-height-box">
              <span className="label">无线码率</span>
              <span className="value bitrate">{telemetry.bitrateKbps} Kbps</span>
            </div>
          </div>

          {/* Panel 3: Power & Signal */}
          <div className="gcs-panel">
            <h4>电源与信号</h4>
            <div className="stat-grid-3x1">
              <div className="metric-box">
                <span className="label">电压</span>
                <span className="value voltage">{telemetry.batteryVoltage.toFixed(2)} V</span>
              </div>
              <div className="metric-box">
                <span className="label">电流</span>
                <span className="value">{telemetry.amperage.toFixed(2)} A</span>
              </div>
              <div className="metric-box">
                <span className="label">RSSI</span>
                <span className="value rssi">{telemetry.rssi}</span>
              </div>
            </div>
            <div className="panel-footer-stat">已用电量：{telemetry.mAhDrawn} mAh</div>
          </div>

          {/* Panel 4: Altitude & GPS */}
          <div className="gcs-panel">
            <h4>高度与 GPS</h4>
            <div className="stat-grid-3x1">
              <div className="metric-box">
                <span className="label">气压高度</span>
                <span className="value">{telemetry.altitudeM.toFixed(2)} m</span>
              </div>
              <div className="metric-box">
                <span className="label">升降率</span>
                <span className="value">{telemetry.varioCmS} cm/s</span>
              </div>
              <div className="metric-box">
                <span className="label">卫星数</span>
                <span className="value">{telemetry.numSat}</span>
              </div>
            </div>
            <div className="gps-fix-indicator">
              <span className="label">GPS</span>
              {/* TEMP: force 已定位 — remove with TEMP_FAKE_GPS_FIX */}
              <span className={`fix-badge ${
                TEMP_FAKE_GPS_FIX || telemetry.gpsFix === '3D Fix' ? 'fix-3d'
                  : telemetry.gpsFix === '2D Fix' ? 'fix-2d'
                  : 'no-fix'
              }`}>
                {TEMP_FAKE_GPS_FIX ? '已定位' : gpsFixLabel(telemetry.gpsFix)}
              </span>
            </div>
            <div className="panel-footer-stat">
              {telemetry.lat.toFixed(6)}, {telemetry.lon.toFixed(6)} · GPS 高度 {telemetry.gpsAlt} m
            </div>
          </div>

        </div>
      </div>

      {/* 偏航跟踪单独成块，不和飞控解锁/降落混在一排。实机平移不走这里。 */}
      <div className="auto-actions-section fixed-box-section">
        <h4>偏航跟踪</h4>
        <p className="auto-actions-hint">
          按画面水平偏差转偏航。增益 0.6 °/s 每像素，限幅 60 °/s，死区 24 像素。前后用下面共用的「后退模式」。
        </p>
        <div className="auto-group">
          <div className="auto-btn-row">
            <button
              type="button"
              className={`auto-btn track ${trackingOn ? 'active' : ''}`}
              onClick={() => sendTrack(true)}
              title="D1 01（恰好 2 字节）。机端按画面水平偏差转偏航。"
            >
              开始跟踪
            </button>
            <button
              type="button"
              className="auto-btn track-stop"
              onClick={() => sendTrack(false)}
              title="D1 00（恰好 2 字节）"
            >
              停止跟踪
            </button>
            <div
              className="track-judge"
              title="角度是画面水平偏差，半幅记为 90°。下发一行是机端回传的 APMControllerSpeed：x/y 为 cm/s，偏航为 °/s。"
            >
              <span>转向 {trackTurnText}</span>
              <span>角度 {trackAngleText}</span>
              <span>下发 {trackSentText}</span>
            </div>
          </div>
          {fixedBoxMode && (
            <p className="auto-actions-hint">
              位移、高度、降落、云台和手动指令已禁用。跟随行程按万向节中心左右合计 356°。
            </p>
          )}
        </div>
      </div>

      {/* 偏航跟踪和平移跟踪共用。按下时记住框的大小。 */}
      <div className="auto-actions-section flight-track-section">
        <h4>后退模式</h4>
        <p className="auto-actions-hint">
          偏航跟踪和平移跟踪都能用。按下时记住当前行人框的大小。之后框变大就后退，框变小就前进。
          增益 0.5 cm/s 每像素，限幅 25 cm/s，边长差 16 像素以内不动。
        </p>
        <div className="auto-group">
          <div className="auto-btn-row">
            <button
              type="button"
              className={`auto-btn range-hold ${rangeHoldOn ? 'active' : ''}`}
              onClick={() => sendRangeHold(!rangeHoldOn)}
              disabled={fixedBoxMode}
              title="D4 01 开启，D4 00 关闭。机端用行人框等效边长写速度 x。"
            >
              {rangeHoldOn ? '后退模式：开' : '后退模式'}
            </button>
            <div
              className="track-judge flight"
              title="边长是 sqrt(宽×高)。当前 / 按下时记住的边长。x 为负表示按地面站约定后退。"
            >
              <span>方向 {rangeDirText}</span>
              <span>边长 {rangeSizeText}</span>
              <span>下发 {rangeSentText}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 脱离万向节后的平移跟踪。不进固定自动化，也不转偏航。 */}
      <div className="auto-actions-section flight-track-section">
        <h4>AI 飞行跟踪</h4>
        <p className="auto-actions-hint">
          飞机不转头，按画面偏差平移，把人保持在正中。左右走机体系 Y，上下走速度 Z。
          增益 0.5 cm/s 每像素，限幅 25 cm/s，死区 24 像素。前后用上面的后退模式。
          解锁悬停后再开始。
        </p>
        <div className="auto-group">
          <div className="auto-btn-row">
            <button
              type="button"
              className={`auto-btn flight-track ${flightFollowOn ? 'active' : ''}`}
              onClick={() => sendFlightFollow(true)}
              disabled={fixedBoxMode}
              title="D3 01（恰好 2 字节）。人偏右给负 Y，人偏下给正 Z。"
            >
              开始平移跟踪
            </button>
            <button
              type="button"
              className="auto-btn track-stop"
              onClick={() => sendFlightFollow(false)}
              disabled={fixedBoxMode}
              title="D3 00（恰好 2 字节）"
            >
              停止平移跟踪
            </button>
            <div
              className="track-judge flight"
              title="左右、上下是人相对画面中心的位置。下发是机端回传的 y、z，单位 cm/s。正垂直角表示人在画面下方。"
            >
              <span>左右 {flightPanText}</span>
              <span>上下 {flightVertText}</span>
              <span>偏差 {flightAngleText}</span>
              <span>下发 {flightSentText}</span>
            </div>
          </div>
          {fixedBoxMode && (
            <p className="auto-actions-hint">固定自动化开着时不能平移跟踪。先退出实验箱。</p>
          )}
        </div>
      </div>

      {/* Automation Actions — all BroadcastRecv CMD31 capabilities */}
      <div className="auto-actions-section">
        <h4>自动化动作（CMD 31）</h4>
        <p className="auto-actions-hint">
          网页只负责经 GClient 把指令塞进机端 BroadcastRecv；真正执行靠 Extracustom。需先开视频并见「GCS 链路：在线」。
          每次点按钮都会写诊断到下方控制台，并保存到项目 <code>linshi/button-actions.log</code>。
        </p>
        {!isConnected && (
          <div className="auto-offline-banner">
            当前离线：按钮可点，但不会真正下发。请先 Start Stream，等 GCS 在线后再测。
          </div>
        )}

        <div className="auto-group">
          <div className="auto-group-header">
            <span className="shortcuts-label">飞控</span>
          </div>
          <div className="auto-btn-row">
            <button type="button" className="auto-btn arm" onClick={() => sendFlightAction('arm')}>解锁</button>
            <button type="button" className="auto-btn disarm" onClick={() => sendFlightAction('disarm')}>上锁</button>
            <button type="button" className="auto-btn land" onClick={() => sendFlightAction('land')} disabled={fixedBoxMode}>降落</button>
            <button type="button" className="auto-btn land-cancel" onClick={() => sendFlightAction('landCancel')} disabled={fixedBoxMode}>取消降落</button>
          </div>
        </div>

        <div className={`auto-group ${fixedBoxMode ? 'is-locked' : ''}`}>
          <div className="auto-group-header">
            <span className="shortcuts-label">水平位移（D1 · 机体系 XY）</span>
            <label className="auto-inline-field">
              步长
              <input
                type="number"
                min={10}
                max={5000}
                step={10}
                value={posStepCm}
                onChange={(e) => setPosStepCm(Number(e.target.value) || POS_STEP_CM)}
              />
              cm
            </label>
          </div>
          <div className="auto-btn-row">
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => sendPosHoriz(posStepCm, 0, `前进 +X ${posStepCm}cm`)}>↑ 前进</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => sendPosHoriz(-posStepCm, 0, `后退 −X ${posStepCm}cm`)}>↓ 后退</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => sendPosHoriz(0, posStepCm, `左移 +Y ${posStepCm}cm`)}>← 左移</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => sendPosHoriz(0, -posStepCm, `右移 −Y ${posStepCm}cm`)}>→ 右移</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => sendPosHoriz(0, 0, '保持 XY (0,0)')}>保持 XY</button>
          </div>
        </div>

        <div className={`auto-group ${fixedBoxMode ? 'is-locked' : ''}`}>
          <div className="auto-group-header">
            <span className="shortcuts-label">垂直高度（D2）</span>
            <label className="auto-inline-field">
              目标
              <input
                type="number"
                min={0}
                max={10000}
                step={10}
                value={vertAltCm}
                onChange={(e) => setVertAltCm(Number(e.target.value) || 0)}
              />
              cm
            </label>
          </div>
          <div className="auto-btn-row">
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => sendPosVert(vertAltCm)}>去 {vertAltCm} cm</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => { setVertAltCm(100); sendPosVert(100, '目标高度 100 cm'); }}>1 m</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => { setVertAltCm(200); sendPosVert(200, '目标高度 200 cm'); }}>2 m</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => { setVertAltCm(300); sendPosVert(300, '目标高度 300 cm'); }}>3 m</button>
            <button type="button" className="auto-btn" disabled={fixedBoxMode} onClick={() => { setVertAltCm(500); sendPosVert(500, '目标高度 500 cm'); }}>5 m</button>
          </div>
        </div>

        <div className={`auto-group gimbal-temp-section ${fixedBoxMode ? 'is-locked' : ''}`}>
          <div className="gimbal-temp-header">
            <span className="shortcuts-label">云台 + 激光（0xFB）</span>
            <span className="gimbal-pwm-readout">
              {gimbalPwm} μs · 激光{laserOn ? '开' : '关'}
            </span>
          </div>
          <div className="gimbal-temp-buttons">
            {GIMBAL_PWM_PRESETS.map((pwm) => (
              <button
                key={pwm}
                type="button"
                className={`gimbal-btn ${gimbalPwm === pwm ? 'active' : ''}`}
                onClick={() => sendGimbalPwm(pwm)}
                disabled={fixedBoxMode}
                title={`00 FB + 舵机 ${pwm} + 激光 ${laserOn ? LASER_ON_PWM : LASER_OFF_PWM}`}
              >
                {pwm === 1500 ? '中位 1500' : pwm}
              </button>
            ))}
            <button
              type="button"
              className={`gimbal-btn laser-btn ${laserOn ? 'laser-on' : ''}`}
              onClick={toggleLaser}
              disabled={fixedBoxMode}
              title={`激光${laserOn ? '关→1000' : '开→2000'}（附带当前舵机值）`}
            >
              激光{laserOn ? '开' : '关'}
            </button>
          </div>
          <p className="gimbal-temp-hint">
            发送 <code>00 FB + 舵机(LE) + 激光(LE)</code>。机端需已部署含 0xFB 的 Extracustom（本地未提交改动），否则云台无动作。
          </p>
        </div>
      </div>

      {/* Manual Commands & Log Console */}
      <div className="custom-cmd-section">
        <h4>手动自定义消息（CMD 31）</h4>

        {/* Shortcuts List */}
        <div className="shortcut-buttons-list">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="shortcuts-label">快捷指令：</span>
            <button className="btn-clear" onClick={resetShortcuts} style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
              （恢复默认）
            </button>
          </div>
          <div className="shortcut-items">
            {shortcuts.map((sc, i) => (
              <div key={i} className="shortcut-btn-wrapper">
                <button 
                  className="shortcut-btn" 
                  onClick={() => runShortcut(sc)}
                  disabled={fixedBoxMode}
                  title={`载荷: ${sc.payload || '空'}`}
                >
                  {sc.name}
                </button>
                <button 
                  className="shortcut-delete-btn" 
                  onClick={(e) => deleteShortcut(e, sc.name)}
                  title="删除快捷指令"
                >
                  ×
                </button>
              </div>
            ))}
            {shortcuts.length === 0 && (
              <span style={{ fontSize: '0.75rem', color: '#475569', fontStyle: 'italic' }}>
                暂无快捷指令。填写载荷和名称后可保存。
              </span>
            )}
          </div>
        </div>

        <div className="custom-cmd-inputs">
          <div className="input-group" style={{ flex: 2 }}>
            <label>载荷（十六进制，空格分隔）</label>
            <input 
              type="text" 
              value={customPayloadHex} 
              onChange={(e) => setCustomPayloadHex(e.target.value)} 
              placeholder="例如 AA BB CC，可留空"
            />
          </div>

          <div className="input-group" style={{ flex: 1.5 }}>
            <label>快捷名称</label>
            <div className="save-shortcut-group">
              <input 
                type="text" 
                value={newShortcutName} 
                onChange={(e) => setNewShortcutName(e.target.value)} 
                placeholder="保存为…"
              />
              <button 
                className="btn btn-secondary btn-add-shortcut" 
                onClick={saveShortcut}
                title="将当前载荷保存为快捷指令"
              >
                保存
              </button>
            </div>
          </div>

          <button 
            className="btn btn-primary" 
            onClick={sendCustomCommand} 
            disabled={!isConnected || fixedBoxMode}
            style={{ height: '38px', alignSelf: 'flex-end', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            发送 CMD 31
          </button>
        </div>
      </div>

      <div className="log-console">
        <div className="log-header">
          <h4>控制台日志</h4>
          <button className="btn-clear" onClick={clearLogs}>清空</button>
        </div>
        <div className="log-list">
          {logs.map((log, i) => (
            <div key={i} className={`log-item ${log.type}`}>
              <span className="log-time">[{log.time}]</span>
              <span className="log-text">{log.text}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="no-logs">暂无日志，操作记录会出现在这里。</div>}
        </div>
      </div>
    </div>
  );
}
