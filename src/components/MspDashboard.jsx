import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  MSP_COMMANDS, 
  createMSPFrame, 
  parseMSPFrame, 
  decodeMSPPayload
} from '../utils/mspProtocol';
import './MspDashboard.css';

// 云台预设
const GIMBAL_PWM_PRESETS = [1000, 1250, 1500, 1750, 2000];
const LASER_OFF_PWM = 1000;
const LASER_ON_PWM = 2000;
const POS_STEP_CM = 100;

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

const buildArmPayload = (arm) => [0xCC, arm ? 0x01 : 0x00];
const buildLandPayload = (start) => [0xB0, start ? 0x01 : 0x00];
const buildTrackPayload = (enabled) => [0xD1, enabled ? 0x01 : 0x00];
const buildFlightFollowPayload = (enabled) => [0xD3, enabled ? 0x01 : 0x00];
const buildRangeHoldPayload = (enabled) => [0xD4, enabled ? 0x01 : 0x00];
const buildPosHorizPayload = (xCm, yCm) => [0xD1, ...i16Le(xCm), ...i16Le(yCm)];
const buildPosVertPayload = (altCm) => [0xD2, ...i16Le(altCm)];

const TRACK_JUDGE_STALE_MS = 1000;

const viewAngleDeg = (errorPx, frameWidth) => {
  const half = Math.max(1, Math.floor(frameWidth / 2));
  const deg = (errorPx * 90) / half;
  return Math.max(-90, Math.min(90, deg));
};

const formatSigned = (n, digits = 0) => {
  const text = digits > 0 ? Number(n).toFixed(digits) : String(Math.round(n));
  return n > 0 ? `+${text}` : text;
};

const formatTrackCommand = (axis, speed, commanded) => {
  if (!commanded) return '未下发';
  if (axis === 2) return `偏航 ${formatSigned(speed)} °/s`;
  const axisName = axis === 1 ? 'y' : 'x';
  return `${axisName} ${formatSigned(speed)} cm/s`;
};

const formatFlightCommand = (speedY, speedZ, commanded) => {
  if (!commanded) return '未下发';
  return `y ${formatSigned(speedY)} · z ${formatSigned(speedZ)} cm/s`;
};

