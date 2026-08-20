import React, { useEffect, useRef, useState } from 'react';
import './VideoPlayer.css';

export function VideoPlayer({ yoloBox, onRtspConnected, deviceIp, onChangeDeviceIp }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const playerRef = useRef(null);

  const rtspUrl = `rtsp://${deviceIp}:554/live`;
  const proxyUrl = 'ws://localhost:9999';
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFlipped, setIsFlipped] = useState(true); // Default to true (corrects upside down feed)
  const [status, setStatus] = useState('Idle'); // Idle, Connecting, Playing, Error
  const [errorMsg, setErrorMsg] = useState('');

  // Load JSMpeg dynamically
  const [jsmpegLoaded, setJsmpegLoaded] = useState(false);

  useEffect(() => {
    if (window.JSMpeg) {
      setJsmpegLoaded(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg/jsmpeg.min.js';
    script.async = true;
    script.onload = () => setJsmpegLoaded(true);
    script.onerror = () => {
      setStatus('Error');
      setErrorMsg('Failed to load JSMpeg player library from CDN.');
    };
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  const handleStartStream = () => {
    if (!jsmpegLoaded) return;
    handleStopStream();

    setStatus('Connecting');
    setErrorMsg('');
    
    try {
      // Connect to rtsp-proxy WebSocket server, passing the target RTSP URL as a query param
      const wsUrl = `${proxyUrl}/?url=${encodeURIComponent(rtspUrl)}`;
      
      // Initialize JSMpeg Player
      playerRef.current = new window.JSMpeg.Player(wsUrl, {
        canvas: canvasRef.current,
        autoplay: true,
        audio: false,
        onSourceEstablished: () => {
          setStatus('Playing');
          setIsPlaying(true);
        },
        onSourceCompleted: () => {
          setStatus('Idle');
          setIsPlaying(false);
        },
        onVideoDecode: () => {
          if (status !== 'Playing') {
            setStatus('Playing');
            setIsPlaying(true);
          }
        }
      });
    } catch (err) {
      setStatus('Error');
      setErrorMsg(err.message || 'Error starting JSMpeg player');
    }
  };

  const handleStopStream = () => {
    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch (e) {
        console.error('Error destroying JSMpeg player:', e);
      }
      playerRef.current = null;
    }
    // Clear overlay drawings
    if (overlayRef.current) {
      const ctx = overlayRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
    }
    setIsPlaying(false);
    setStatus('Idle');
  };

  // Target cache to prevent flickering and support multiple persistent targets
  const targetsRef = useRef(new Map());
  const animFrameRef = useRef(null);
  const [personOnly, setPersonOnly] = useState(true);

  // Update target tracking cache when new YOLO detections arrive
  useEffect(() => {
    if (!yoloBox) return;
    const now = Date.now();
    const detections = Array.isArray(yoloBox) ? yoloBox : [yoloBox];

    detections.forEach((box) => {
      if (!box || box.x1 === undefined) return;
      
      // Filter: Only identify person (COCO Class 0)
      const cid = box.classId !== undefined ? box.classId : 0;
      if (personOnly && cid !== 0) return;

      const key = box.trackId !== undefined ? box.trackId : (box.targetId !== undefined ? box.targetId : (box.id !== undefined ? box.id : 1));
      targetsRef.current.set(key, {
        ...box,
        lastSeen: now
      });
    });
  }, [yoloBox, personOnly]);

  // Smooth flicker-free 60fps render loop for canvas overlay
  useEffect(() => {
    if (!isPlaying) {
      if (overlayRef.current) {
        const ctx = overlayRef.current.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
      }
      targetsRef.current.clear();
      return;
    }

    let isRunning = true;

    const renderLoop = () => {
      if (!isRunning) return;

      const overlay = overlayRef.current;
      const videoCanvas = canvasRef.current;

      if (overlay && videoCanvas && videoCanvas.width > 0 && videoCanvas.height > 0) {
        if (overlay.width !== videoCanvas.width || overlay.height !== videoCanvas.height) {
          overlay.width = videoCanvas.width;
          overlay.height = videoCanvas.height;
        }

        const ctx = overlay.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, overlay.width, overlay.height);

          const now = Date.now();
          const MAX_AGE_MS = 100; // Limit to ~3 frames (~100ms) to aggregate scattered packets without trailing

          targetsRef.current.forEach((box, key) => {
            const age = now - box.lastSeen;
            if (age > MAX_AGE_MS) {
              targetsRef.current.delete(key);
              return;
            }

            const { x1, y1, x2, y2, trackId, classId, id, targetId, confidence } = box;
            const drawX1 = !isFlipped ? (overlay.width - x2) : x1;
            const drawX2 = !isFlipped ? (overlay.width - x1) : x2;
            const drawY1 = !isFlipped ? (overlay.height - y2) : y1;
            const drawY2 = !isFlipped ? (overlay.height - y1) : y2;

            ctx.strokeStyle = '#10b981'; // Emerald-500
            ctx.lineWidth = 3;
            ctx.strokeRect(drawX1, drawY1, drawX2 - drawX1, drawY2 - drawY1);

            // Draw label banner background
            const tid = trackId !== undefined ? trackId : (targetId !== undefined ? targetId : (id !== undefined ? id : 1));
            const cid = classId !== undefined ? classId : 0;
            const conf = confidence !== undefined ? (confidence > 1 ? confidence : Math.round(confidence * 100)) : 0;
            const text = cid === 0 ? `Person #${tid} (${conf}%)` : `Class ${cid} #${tid} (${conf}%)`;

            ctx.font = 'bold 12px monospace';
            const textWidth = ctx.measureText(text).width;
            ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
            ctx.fillRect(drawX1, Math.max(0, drawY1 - 20), textWidth + 10, 20);

            // Draw label text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, drawX1 + 5, Math.max(14, drawY1 - 5));
          });
        }
      }

      animFrameRef.current = requestAnimationFrame(renderLoop);
    };

    animFrameRef.current = requestAnimationFrame(renderLoop);

    return () => {
      isRunning = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying, isFlipped]);

  // Notify parent component when RTSP stream status changes
  useEffect(() => {
    if (onRtspConnected) onRtspConnected(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      handleStopStream();
    };
  }, []);

  return (
    <div className="video-card">
      <div className="card-header">
        <h3>Live RTSP Video Stream</h3>
        <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>
      </div>

      <div className="stream-settings">
        <div className="input-group">
          <label>Device IP</label>
          <input 
            type="text" 
            value={deviceIp} 
            onChange={(e) => onChangeDeviceIp(e.target.value)} 
            placeholder="e.g. 192.168.223.1"
          />
        </div>
        <div className="button-group horizontal-buttons">
          <button 
            className={`btn ${personOnly ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPersonOnly(!personOnly)}
            title="Filter to only detect person (Class 0)"
            style={{ fontSize: '0.8rem', padding: '6px 12px' }}
          >
            {personOnly ? 'Filter: Person Only' : 'Filter: All Classes'}
          </button>
          <button 
            className={`btn ${isFlipped ? 'btn-warning' : 'btn-secondary'}`}
            onClick={() => setIsFlipped(!isFlipped)}
            title="Toggle Vertical Mirroring (Upside Down)"
          >
            {isFlipped ? 'Normal View' : 'Flip Vertical'}
          </button>
          {!isPlaying ? (
            <button 
              className="btn btn-primary" 
              onClick={handleStartStream}
              disabled={!jsmpegLoaded}
            >
              Start Stream
            </button>
          ) : (
            <button className="btn btn-danger" onClick={handleStopStream}>
              Stop Stream
            </button>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-alert">{errorMsg}</div>}

      <div className={`canvas-wrapper ${isFlipped ? 'flipped-vertical' : ''}`}>
        <canvas ref={canvasRef} className="video-canvas" id="rtsp-canvas"></canvas>
        {isPlaying && (
          <canvas ref={overlayRef} className="yolo-overlay-canvas"></canvas>
        )}
        {!isPlaying && (
          <div className="canvas-placeholder">
            <span>Video Stream Offline</span>
            <p>Click "Start Stream" to connect to the RTSP proxy</p>
          </div>
        )}
      </div>
    </div>
  );
}
