import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  MSP_COMMANDS, 
  createMSPFrame, 
  parseMSPFrame, 
  decodeMSPPayload, 
  getCommandName 
} from '../utils/mspProtocol';
import './MspDashboard.css';

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
    customLength: 0
  });

  // Custom Command Input State
  const [customPayloadHex, setCustomPayloadHex] = useState('');
  const [newShortcutName, setNewShortcutName] = useState('');
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      const saved = localStorage.getItem('msp_shortcuts');
      return saved ? JSON.parse(saved) : [
        { name: 'DISARM', payload: 'CC 01' },
        { name: 'ARM', payload: 'CC 00' },
        { name: 'LAND', payload: 'B0 01' }
      ];
    } catch (e) {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('msp_shortcuts', JSON.stringify(shortcuts));
    } catch (e) {
      console.error('Failed to save shortcuts:', e);
    }
  }, [shortcuts]);

  const saveShortcut = () => {
    const trimmedName = newShortcutName.trim();
    if (!trimmedName) {
      addLog('Please enter a shortcut name', 'warning');
      return;
    }
    const duplicate = shortcuts.find(s => s.name.trim().toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
      addLog(`Shortcut named "${trimmedName}" already exists.`, 'warning');
      return;
    }
    const newShortcuts = [...shortcuts, { name: trimmedName, payload: customPayloadHex }];
    setShortcuts(newShortcuts);
    setNewShortcutName('');
    addLog(`Saved shortcut "${trimmedName}" with payload: ${customPayloadHex || '(empty)'}`, 'success');
  };

  const deleteShortcut = (e, nameToDelete) => {
    e.stopPropagation();
    const newShortcuts = shortcuts.filter(s => s.name !== nameToDelete);
    setShortcuts(newShortcuts);
    addLog(`Deleted shortcut "${nameToDelete}"`, 'info');
  };

  const resetShortcuts = () => {
    const defaults = [
      { name: 'DISARM', payload: 'CC 01' },
      { name: 'ARM', payload: 'CC 00' },
      { name: 'LAND', payload: 'B0 01' }
    ];
    setShortcuts(defaults);
    addLog('Reset shortcuts to defaults', 'info');
  };

  const runShortcut = (shortcut) => {
    setCustomPayloadHex(shortcut.payload);
    
    let payload = [];
    if (shortcut.payload.trim().length > 0) {
      const parts = shortcut.payload.trim().split(/\s+/);
      for (const part of parts) {
        const val = parseInt(part, 16);
        if (isNaN(val) || val < 0 || val > 255) {
          addLog(`Invalid payload hex byte in shortcut: ${part}`, 'error');
          return;
        }
        payload.push(val);
      }
    }

    if (isConnected) {
      sendCommand(31, payload);
      const hexStr = payload.map(x => '0x' + x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      addLog(`Sent Shortcut "${shortcut.name}" (CMD 31): [${hexStr}]`, 'tx');
    } else {
      addLog(`Selected Shortcut "${shortcut.name}". Connect to send.`, 'info');
    }
  };

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
        if (decoded.isYolo) {
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
          nextState.amperage = decoded.amperage;
          nextState.mAhDrawn = decoded.mAhDrawn;
          nextState.rssi = decoded.rssi;
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
    addLog('Connecting to GClient...', 'info');

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setIsConnected(true);
        addLog('WebSocket connection established.', 'success');
        startPollingLoop(); // Automatically start real-time telemetry pull
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        handleMessage(event);
      };

      ws.onclose = (event) => {
        if (wsRef.current !== ws) return;
        setIsConnected(false);
        addLog(`WebSocket connection closed. Reconnecting in 3s...`, 'warning');
        stopPollingLoop();

        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        if (wsRef.current !== ws) return;
        setErrorMsg('WebSocket connection error.');
        addLog('WebSocket connection error occurred.', 'error');
        stopPollingLoop();
      };
    } catch (err) {
      setErrorMsg(err.message || 'Connection failed');
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

  const sendCustomCommand = () => {
    const cmd = 31; // MSP_RU_CUSTOM_MESSAGE

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
    const hexStr = payload.map(x => '0x' + x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    addLog(`Sent CMD 31 with payload: [${hexStr}]`, 'tx');
  };

  const clearLogs = () => setLogs([]);

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

  return (
    <div className="msp-card">
      <div className="card-header">
        <h3>Ground Station Telemetry</h3>
        <span className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? 'GCS LINK: ONLINE' : 'GCS LINK: OFFLINE'}
        </span>
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

          {/* Panel 3: Power & Signal */}
          <div className="gcs-panel full-width-panel">
            <h4>Power & Signal</h4>
            <div className="stat-grid-3x1">
              <div className="metric-box">
                <span className="label">Voltage</span>
                <span className="value voltage">{telemetry.batteryVoltage.toFixed(2)} V</span>
              </div>
              <div className="metric-box">
                <span className="label">Current</span>
                <span className="value">{telemetry.amperage.toFixed(2)} A</span>
              </div>
              <div className="metric-box">
                <span className="label">RSSI</span>
                <span className="value rssi">{telemetry.rssi}</span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Manual Commands & Log Console */}
      <div className="custom-cmd-section">
        <h4>Manual Custom Message (CMD 31)</h4>

        {/* Shortcuts List */}
        <div className="shortcut-buttons-list">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="shortcuts-label">Shortcuts:</span>
            <button className="btn-clear" onClick={resetShortcuts} style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
              (Reset Defaults)
            </button>
          </div>
          <div className="shortcut-items">
            {shortcuts.map((sc, i) => (
              <div key={i} className="shortcut-btn-wrapper">
                <button 
                  className="shortcut-btn" 
                  onClick={() => runShortcut(sc)}
                  title={`Payload: ${sc.payload || 'empty'}`}
                >
                  {sc.name}
                </button>
                <button 
                  className="shortcut-delete-btn" 
                  onClick={(e) => deleteShortcut(e, sc.name)}
                  title="Delete shortcut"
                >
                  ×
                </button>
              </div>
            ))}
            {shortcuts.length === 0 && (
              <span style={{ fontSize: '0.75rem', color: '#475569', fontStyle: 'italic' }}>
                No shortcuts saved. Type payload and name to save one.
              </span>
            )}
          </div>
        </div>

        <div className="custom-cmd-inputs">
          <div className="input-group" style={{ flex: 2 }}>
            <label>Payload (Hex Bytes, space separated)</label>
            <input 
              type="text" 
              value={customPayloadHex} 
              onChange={(e) => setCustomPayloadHex(e.target.value)} 
              placeholder="e.g. AA BB CC or leave empty"
            />
          </div>

          <div className="input-group" style={{ flex: 1.5 }}>
            <label>Shortcut Name</label>
            <div className="save-shortcut-group">
              <input 
                type="text" 
                value={newShortcutName} 
                onChange={(e) => setNewShortcutName(e.target.value)} 
                placeholder="Save as..."
              />
              <button 
                className="btn btn-secondary btn-add-shortcut" 
                onClick={saveShortcut}
                title="Save current payload as shortcut"
              >
                Save
              </button>
            </div>
          </div>

          <button 
            className="btn btn-primary" 
            onClick={sendCustomCommand} 
            disabled={!isConnected}
            style={{ height: '38px', alignSelf: 'flex-end', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            Send CMD 31
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
