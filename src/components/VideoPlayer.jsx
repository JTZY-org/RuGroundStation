import React, { useEffect, useRef, useState } from 'react';
import './VideoPlayer.css';

export function VideoPlayer({ yoloBox, onRtspConnected, defaultRtspUrl = 'rtsp://192.168.222.1:554/live' }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const playerRef = useRef(null);
  const clearTimerRef = useRef(null);

  const [rtspUrl, setRtspUrl] = useState(defaultRtspUrl);
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

  useEffect(() => {
    if (!yoloBox || !isPlaying || !overlayRef.current || !canvasRef.current) return;
    
    // Filter: only display target with ID 1
    if (yoloBox.targetId !== 1) return;

    const overlay = overlayRef.current;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    // Sync resolution to match the video canvas
    overlay.width = canvasRef.current.width;
    overlay.height = canvasRef.current.height;

    // Clear previous drawings
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Draw Bounding Box
    ctx.strokeStyle = '#10b981'; // Tailwind emerald-500
    ctx.lineWidth = 3;
    const { x1, y1, x2, y2, targetId, confidence } = yoloBox;
    
    // Map coordinates:
    // Since YOLO coordinates are already right-side up, they align with the corrected (isFlipped=true) video.
    // So if isFlipped is true, we draw them directly. If isFlipped is false (upside-down video), we rotate them.
    const drawX1 = !isFlipped ? (overlay.width - x2) : x1;
    const drawX2 = !isFlipped ? (overlay.width - x1) : x2;
    const drawY1 = !isFlipped ? (overlay.height - y2) : y1;
    const drawY2 = !isFlipped ? (overlay.height - y1) : y2;

    ctx.strokeRect(drawX1, drawY1, drawX2 - drawX1, drawY2 - drawY1);

    // Draw text label banner background
    ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
    const text = `ID: ${targetId} (${confidence}%)`;
    ctx.font = 'bold 12px monospace';
    const textWidth = ctx.measureText(text).width;
    ctx.fillRect(drawX1, drawY1 - 20, textWidth + 10, 20);

    // Draw label text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, drawX1 + 5, drawY1 - 5);

    // Clear timeout setup
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      if (overlayRef.current) {
        const c = overlayRef.current;
        const cx = c.getContext('2d');
        if (cx) cx.clearRect(0, 0, c.width, c.height);
      }
    }, 150);

  }, [yoloBox, isPlaying, isFlipped]);

  // Notify parent component when RTSP stream status changes
  useEffect(() => {
    if (onRtspConnected) onRtspConnected(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      handleStopStream();
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
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
          <label>RTSP URL</label>
          <input 
            type="text" 
            value={rtspUrl} 
            onChange={(e) => setRtspUrl(e.target.value)} 
            placeholder="rtsp://..."
          />
        </div>
        <div className="button-group horizontal-buttons">
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