const formatRangeCommand = (speedX, commanded) => {
  if (!commanded) return '未下发';
  return `x ${formatSigned(speedX)} cm/s`;
};

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
  const [activeTab, setActiveTab] = useState('tracking'); // 'tracking' | 'flight' | 'manual'
  
  // 遥测数据
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

  // 控制状态
  const [customPayloadHex, setCustomPayloadHex] = useState('');
  const [newShortcutName, setNewShortcutName] = useState('');
  const [gimbalPwm, setGimbalPwm] = useState(1500);
  const [laserOn, setLaserOn] = useState(false);
  const [posStepCm, setPosStepCm] = useState(POS_STEP_CM);
  const [vertAltCm, setVertAltCm] = useState(200);

  // 跟踪状态
  const [trackingOn, setTrackingOn] = useState(false);
  const [flightFollowOn, setFlightFollowOn] = useState(false);
  const [rangeHoldOn, setRangeHoldOn] = useState(false);

  // 机端跟踪状态回传 (0xFD 0x01 / 0x02 / 0x03)
  const [trackJudge, setTrackJudge] = useState(null);
  const [flightJudge, setFlightJudge] = useState(null);
  const [rangeJudge, setRangeJudge] = useState(null);
  const [trackClock, setTrackClock] = useState(() => Date.now());

  // 快捷指令
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      const saved = localStorage.getItem('msp_shortcuts');
      return saved ? JSON.parse(saved) : DEFAULT_SHORTCUTS;
    } catch {
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

  // 遥测轮询序列
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
  const wsRef = useRef(null);

  // 控制台日志
  const [logs, setLogs] = useState([]);
  const addLog = useCallback((text, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ time, text, type }, ...prev].slice(0, 60));
  }, []);

  const sendCommand = useCallback((cmdId, payloadBytes = []) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame = createMSPFrame(cmdId, payloadBytes);
    ws.send(frame);
    return true;
  }, []);

  const sendCmd31Payload = useCallback((payload, label) => {
    const hexStr = toHex(payload);
    setCustomPayloadHex(hexStr);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addLog(`${label} 未发送：GCS 未连接，请先开启图传`, 'warning');
      return false;
    }

    const ok = sendCommand(31, payload);
    if (ok) {
      addLog(`[下发] ${label} (${hexStr})`, 'tx');
    } else {
      addLog(`${label} 发送失败`, 'error');
    }
    return ok;
  }, [addLog, sendCommand]);

  // 快捷指令操作
  const saveShortcut = useCallback(() => {
    const trimmed = newShortcutName.trim();
    if (!trimmed) return;
    if (shortcuts.find(s => s.name.toLowerCase() === trimmed.toLowerCase())) {
      addLog(`指令「${trimmed}」已存在`, 'warning');
      return;
    }
    setShortcuts(prev => [...prev, { name: trimmed, payload: customPayloadHex }]);
    setNewShortcutName('');
    addLog(`已保存快捷指令「${trimmed}」`, 'success');
  }, [addLog, customPayloadHex, newShortcutName, shortcuts]);

  const deleteShortcut = useCallback((e, name) => {
    e.stopPropagation();
    setShortcuts(prev => prev.filter(s => s.name !== name));
  }, []);

  const runShortcut = useCallback((shortcut) => {
    setCustomPayloadHex(shortcut.payload);
    const parts = shortcut.payload.trim().split(/\s+/).filter(Boolean);
    const bytes = [];
    for (const p of parts) {
      const b = parseInt(p, 16);
      if (isNaN(b) || b < 0 || b > 255) {
        addLog(`无效字节: ${p}`, 'error');
        return;
      }
      bytes.push(b);
    }
    sendCmd31Payload(bytes, `快捷: ${shortcut.name}`);
  }, [addLog, sendCmd31Payload]);

  // 飞控与云台
  const sendFlightAction = useCallback((kind) => {
    const map = {
      arm: { payload: buildArmPayload(true), label: '解锁 (ARM)' },
      disarm: { payload: buildArmPayload(false), label: '上锁 (DISARM)' },
      land: { payload: buildLandPayload(true), label: '降落' },
      landCancel: { payload: buildLandPayload(false), label: '取消降落' }
    };
    const act = map[kind];
    if (!act) return;
    const ok = sendCmd31Payload(act.payload, act.label);
    if (ok && (kind === 'land' || kind === 'disarm')) {
      setTrackingOn(false);
      setFlightFollowOn(false);
      setRangeHoldOn(false);
    }
  }, [sendCmd31Payload]);

  const sendGimbalPwm = useCallback((pwm, nextLaser = laserOn) => {
    const laserPwm = nextLaser ? LASER_ON_PWM : LASER_OFF_PWM;
    setGimbalPwm(pwm);
    setLaserOn(nextLaser);
    sendCmd31Payload(buildGimbalPayload(pwm, laserPwm), `云台 ${pwm}μs 激光${nextLaser ? '开' : '关'}`);
  }, [laserOn, sendCmd31Payload]);

  // 跟踪开关
  const toggleTrack = useCallback((type) => {
    if (type === 'yaw') {
      const next = !trackingOn;
      if (sendCmd31Payload(buildTrackPayload(next), next ? '开始偏航跟踪' : '停止偏航跟踪')) {
        setTrackingOn(next);
        if (next) setFlightFollowOn(false);
      }
    } else if (type === 'flight') {
      const next = !flightFollowOn;
      if (sendCmd31Payload(buildFlightFollowPayload(next), next ? '开始平移跟踪' : '停止平移跟踪')) {
        setFlightFollowOn(next);
        if (next) setTrackingOn(false);
      }
    } else if (type === 'range') {
      const next = !rangeHoldOn;
      if (sendCmd31Payload(buildRangeHoldPayload(next), next ? '开启跟距模式' : '关闭跟距模式')) {
        setRangeHoldOn(next);
      }
    }
  }, [flightFollowOn, rangeHoldOn, sendCmd31Payload, trackingOn]);

  const stopAllTracking = useCallback(() => {
    sendCmd31Payload(buildTrackPayload(false), '停止偏航跟踪');
    sendCmd31Payload(buildFlightFollowPayload(false), '停止平移跟踪');
    sendCmd31Payload(buildRangeHoldPayload(false), '关闭跟距模式');
    setTrackingOn(false);
    setFlightFollowOn(false);
    setRangeHoldOn(false);
  }, [sendCmd31Payload]);

  // 位移与高度
  const sendPosHoriz = useCallback((x, y, label) => {
    if (sendCmd31Payload(buildPosHorizPayload(x, y), label)) {
      setRangeHoldOn(false);
    }
  }, [sendCmd31Payload]);

  const sendPosVert = useCallback((alt, label) => {
    sendCmd31Payload(buildPosVertPayload(alt), label || `定高 ${alt}cm`);
  }, [sendCmd31Payload]);

  // 轮询调度
  const pollNext = useCallback(() => {
    if (!isPollingRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      currentPollIndex.current = (currentPollIndex.current + 1) % pollCycle.current.length;
      pollNext();
    }, 60);

    const cmd = pollCycle.current[currentPollIndex.current];
    sendCommand(cmd);
  }, [sendCommand]);

  const handleMessage = useCallback((event) => {
    const frame = parseMSPFrame(event.data);
    if (!frame) return;

    const decoded = decodeMSPPayload(frame.command, frame.payload);
    if (decoded) {
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
          addLog(`机端CMD31 [${decoded.rawHex}]`, 'rx');
        }
      }

      setTelemetry(prev => {
        const next = { ...prev };
        if (frame.command === MSP_COMMANDS.MSP_STATUS) {
          next.armed = decoded.isArmed;
          next.cycleTime = decoded.cycleTime;
          next.activeSensors = decoded.activeSensors;
        } else if (frame.command === MSP_COMMANDS.MSP_ATTITUDE) {
          next.roll = decoded.roll;
          next.pitch = decoded.pitch;
          next.yaw = decoded.yaw;
        } else if (frame.command === MSP_COMMANDS.MSP_ANALOG) {
          next.batteryVoltage = decoded.batteryVoltage;
          next.amperage = decoded.amperage;
          next.mAhDrawn = decoded.mAhDrawn;
          next.rssi = decoded.rssi;
        } else if (frame.command === MSP_COMMANDS.MSP_ALTITUDE) {
          next.altitudeM = decoded.estimatedAltitude;
          next.varioCmS = decoded.varioSpeed;
        } else if (frame.command === MSP_COMMANDS.MSP_RAW_GPS) {
          next.gpsFix = decoded.gpsFix;
          next.numSat = decoded.numSat;
          next.lat = decoded.lat;
          next.lon = decoded.lon;
          next.gpsAlt = decoded.alt;
        } else if (frame.command === MSP_COMMANDS.MSP_RU_VIDEO_INFO) {
          next.bitrateKbps = decoded.bitrateKbps;
        }
        return next;
      });
    }

    if (isPollingRef.current && frame.command === pollCycle.current[currentPollIndex.current]) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      currentPollIndex.current = (currentPollIndex.current + 1) % pollCycle.current.length;
      setTimeout(pollNext, 0);
    }
  }, [addLog, onYoloBoxUpdate, pollNext]);

  const connect = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setIsConnected(true);
      setErrorMsg('');
      isPollingRef.current = true;
      currentPollIndex.current = 0;
      pollNext();
    };
    ws.onmessage = handleMessage;
    ws.onerror = () => {
      setErrorMsg('GCS 无法连接，正在自动重试…');
      setIsConnected(false);
    };
    ws.onclose = () => {
      setIsConnected(false);
      isPollingRef.current = false;
    };
    wsRef.current = ws;
  }, [handleMessage, pollNext, wsUrl]);

  const disconnect = useCallback(() => {
    isPollingRef.current = false;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (isStreamActive) connect();
    else disconnect();
    return () => disconnect();
  }, [connect, disconnect, isStreamActive]);

  // 状态解析
  const anyTrackActive = trackingOn || flightFollowOn || rangeHoldOn;

  return (
    <div className="msp-card modern-gcs">
      {/* 顶部主状态栏 */}
      <div className="gcs-topbar">
        <div className="topbar-left">
          <div className={`status-pill ${isConnected ? 'online' : 'offline'}`}>
            <span className="dot"></span>
            {isConnected ? 'GCS 链路正常' : 'GCS 离线 (请开视频)'}
          </div>
          <div className={`arm-status-pill ${telemetry.armed === 'ARMED' ? 'armed' : 'disarmed'}`}>
            {telemetry.armed === 'ARMED' ? '已解锁' : '已上锁'}
          </div>
        </div>
        
        {/* 顶部快捷关键飞控条 */}
        <div className="quick-flight-actions">
          <button 
            type="button"
            className="action-pill arm-btn"
            onClick={() => sendFlightAction('arm')}
            disabled={!isConnected}
          >
            解锁
          </button>
          <button 
            type="button"
            className="action-pill disarm-btn"
            onClick={() => sendFlightAction('disarm')}
            disabled={!isConnected}
          >
            上锁
          </button>
          <button 
            type="button"
            className="action-pill land-btn"
            onClick={() => sendFlightAction('land')}
            disabled={!isConnected}
          >
            降落
          </button>
        </div>
      </div>

      {errorMsg && <div className="error-alert">{errorMsg}</div>}

      {/* 核心飞行仪表 HUD */}
      <div className="hud-metric-strip">
        <div className="hud-cell">
          <span className="hud-label">姿态 (滚/俯/航)</span>
          <span className="hud-val">{telemetry.roll.toFixed(0)}° / {telemetry.pitch.toFixed(0)}° / {telemetry.yaw.toFixed(0)}°</span>
        </div>
        <div className="hud-cell">
          <span className="hud-label">高度 / 升降</span>
          <span className="hud-val">{telemetry.altitudeM.toFixed(1)}m <small>({telemetry.varioCmS}cm/s)</small></span>
        </div>
        <div className="hud-cell">
          <span className="hud-label">电源</span>
          <span className="hud-val highlight-green">{telemetry.batteryVoltage.toFixed(1)}V <small>({telemetry.amperage.toFixed(1)}A)</small></span>
        </div>
        <div className="hud-cell">
          <span className="hud-label">GPS / 星数</span>
          <span className="hud-val">{gpsFixLabel(telemetry.gpsFix)} ({telemetry.numSat}星)</span>
        </div>
      </div>

      {/* 工作区标签切换导航 */}
      <div className="workspace-tabs">
        <button 
          type="button"
          className={`tab-btn ${activeTab === 'tracking' ? 'active' : ''}`}
          onClick={() => setActiveTab('tracking')}
        >
          AI 智能跟踪 {anyTrackActive && <span className="tab-dot-active"></span>}
        </button>
        <button 
          type="button"
          className={`tab-btn ${activeTab === 'flight' ? 'active' : ''}`}
          onClick={() => setActiveTab('flight')}
        >
          导航与云台
        </button>
        <button 
          type="button"
          className={`tab-btn ${activeTab === 'manual' ? 'active' : ''}`}
          onClick={() => setActiveTab('manual')}
        >
          调试与控制台
        </button>
      </div>

      {/* 标签区 1: AI 智能跟踪 */}
      {activeTab === 'tracking' && (
        <div className="tab-pane tracking-pane">
          <div className="track-controls-grid">
            {/* 跟踪模式选择 */}
            <div className="card-sub-block">
              <div className="sub-title">主跟踪模式 (互斥)</div>
              <div className="track-btn-group">
                <button
                  type="button"
                  className={`track-mode-btn ${trackingOn ? 'active' : ''}`}
                  onClick={() => toggleTrack('yaw')}
                  disabled={!isConnected}
                >
                  <div className="text-wrap">
                    <strong>偏航跟踪 (D1)</strong>
                    <small>机身自转对准目标</small>
                  </div>
                </button>

                <button
                  type="button"
                  className={`track-mode-btn ${flightFollowOn ? 'active' : ''}`}
                  onClick={() => toggleTrack('flight')}
                  disabled={!isConnected}
                >
                  <div className="text-wrap">
                    <strong>平移跟踪 (D3)</strong>
                    <small>机身左右上下平移跟人</small>
                  </div>
                </button>
              </div>
            </div>

            {/* 辅助功能与急停 */}
            <div className="card-sub-block">
              <div className="sub-title">辅助与急停</div>
              <div className="track-btn-group">
                <button
                  type="button"
                  className={`track-mode-btn auxiliary ${rangeHoldOn ? 'active' : ''}`}
                  onClick={() => toggleTrack('range')}
                  disabled={!isConnected}
                >
                  <div className="text-wrap">
                    <strong>后退/定距模式 (D4)</strong>
                    <small>{rangeHoldOn ? '已开启保持距离' : '关闭'}</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="track-mode-btn stop-all"
                  onClick={stopAllTracking}
                  disabled={!anyTrackActive}
                >
                  <div className="text-wrap">
                    <strong>停止所有跟踪</strong>
                    <small>清零跟踪速度指令</small>
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* 实时机端跟踪状态监控卡片 */}
          <div className="track-feedback-card">
            <div className="feedback-header">
              <span>机端跟踪实时回传监控</span>
              <span className={`status-indicator ${anyTrackActive ? 'active' : 'idle'}`}>
                {anyTrackActive ? '跟踪控制运行中' : '跟踪待机'}
              </span>
            </div>

            <div className="feedback-grid">
              <div className="feedback-cell">
                <span className="label">偏航对准</span>
                <span className="val">
                  {!trackingOn ? '未开启' 
                    : (trackJudge && trackClock - trackJudge.receivedAt < TRACK_JUDGE_STALE_MS) 
                      ? (trackJudge.turn > 0 ? '偏右' : trackJudge.turn < 0 ? '偏左' : '居中') 
                      : '等待回传…'}
                </span>
                <small className="sub-val">
                  {trackingOn && trackJudge && trackClock - trackJudge.receivedAt < TRACK_JUDGE_STALE_MS
                    ? `偏差角 ${formatSigned(viewAngleDeg(trackJudge.errorPx, trackJudge.frameWidth), 1)}°`
                    : '—'}
                </small>
              </div>

              <div className="feedback-cell">
                <span className="label">平移对准</span>
                <span className="val">
                  {!flightFollowOn ? '未开启' 
                    : (flightJudge && trackClock - flightJudge.receivedAt < TRACK_JUDGE_STALE_MS) 
                      ? `水平: ${flightJudge.pan > 0 ? '右' : flightJudge.pan < 0 ? '左' : '中'} · 垂直: ${flightJudge.vert > 0 ? '下' : flightJudge.vert < 0 ? '上' : '中'}` 
                      : '等待回传…'}
                </span>
                <small className="sub-val">
                  {flightFollowOn && flightJudge && trackClock - flightJudge.receivedAt < TRACK_JUDGE_STALE_MS
                    ? formatFlightCommand(flightJudge.speedYCmS, flightJudge.speedZCmS, flightJudge.commanded)
                    : '—'}
                </small>
              </div>

              <div className="feedback-cell">
                <span className="label">跟距判断</span>
                <span className="val">
                  {!rangeHoldOn ? '未开启' 
                    : (rangeJudge && trackClock - rangeJudge.receivedAt < TRACK_JUDGE_STALE_MS) 
                      ? (rangeJudge.sizeErrPx > 16 ? '目标靠近，后退' : rangeJudge.sizeErrPx < -16 ? '目标远离，前进' : '距离保持良好') 
                      : '等待回传…'}
                </span>
                <small className="sub-val">
                  {rangeHoldOn && rangeJudge && trackClock - rangeJudge.receivedAt < TRACK_JUDGE_STALE_MS
                    ? `框: ${rangeJudge.curPx}px (基准 ${rangeJudge.refPx}px)`
                    : '—'}
                </small>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 标签区 2: 导航与云台 */}
      {activeTab === 'flight' && (
        <div className="tab-pane flight-pane">
          <div className="flight-grid-layout">
            {/* 水平微调罗盘 */}
            <div className="card-sub-block dpad-block">
              <div className="sub-title-row">
                <span>机体系水平相对位移 (D1)</span>
                <div className="inline-step">
                  <span>步长</span>
                  <input 
                    type="number" 
                    value={posStepCm} 
                    onChange={e => setPosStepCm(Number(e.target.value) || 100)} 
                    step={10} min={10} max={2000}
                  />
                  <span>cm</span>
                </div>
              </div>

              <div className="dpad-container">
                <button type="button" className="dpad-btn up" onClick={() => sendPosHoriz(posStepCm, 0, `前进 ${posStepCm}cm`)}>
                  ↑ 前进
                </button>
                <div className="dpad-mid-row">
                  <button type="button" className="dpad-btn left" onClick={() => sendPosHoriz(0, posStepCm, `左移 ${posStepCm}cm`)}>
                    ← 左移
                  </button>
                  <button type="button" className="dpad-btn center" onClick={() => sendPosHoriz(0, 0, '保持 XY (0,0)')}>
                    保持
                  </button>
                  <button type="button" className="dpad-btn right" onClick={() => sendPosHoriz(0, -posStepCm, `右移 ${posStepCm}cm`)}>
                    右移 →
                  </button>
                </div>
                <button type="button" className="dpad-btn down" onClick={() => sendPosHoriz(-posStepCm, 0, `后退 ${posStepCm}cm`)}>
                  ↓ 后退
                </button>
              </div>
            </div>

            {/* 高度控制与云台 */}
            <div className="card-sub-block right-ctrls">
              {/* 高度 */}
              <div className="sub-title-row">
                <span>目标垂直定高 (D2)</span>
                <div className="inline-step">
                  <input 
                    type="number" 
                    value={vertAltCm} 
                    onChange={e => setVertAltCm(Number(e.target.value) || 0)} 
                    step={10} min={0} max={5000}
                  />
                  <span>cm</span>
                  <button type="button" className="btn-small-send" onClick={() => sendPosVert(vertAltCm)}>前往</button>
                </div>
              </div>
              <div className="quick-alt-row">
                {[100, 200, 300, 500].map(h => (
                  <button key={h} type="button" className="alt-chip" onClick={() => { setVertAltCm(h); sendPosVert(h, `定高 ${h}cm`); }}>
                    {h / 100}米
                  </button>
                ))}
              </div>

              {/* 云台与激光 */}
              <div className="sub-title-row mt-12">
                <span>云台俯仰与激光 (0xFB)</span>
                <span className="gimbal-status-text">{gimbalPwm}μs · 激光{laserOn ? '开' : '关'}</span>
              </div>
              <div className="gimbal-btn-bar">
                {GIMBAL_PWM_PRESETS.map(pwm => (
                  <button 
                    key={pwm} 
                    type="button" 
                    className={`gimbal-chip ${gimbalPwm === pwm ? 'active' : ''}`}
                    onClick={() => sendGimbalPwm(pwm)}
                  >
                    {pwm === 1500 ? '中位' : `${pwm}`}
                  </button>
                ))}
                <button 
                  type="button" 
                  className={`gimbal-chip laser-toggle ${laserOn ? 'laser-active' : ''}`}
                  onClick={() => sendGimbalPwm(gimbalPwm, !laserOn)}
                >
                  激光{laserOn ? '关' : '开'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 标签区 3: 调试与控制台 */}
      {activeTab === 'manual' && (
        <div className="tab-pane manual-pane">
          {/* 快捷指令 */}
          <div className="card-sub-block">
            <div className="sub-title-row">
              <span>快捷指令集</span>
              <button className="btn-clear" onClick={() => setShortcuts(DEFAULT_SHORTCUTS)}>恢复默认</button>
            </div>
            <div className="shortcut-chips">
              {shortcuts.map((sc, i) => (
                <div key={i} className="shortcut-pill">
                  <span className="sc-name" onClick={() => runShortcut(sc)}>{sc.name}</span>
                  <span className="sc-del" onClick={(e) => deleteShortcut(e, sc.name)}>×</span>
                </div>
              ))}
            </div>
          </div>

          {/* 手动下发 */}
          <div className="manual-send-row">
            <input 
              type="text" 
              className="hex-input"
              value={customPayloadHex} 
              onChange={e => setCustomPayloadHex(e.target.value)} 
              placeholder="载荷十六进制 (例如 CC 01 或 D1 64 00 00 00)"
            />
            <input 
              type="text" 
              className="name-input"
              value={newShortcutName} 
              onChange={e => setNewShortcutName(e.target.value)} 
              placeholder="快捷名称"
            />
            <button type="button" className="btn btn-secondary" onClick={saveShortcut}>保存</button>
            <button type="button" className="btn btn-primary" onClick={() => {
              const parts = customPayloadHex.trim().split(/\s+/).filter(Boolean);
              const bytes = parts.map(p => parseInt(p, 16)).filter(b => !isNaN(b));
              sendCmd31Payload(bytes, '手动 CMD 31');
            }}>发送</button>
          </div>

          {/* 控制台输出 */}
          <div className="log-console-wrap">
            <div className="log-header">
              <span>实时指令与通信日志</span>
              <button className="btn-clear" onClick={() => setLogs([])}>清空日志</button>
            </div>
            <div className="log-list">
              {logs.map((log, i) => (
                <div key={i} className={`log-line ${log.type}`}>
                  <span className="time">[{log.time}]</span>
                  <span className="text">{log.text}</span>
                </div>
              ))}
              {logs.length === 0 && <div className="no-logs">暂无通信日志</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
