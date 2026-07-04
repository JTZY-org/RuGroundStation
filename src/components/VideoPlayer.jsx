import React, { useEffect, useRef, useState } from 'react';
import './VideoPlayer.css';

export function VideoPlayer({ defaultRtspUrl = 'rtsp://192.168.222.1:554/live' }) {
  const canvasRef = useRef(null);
  const playerRef = useRef(null);
  const [rtspUrl, setRtspUrl] = useState(defaultRtspUrl);
  const [proxyUrl, setProxyUrl] = useState('ws://localhost:9999');
  const [isPlaying, setIsPlaying] = useState(false);
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
    setIsPlaying(false);
    setStatus('Idle');
  };

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
          <label>RTSP URL</label>
          <input 
            type="text" 
            value={rtspUrl} 
            onChange={(e) => setRtspUrl(e.target.value)} 
            placeholder="rtsp://..."
          />
        </div>
        <div className="input-group">
          <label>Proxy WS Port</label>
          <input 
            type="text" 
            value={proxyUrl} 
            onChange={(e) => setProxyUrl(e.target.value)} 
            placeholder="ws://localhost:9999"
          />
        </div>
        <div className="button-group">
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

      <div className="canvas-wrapper">
        <canvas ref={canvasRef} className="video-canvas" id="rtsp-canvas"></canvas>
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
