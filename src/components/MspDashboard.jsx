import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  MSP_COMMANDS, 
  createMSPFrame, 
  parseMSPFrame, 
  decodeMSPPayload, 
  getCommandName 
} from '../utils/mspProtocol';
import './MspDashboard.css';

export function MspDashboard() {
  const [wsUrl, setWsUrl] = useState('ws://192.168.222.1:27015');
  const [isConnected, setIsConnected] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Real-time telemetry database
  const [telemetry, setTelemetry] = useState({
    armed: 'UNKNOWN',
    cycleTime: 0,
    i2cErrorCounter: 0,
    activeSensors: 'None',
    averageSystemLoadPercent: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    bitrateKbps: 0,
    customMessage: '',
    customLength: 0
  });

  // Custom Command Input State
  const [customCmdId, setCustomCmdId] = useState('31');
  const [customPayloadHex, setCustomPayloadHex] = useState('');

  // Polling settings (Sequential poll cycle of actual GClient telemetry)
  const pollCycle = useRef([
    MSP_COMMANDS.MSP_STATUS,
    MSP_COMMANDS.MSP_ATTITUDE,
    MSP_COMMANDS.MSP_RU_VIDEO_INFO,
    MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE
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
    setLogs(prev => [{ time, text, type }, ...prev].slice(0, 50));
  }, []);

  const sendCommand = useCallback((cmdId, payloadBytes = []) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const frame = createMSPFrame(cmdId, payloadBytes);
    wsRef.current.send(frame.buffer);
  }, []);

  // Polls the next command in the list
  const pollNext = useCallback(() => {
    if (!isPollingRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    // Safety timeout to prevent poll loop lockup if a package gets lost
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      currentPollIndex.current = (currentPollIndex.current + 1) % pollCycle.current.length;
      pollNext();
    }, 150); // Timeout fallback

    const cmd = pollCycle.current[currentPollIndex.current];
    sendCommand(cmd);
  }, [sendCommand]);

  const handleMessage = useCallback((event) => {
    const arrayBuffer = event.data;
    const frame = parseMSPFrame(arrayBuffer);
    
    if (!frame) return;

    const decoded = decodeMSPPayload(frame.command, frame.payload);

    if (decoded) {
      setTelemetry(prev => {
        const nextState = { ...prev };
        
        if (frame.command === MSP_COMMANDS.MSP_STATUS) {
          nextState.armed = decoded.isArmed;
          nextState.cycleTime = decoded.cycleTime;
          nextState.i2cErrorCounter = decoded.i2cErrorCounter;
          nextState.activeSensors = decoded.activeSensors;
          nextState.averageSystemLoadPercent = decoded.averageSystemLoadPercent;
        } 
        else if (frame.command === MSP_COMMANDS.MSP_ATTITUDE) {
          nextState.roll = decoded.roll;
          nextState.pitch = decoded.pitch;
          nextState.yaw = decoded.yaw;
        }
        else if (frame.command === MSP_COMMANDS.MSP_RU_VIDEO_INFO) {
          nextState.bitrateKbps = decoded.bitrateKbps;
        }
        else if (frame.command === MSP_COMMANDS.MSP_RU_CUSTOM_MESSAGE) {
          nextState.customMessage = decoded.message || '';
          nextState.customLength = decoded.length || 0;
        }

        return nextState;
      });
    }

    // Process the loop immediately after a packet is received to maintain maximum rate
    if (isPollingRef.current && frame.command === pollCycle.current[currentPollIndex.current]) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      currentPollIndex.current = (currentPollIndex.current + 1) % pollCycle.current.length;
      
      // Speed threshold: 10ms gap to keep a smooth flow and avoid network congestion
      setTimeout(pollNext, 10);
    }
  }, [pollNext]);

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

  const connect = () => {
    disconnect();
    setErrorMsg('');
    addLog(`Connecting to GClient at ${wsUrl}...`, 'info');

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        addLog('WebSocket connection established.', 'success');
        startPollingLoop(); // Automatically start real-time telemetry pull
      };

      ws.onmessage = (event) => {
        handleMessage(event);
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        addLog(`WebSocket connection closed. Code: ${event.code}`, 'warning');
        stopPollingLoop();
      };

      ws.onerror = (err) => {
        setErrorMsg('WebSocket connection error.');
        addLog('WebSocket connection error occurred.', 'error');
        stopPollingLoop();
      };
    } catch (err) {
      setErrorMsg(err.message || 'Connection failed');
    }
  };

  const disconnect = () => {
    stopPollingLoop();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  };

  const sendCustomCommand = () => {
    const cmd = parseInt(customCmdId, 10);
    if (isNaN(cmd)) {
      addLog('Invalid Command ID', 'error');
      return;
    }

    let payload = [];
    if (customPayloadHex.trim().length > 0) {
      const parts = customPayloadHex.trim().split(/\s+/);
      for (const part of parts) {
        const val = parseInt(part, 16);
        if (isNaN(val) || val < 0 || val > 255) {
          addLog(`Invalid payload hex byte: ${part}`, 'error');
          return;
        }
        payload.push(val);
      }
    }

    sendCommand(cmd, payload);
    addLog(`Sent custom command ${cmd} with payload [${payload.join(', ')}]`, 'tx');
  };

  const clearLogs = () => setLogs([]);

  // Destructor cleanup
  useEffect(() => {
    return () => {
      stopPollingLoop();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div className="msp-card">
      <div className="card-header">
        <h3>Ground Station Telemetry</h3>
        <span className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? 'GCS LINK: ONLINE' : 'GCS LINK: OFFLINE'}
        </span>
      </div>

      <div className="connection-settings">
        <div className="input-group">
          <label>GClient WebSocket Server</label>
          <input 
            type="text" 
            value={wsUrl} 
            onChange={(e) => setWsUrl(e.target.value)} 
            disabled={isConnected}
          />
        </div>
        <div className="button-group">
          {!isConnected ? (
            <button className="btn btn-primary" onClick={connect}>Connect GCS</button>
          ) : (
            <button className="btn btn-danger" onClick={disconnect}>Disconnect</button>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-alert">{errorMsg}</div>}

      {/* Main Ground Station UI Dashboard */}
      <div className="gcs-dashboard">
        
        {/* Core Status & Arming Banner */}
        <div className="dashboard-row banner-row">
          <div className={`armed-banner ${telemetry.armed.toLowerCase()}`}>
            <span>STATUS:</span>
            <strong>{telemetry.armed}</strong>
          </div>
          
          <div className="stat-card flex-row">
            <div className="mini-stat">
              <label>CPU Load</label>
              <span>{telemetry.averageSystemLoadPercent}%</span>
            </div>
            <div className="mini-stat">
              <label>I2C Error</label>
              <span>{telemetry.i2cErrorCounter}</span>
            </div>
            <div className="mini-stat">
              <label>Sensors</label>
              <span className="sensors-list">{telemetry.activeSensors}</span>
            </div>
          </div>
        </div>

        {/* Telemetry Panels Grid */}
        <div className="gcs-grid">
          
          {/* Panel 1: Flight Dynamics (Attitude) */}
          <div className="gcs-panel">
            <h4>Attitude</h4>
            <div className="stat-grid-3x1">
              <div className="metric-box">
                <span className="label">Roll</span>
                <span className="value">{telemetry.roll.toFixed(1)}°</span>
              </div>
              <div className="metric-box">
                <span className="label">Pitch</span>
                <span className="value">{telemetry.pitch.toFixed(1)}°</span>
              </div>
              <div className="metric-box">
                <span className="label">Yaw</span>
                <span className="value">{telemetry.yaw.toFixed(1)}°</span>
              </div>
            </div>
          </div>

          {/* Panel 2: Downlink Stats */}
          <div className="gcs-panel">
            <h4>Video Downlink</h4>
            <div className="metric-box full-height-box">
              <span className="label">Wireless Bitrate</span>
              <span className="value bitrate">{telemetry.bitrateKbps} Kbps</span>
            </div>
          </div>

          {/* Panel 3: Custom Message / YOLO BBoxes */}
          <div className="gcs-panel full-width-panel custom-msg-panel">
            <h4>POPPED CUSTOM MESSAGES (FIFO)</h4>
            <div className="custom-msg-display">
              {telemetry.customMessage ? (
                <div className="msg-content">
                  <span className="msg-tag">Length: {telemetry.customLength} B</span>
                  <p className="msg-text">{telemetry.customMessage}</p>
                </div>
              ) : (
                <span className="msg-placeholder">No custom target/YOLO message queued in GClient.</span>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Manual Commands & Log Console */}
      <div className="custom-cmd-section">
        <h4>Manual Overrides</h4>
        <div className="custom-cmd-inputs">
          <div className="input-group">
            <label>CMD ID (Dec)</label>
            <input 
              type="number" 
              value={customCmdId} 
              onChange={(e) => setCustomCmdId(e.target.value)} 
              placeholder="e.g. 101"
            />
          </div>
          <div className="input-group" style={{ flex: 1 }}>
            <label>Payload (Hex Bytes, space separated)</label>
            <input 
              type="text" 
              value={customPayloadHex} 
              onChange={(e) => setCustomPayloadHex(e.target.value)} 
              placeholder="e.g. 00 6C or leave empty"
            />
          </div>
          <button className="btn btn-primary" onClick={sendCustomCommand} disabled={!isConnected}>
            Send Command
          </button>
        </div>
      </div>

      <div className="log-console">
        <div className="log-header">
          <h4>Console Log</h4>
          <button className="btn-clear" onClick={clearLogs}>Clear</button>
        </div>
        <div className="log-list">
          {logs.map((log, i) => (
            <div key={i} className={`log-item ${log.type}`}>
              <span className="log-time">[{log.time}]</span>
              <span className="log-text">{log.text}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="no-logs">Console empty. Actions will be logged here.</div>}
        </div>
      </div>
    </div>
  );
}
