import React, { useEffect, useRef, useState } from 'react';
import './VideoPlayer.css';

export function VideoPlayer({ 
  yoloBox, 
  onStreamConnected, 
  onRtspConnected, // for backwards compatibility
  deviceIp, 
  onChangeDeviceIp 
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const pipVideoRef = useRef(null);
  const pipCanvasRef = useRef(null);
  const pipAnimFrameRef = useRef(null);
  const pipRvfcRef = useRef(null);
  const pipRunningRef = useRef(false);

  const stopPipLoop = () => {
    pipRunningRef.current = false;
    const video = videoRef.current;
    if (video && pipRvfcRef.current && 'cancelVideoFrameCallback' in video) {
      try {
        video.cancelVideoFrameCallback(pipRvfcRef.current);
      } catch (e) {}
      pipRvfcRef.current = null;
    }
    if (pipAnimFrameRef.current) {
      cancelAnimationFrame(pipAnimFrameRef.current);
      pipAnimFrameRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopPipLoop();
      if (pipVideoRef.current && pipVideoRef.current.parentNode) {
        pipVideoRef.current.parentNode.removeChild(pipVideoRef.current);
      }
    };
  }, []);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isFlipped, setIsFlipped] = useState(true); // Default to true (corrects upside down camera mount)
  const isFlippedRef = useRef(isFlipped);
  isFlippedRef.current = isFlipped;
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [status, setStatus] = useState('Idle'); // Idle, Connecting, Playing, Error
  const [errorMsg, setErrorMsg] = useState('');
  const [showDiag, setShowDiag] = useState(false);
  const [offerSdp, setOfferSdp] = useState('');
  const [answerSdp, setAnswerSdp] = useState('');
  const [rtcStats, setRtcStats] = useState({
    iceState: 'new',
    pcState: 'new',
    framesReceived: 0,
    framesDecoded: 0,
    keyFramesDecoded: 0,
    bytesReceived: 0,
    bitrateKbps: 0,
    decoderImplementation: 'N/A'
  });

  const statsIntervalRef = useRef(null);
  const lastBytesRef = useRef(0);
  const lastStatsTimeRef = useRef(performance.now());

  const signalingUrl = `ws://${deviceIp}:8001`;

  // Toggle Window Fullscreen (Web/Page Fullscreen)
  const toggleWindowFullscreen = () => {
    setIsWindowFullscreen(prev => !prev);
  };

  // Toggle Native Browser Fullscreen (Screen Fullscreen)


  // Toggle Picture-in-Picture (画中画) - 采用 Canvas 实时合成矫正流，支持 180° 旋转与目标框同步
  const togglePictureInPicture = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }

      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      let pipVideo = pipVideoRef.current;
      if (!pipVideo) {
        pipVideo = document.createElement('video');
        pipVideo.muted = true;
        pipVideo.autoplay = true;
        pipVideo.playsInline = true;
        pipVideo.style.position = 'fixed';
        pipVideo.style.top = '-9999px';
        pipVideo.style.left = '-9999px';
        pipVideo.style.width = '16px';
        pipVideo.style.height = '16px';
        pipVideo.style.opacity = '0';
        pipVideo.style.pointerEvents = 'none';
        document.body.appendChild(pipVideo);
        pipVideoRef.current = pipVideo;

        pipVideo.addEventListener('enterpictureinpicture', () => setIsPip(true));
        pipVideo.addEventListener('leavepictureinpicture', () => {
          setIsPip(false);
          stopPipLoop();
        });
      }

      let pipCanvas = pipCanvasRef.current;
      if (!pipCanvas) {
        pipCanvas = document.createElement('canvas');
        pipCanvasRef.current = pipCanvas;
      }

      // 优化画中画画质与帧率：
      // 画中画浮窗尺寸通常较小（约 300~600px），将捕获画布限制在最大 960px 宽（如 960x540），大幅降低 GPU 显存重绘带宽
      const rawW = video.videoWidth || 1280;
      const rawH = video.videoHeight || 720;
      const maxDim = 960;
      const scale = Math.min(1, maxDim / Math.max(rawW, 1));
      const targetW = Math.round(rawW * scale);
      const targetH = Math.round(rawH * scale);

      pipCanvas.width = targetW;
      pipCanvas.height = targetH;
      const pipCtx = pipCanvas.getContext('2d', { alpha: false, desynchronized: true });

      stopPipLoop();
      pipRunningRef.current = true;

      const renderPip = () => {
        if (!pipRunningRef.current) return;
        pipCtx.save();
        if (isFlippedRef.current) {
          pipCtx.translate(targetW, targetH);
          pipCtx.rotate(Math.PI);
        }
        pipCtx.drawImage(video, 0, 0, targetW, targetH);
        pipCtx.restore();

        const overlay = overlayRef.current;
        if (overlay && overlay.width > 0) {
          pipCtx.drawImage(overlay, 0, 0, targetW, targetH);
        }
      };

      // 调度循环：优先采用 requestVideoFrameCallback (rVFC 解码直达)，退化使用 requestAnimationFrame
      const loop = () => {
        if (!pipRunningRef.current) return;
        renderPip();
        if ('requestVideoFrameCallback' in video) {
          pipRvfcRef.current = video.requestVideoFrameCallback(loop);
        } else {
          pipAnimFrameRef.current = requestAnimationFrame(loop);
        }
      };

      // 先画首帧再捕获流，确保流已有有效帧和元数据
      renderPip();
      loop();

      const stream = pipCanvas.captureStream(60);
      pipVideo.srcObject = stream;
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();
    } catch (err) {
      console.error('Picture-in-picture error:', err);
    }
  };

  const toggleNativeFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        if (containerRef.current) {
          await containerRef.current.requestFullscreen();
        }
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error('Fullscreen request error:', err);
    }
  };

  // Listen to fullscreen changes & Esc key for exiting window fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (isWindowFullscreen) setIsWindowFullscreen(false);
      }
    };

    if (isWindowFullscreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isWindowFullscreen]);

  const handleStopStream = () => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }

    // 1. Close WebSocket signaling
    if (wsRef.current) {
      try {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      } catch (e) {
        console.error('Error closing WebSocket:', e);
      }
      wsRef.current = null;
    }

    // 2. Close WebRTC PeerConnection
    if (pcRef.current) {
      try {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch (e) {
        console.error('Error closing RTCPeerConnection:', e);
      }
      pcRef.current = null;
    }

    // 3. Clear video source tracks
    if (videoRef.current && videoRef.current.srcObject) {
      try {
        const stream = videoRef.current.srcObject;
        stream.getTracks().forEach((track) => track.stop());
      } catch (e) {}
      videoRef.current.srcObject = null;
    }

    // 4. Clear overlay drawings
    if (overlayRef.current) {
      const ctx = overlayRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
    }

    // 5. Stop PiP loop if running
    stopPipLoop();
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }

    setIsPlaying(false);
    setStatus('Idle');
    setRtcStats({
      iceState: 'closed',
      pcState: 'closed',
      framesReceived: 0,
      framesDecoded: 0,
      keyFramesDecoded: 0,
      bytesReceived: 0,
      bitrateKbps: 0
    });
  };

  const handleStartStream = async () => {
    handleStopStream();

    setStatus('Connecting');
    setErrorMsg('');

    try {
      console.log(`[WebRTC] Connecting to signaling server at ${signalingUrl}...`);
      const ws = new WebSocket(signalingUrl);
      wsRef.current = ws;

      // Create WebRTC Peer Connection with zero-latency profile
      const pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });
      pcRef.current = pc;

      // Add transceiver for receiving video and strictly prioritize H264 Baseline with packetization-mode=1
      const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
      if (typeof RTCRtpReceiver.getCapabilities === 'function') {
        try {
          const capabilities = RTCRtpReceiver.getCapabilities('video');
          if (capabilities && capabilities.codecs) {
            // Strictly prioritize: H.264 (packetization-mode=1, 42e01f) -> H.264 (packetization-mode=1, other) -> other H.264 -> rest
            const h264Mode1Baseline = capabilities.codecs.filter(c => 
              c.mimeType.toLowerCase() === 'video/h264' && 
              (c.sdpFmtpLine || '').includes('packetization-mode=1') &&
              (c.sdpFmtpLine || '').includes('42e01f')
            );
            const h264Mode1Other = capabilities.codecs.filter(c => 
              c.mimeType.toLowerCase() === 'video/h264' && 
              (c.sdpFmtpLine || '').includes('packetization-mode=1') &&
              !(c.sdpFmtpLine || '').includes('42e01f')
            );
            const h264Mode0 = capabilities.codecs.filter(c => 
              c.mimeType.toLowerCase() === 'video/h264' && 
              (c.sdpFmtpLine || '').includes('packetization-mode=0')
            );
            const otherCodecs = capabilities.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');

            const sortedCodecs = [...h264Mode1Baseline, ...h264Mode1Other, ...h264Mode0, ...otherCodecs];
            console.log('[WebRTC] Strictly Prioritized H.264 (packetization-mode=1 Baseline first):', sortedCodecs);
            transceiver.setCodecPreferences(sortedCodecs);
          }
        } catch (e) {
          console.warn('[WebRTC] Could not set codec preferences:', e);
        }
      }

      // Handle incoming remote media track
      pc.ontrack = (event) => {
        console.log(`[WebRTC] Received remote track: kind=${event.track.kind}, id=${event.track.id}, streams=${event.streams?.length || 0}`);
        
        if (videoRef.current) {
          videoRef.current.muted = true;
          videoRef.current.playsInline = true;

          if (event.streams && event.streams[0]) {
            console.log('[WebRTC] Attaching remote MediaStream to <video> srcObject');
            videoRef.current.srcObject = event.streams[0];
          } else {
            console.log('[WebRTC] Wrapping raw MediaStreamTrack into new MediaStream');
            let inboundStream = videoRef.current.srcObject;
            if (!inboundStream || !(inboundStream instanceof MediaStream)) {
              inboundStream = new MediaStream();
              videoRef.current.srcObject = inboundStream;
            }
            inboundStream.addTrack(event.track);
          }

          videoRef.current.play().then(() => {
            console.log('[WebRTC] <video> playback started successfully');
          }).catch(e => {
            console.warn('[WebRTC] <video> auto-play warning (will retry on user interaction):', e);
          });
          
          setStatus('Playing');
          setIsPlaying(true);
        }
      };

      // Send local ICE candidates to signaling server (Port 8001)
      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          console.log('[WebRTC] Sending local ICE candidate:', event.candidate.candidate);
          ws.send(JSON.stringify({
            type: 'candidate',
            candidate: event.candidate
          }));
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('[WebRTC] ICE Connection state:', pc.iceConnectionState);
        setRtcStats(prev => ({ ...prev, iceState: pc.iceConnectionState }));
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setStatus('Playing');
          setIsPlaying(true);
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WebRTC] PeerConnection state:', pc.connectionState);
        setRtcStats(prev => ({ ...prev, pcState: pc.connectionState }));
        if (pc.connectionState === 'connected') {
          setStatus('Playing');
          setIsPlaying(true);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          setStatus('Error');
          setErrorMsg(`WebRTC connection ${pc.connectionState}`);
          setIsPlaying(false);
        }
      };

      // Start periodic WebRTC stats poller for diagnostics
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      lastBytesRef.current = 0;
      lastStatsTimeRef.current = performance.now();

      statsIntervalRef.current = setInterval(async () => {
        if (!pcRef.current || pcRef.current.signalingState === 'closed') return;
        try {
          const stats = await pcRef.current.getStats();
          let framesReceived = 0;
          let framesDecoded = 0;
          let keyFramesDecoded = 0;
          let bytesReceived = 0;
          let decoderImplementation = 'N/A';

          stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
              framesReceived = report.framesReceived || 0;
              framesDecoded = report.framesDecoded || 0;
              keyFramesDecoded = report.keyFramesDecoded || 0;
              bytesReceived = report.bytesReceived || 0;
              if (report.decoderImplementation) {
                decoderImplementation = report.decoderImplementation;
              }
            }
          });

          const now = performance.now();
          const durationSec = (now - lastStatsTimeRef.current) / 1000;
          const bitrate = durationSec > 0 ? Math.round(((bytesReceived - lastBytesRef.current) * 8) / (durationSec * 1000)) : 0;
          lastBytesRef.current = bytesReceived;
          lastStatsTimeRef.current = now;

          setRtcStats(prev => ({
            ...prev,
            iceState: pcRef.current?.iceConnectionState || prev.iceState,
            pcState: pcRef.current?.connectionState || prev.pcState,
            framesReceived,
            framesDecoded,
            keyFramesDecoded,
            bytesReceived,
            bitrateKbps: bitrate > 0 ? bitrate : prev.bitrateKbps,
            decoderImplementation: decoderImplementation !== 'N/A' ? decoderImplementation : prev.decoderImplementation
          }));
        } catch (e) {}
      }, 1000);

      // Setup WebSocket Signaling
      ws.onopen = async () => {
        if (wsRef.current !== ws) return;
        console.log('[WebRTC Signaling] WebSocket connected. Creating Offer...');

        try {
          const offer = await pc.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false
          });
          await pc.setLocalDescription(offer);
          setOfferSdp(offer.sdp || '');

          // Send SDP Offer to server
          ws.send(JSON.stringify({
            type: 'offer',
            sdp: offer.sdp
          }));
          console.log('[WebRTC Signaling] Sent SDP Offer to device:\n', offer.sdp);
        } catch (err) {
          console.error('[WebRTC] Failed to create or set local SDP Offer:', err);
          setStatus('Error');
          setErrorMsg(`SDP Offer generation error: ${err.message}`);
        }
      };

      ws.onmessage = async (event) => {
        if (wsRef.current !== ws) return;

        try {
          let data = event.data;
          let msg;
          if (typeof data === 'string') {
            msg = JSON.parse(data);
          } else {
            console.warn('[WebRTC Signaling] Non-string message received:', data);
            return;
          }

          console.log('[WebRTC Signaling] Received message type:', msg.type || 'unknown');

          // 1. Answer SDP
          if (msg.type === 'answer' || (msg.sdp && !msg.type)) {
            const rawSdp = msg.sdp || msg;
            const sdpString = typeof rawSdp === 'string' ? rawSdp : JSON.stringify(rawSdp);
            setAnswerSdp(sdpString);
            console.log('[WebRTC Signaling] Setting Remote SDP Answer:\n', sdpString);
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: 'answer',
              sdp: sdpString
            }));
          } 
          // 2. Remote ICE Candidate
          else if (msg.type === 'candidate' && msg.candidate) {
            console.log('[WebRTC Signaling] Adding Remote ICE Candidate');
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } 
          // 3. If server sent an Offer instead
          else if (msg.type === 'offer') {
            setOfferSdp(msg.sdp || JSON.stringify(msg));
            console.log('[WebRTC Signaling] Received Server Offer, creating Answer...');
            await pc.setRemoteDescription(new RTCSessionDescription(msg));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            setAnswerSdp(answer.sdp || '');
            ws.send(JSON.stringify({
              type: 'answer',
              sdp: answer.sdp
            }));
          }
        } catch (err) {
          console.error('[WebRTC Signaling] Error handling message:', err);
        }
      };

      ws.onerror = (err) => {
        if (wsRef.current !== ws) return;
        console.error('[WebRTC Signaling] WebSocket error:', err);
        setStatus('Error');
        setErrorMsg(`Signaling connection failed (ws://${deviceIp}:8001)`);
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        console.log('[WebRTC Signaling] WebSocket connection closed');
        if (pc.connectionState !== 'connected') {
          setStatus('Idle');
          setIsPlaying(false);
        }
      };

    } catch (err) {
      console.error('[WebRTC] Initialization error:', err);
      setStatus('Error');
      setErrorMsg(err.message || 'Error starting WebRTC player');
    }
  };

  // Target cache to prevent flickering and support multiple persistent targets
  const targetsRef = useRef(new Map());
  const animFrameRef = useRef(null);
  // 机端 YOLO 会把椅子等其它类一起画上来。默认只留 COCO person（class_id 0）。
  const [personOnly, setPersonOnly] = useState(true);
  const personOnlyRef = useRef(true);
  personOnlyRef.current = personOnly;
  const [targetCount, setTargetCount] = useState(0);

  // 机端框是不是人。classId 缺省时按 0 处理，和原来的绘制标签一致。
  const isPersonDetection = (box) => {
    const cid = box?.classId !== undefined ? box.classId : 0;
    return cid === 0;
  };

  // Update target tracking cache when new YOLO detections arrive
  useEffect(() => {
    if (personOnly) {
      for (const [key, box] of targetsRef.current) {
        if (!isPersonDetection(box)) targetsRef.current.delete(key);
      }
    }
    if (!yoloBox) return;
    const now = Date.now();
    const detections = Array.isArray(yoloBox) ? yoloBox : [yoloBox];

    detections.forEach((box) => {
      if (!box || box.x1 === undefined) return;

      // 仅行人时丢掉椅子等其它类，避免缓存里的旧框再画一秒。
      if (personOnly && !isPersonDetection(box)) return;

      const key = box.trackId !== undefined ? box.trackId : (box.targetId !== undefined ? box.targetId : (box.id !== undefined ? box.id : 1));
      targetsRef.current.set(key, {
        ...box,
        lastSeen: now
      });
    });
  }, [yoloBox, personOnly]);

  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const lastFpsCalcTimeRef = useRef(performance.now());

  // Smooth flicker-free high-FPS render loop for canvas overlay mapped to <video>
  useEffect(() => {
    if (!isPlaying) {
      if (overlayRef.current) {
        const ctx = overlayRef.current.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
      }
      targetsRef.current.clear();
      setFps(0);
      setTargetCount(0);
      return;
    }

    let isRunning = true;

    const renderLoop = () => {
      if (!isRunning) return;

      // Real-time High-FPS counter calculation
      frameCountRef.current++;
      const nowPerf = performance.now();
      const elapsed = nowPerf - lastFpsCalcTimeRef.current;
      if (elapsed >= 500) {
        setFps(Math.round((frameCountRef.current * 1000) / elapsed));
        frameCountRef.current = 0;
        lastFpsCalcTimeRef.current = nowPerf;
      }

      const overlay = overlayRef.current;
      const video = videoRef.current;

      if (overlay && video && video.videoWidth > 0 && video.videoHeight > 0) {
        if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
          overlay.width = video.videoWidth;
          overlay.height = video.videoHeight;
        }

        const ctx = overlay.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, overlay.width, overlay.height);

          const now = Date.now();
          // Keep targets for up to 1000ms to eliminate network/polling jitter and flickering
          const MAX_AGE_MS = 1000; 

          let activeCount = 0;
          // 浏览器「框人」开着时只用本地模型的框。机端框继续清过期缓存，但不再画出来。
          const drawAircraftBoxes = true;
          targetsRef.current.forEach((box, key) => {
            const age = now - box.lastSeen;
            if (age > MAX_AGE_MS) {
              targetsRef.current.delete(key);
              return;
            }
            // 绘制循环不依赖 personOnly 的闭包，用 ref 读当前开关，非人框立刻清掉。
            if (personOnlyRef.current && !isPersonDetection(box)) {
              targetsRef.current.delete(key);
              return;
            }
            if (!drawAircraftBoxes) return;
            activeCount++;

            const { x1, y1, x2, y2, trackId, classId, id, targetId, confidence } = box;
            
            // Normalize in case coordinates are inverted or out of order
            const minX = Math.min(x1, x2);
            const maxX = Math.max(x1, x2);
            const minY = Math.min(y1, y2);
            const maxY = Math.max(y1, y2);

            // Coordinate mapping (as per original architecture):
            // The YOLO algorithm on the drone already outputs coordinates that are right-side up.
            // When isFlipped is true (default): <video> is rotated 180° by CSS to correct the upside-down camera feed into a normal right-side-up view.
            // Thus, the right-side-up YOLO coordinates align directly: (minX, minY).
            // When isFlipped is false: raw uncorrected upside-down video is shown, so coordinates are rotated 180°: (overlay.width - maxX, overlay.height - maxY).
            const drawX1 = !isFlipped ? (overlay.width - maxX) : minX;
            const drawX2 = !isFlipped ? (overlay.width - minX) : maxX;
            const drawY1 = !isFlipped ? (overlay.height - maxY) : minY;
            const drawY2 = !isFlipped ? (overlay.height - minY) : maxY;

            const boxWidth = Math.max(0, drawX2 - drawX1);
            const boxHeight = Math.max(0, drawY2 - drawY1);

            // Smooth fading opacity: 100% solid for the first 500ms, smooth fade-out from 500ms to 1000ms
            const opacity = age <= 500 ? 1 : Math.max(0.2, 1 - (age - 500) / 500);

            ctx.save();
            ctx.globalAlpha = opacity;

            // Draw bounding box rectangle
            ctx.strokeStyle = '#10b981'; // Emerald-500
            ctx.lineWidth = 3;
            ctx.strokeRect(drawX1, drawY1, boxWidth, boxHeight);

            // Draw label banner background
            const tid = trackId !== undefined ? trackId : (targetId !== undefined ? targetId : (id !== undefined ? id : 1));
            const cid = classId !== undefined ? classId : 0;
            const conf = confidence !== undefined ? (confidence > 1 ? confidence : Math.round(confidence * 100)) : 0;
            const text = cid === 0 ? `人 #${tid} (${conf}%)` : `Class ${cid} #${tid} (${conf}%)`;

            ctx.font = 'bold 12px monospace';
            const textWidth = ctx.measureText(text).width;
            const bannerHeight = 20;
            const bannerY = Math.max(0, drawY1 - bannerHeight);

            // Label background
            ctx.fillStyle = 'rgba(16, 185, 129, 0.85)';
            ctx.fillRect(drawX1, bannerY, textWidth + 10, bannerHeight);

            // Label text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, drawX1 + 5, bannerY + 14);

            ctx.restore();
          });

          

          setTargetCount(activeCount);
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

  // Notify parent component when stream status changes
  useEffect(() => {
    if (onStreamConnected) onStreamConnected(isPlaying);
    if (onRtspConnected) onRtspConnected(isPlaying);
  }, [isPlaying, onStreamConnected, onRtspConnected]);

  useEffect(() => {
    return () => {
      handleStopStream();
    };
  }, []);

  return (
    <div className={`video-card ${isWindowFullscreen ? 'window-fullscreen' : ''}`}>
      <div className="card-header">
        <div className="card-title-group">
          <h3>实时图传视频</h3>
          <span className="channel-hint">Port 8001 (Signaling) / 8002 (SRTP Media)</span>
        </div>
        <div className="header-badges">
          {isPlaying && fps > 0 && (
            <span className="status-badge fps-badge">{fps} FPS</span>
          )}
          {isPlaying && targetCount > 0 && (
            <span className="status-badge target-badge">{targetCount} Target{targetCount > 1 ? 's' : ''}</span>
          )}
          <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>
        </div>
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
            type="button"
            className={`btn ${personOnly ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setPersonOnly(!personOnly)}
            title="只显示行人检测框或全部类别"
          >
            {personOnly ? '仅人像' : '所有目标'}
          </button>
          <button 
            type="button"
            className={`btn ${isFlipped ? 'btn-warning' : 'btn-secondary'}`}
            onClick={() => setIsFlipped(!isFlipped)}
            title="切换画面垂直翻转 (修正倒装摄像头)"
          >
            {isFlipped ? '画面正常' : '上下翻转'}
          </button>
          <button 
            type="button"
            className={`btn ${isPip ? 'btn-primary' : 'btn-secondary'}`}
            onClick={togglePictureInPicture}
            disabled={!isPlaying}
            title="开启矫正旋转后的画中画悬浮窗"
          >
            {isPip ? '退出画中画' : '画中画'}
          </button>
          <button 
            type="button"
            className={`btn ${isWindowFullscreen ? 'btn-primary' : 'btn-secondary'}`}
            onClick={toggleWindowFullscreen}
            title="网页窗口内全屏"
          >
            {isWindowFullscreen ? '退出窗口' : '窗口全屏'}
          </button>
          <button 
            type="button"
            className={`btn ${isFullscreen ? 'btn-primary' : 'btn-secondary'}`}
            onClick={toggleNativeFullscreen}
            title="显示器全屏 (F11)"
          >
            {isFullscreen ? '退出全屏' : '屏幕全屏'}
          </button>
          {!isPlaying ? (
            <button 
              className="btn btn-primary" 
              onClick={handleStartStream}
            >
              开启视频图传
            </button>
          ) : (
            <button className="btn btn-danger" onClick={handleStopStream}>
              停止图传
            </button>
          )}
        </div>
      </div>

      {errorMsg && <div className="error-alert">{errorMsg}</div>}

      <div 
        ref={containerRef} 
        className={`canvas-wrapper ${isFlipped ? 'flipped-vertical' : ''} ${isWindowFullscreen ? 'window-fullscreen' : ''}`}
      >
        {/* Floating Quick Action Overlay Controls (Visible on Hover / In Fullscreen) */}
        <div className="video-floating-bar">
          <button 
            className="floating-btn" 
            onClick={() => setPersonOnly(!personOnly)}
            title={personOnly ? 'Filter: Person Only' : 'Filter: All Classes'}
          >
            {personOnly ? '仅人像' : '所有目标'}
          </button>
          <button 
            className="floating-btn" 
            onClick={() => setIsFlipped(!isFlipped)}
            title="Toggle Flip Vertical"
          >
            翻转
          </button>
          <button 
            type="button"
            className="floating-btn" 
            onClick={togglePictureInPicture}
            title="开启/退出画中画悬浮窗"
          >
            {isPip ? '退出画中画' : '画中画'}
          </button>
          <button 
            type="button"
            className="floating-btn" 
            onClick={toggleWindowFullscreen}
            title={isWindowFullscreen ? 'Exit Window Fullscreen (Esc)' : 'Window Fullscreen'}
          >
            {isWindowFullscreen ? '退出窗口' : '窗口全屏'}
          </button>
          <button 
            className="floating-btn" 
            onClick={toggleNativeFullscreen}
            title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Display Fullscreen'}
          >
            {isFullscreen ? '退出全屏' : '屏幕全屏'}
          </button>
        </div>

        <video 
          ref={videoRef} 
          className={`video-stream ${isPip ? "is-in-pip" : ""}`} 
          autoPlay 
          playsInline 
          muted 
          disablePictureInPicture 
          onLoadedMetadata={(e) => {
            console.log(`[WebRTC <video>] Metadata loaded: resolution=${e.target.videoWidth}x${e.target.videoHeight}`);
          }}
          onPlaying={() => {
            console.log('[WebRTC <video>] Video stream playing event fired');
            setStatus('Playing');
            setIsPlaying(true);
          }}
          onWaiting={() => {
            console.log('[WebRTC <video>] Video buffering/waiting for frames...');
          }}
          onError={(e) => {
            console.error('[WebRTC <video>] Video element error:', e);
          }}
        />
        {isPlaying && (
          <canvas ref={overlayRef} className="yolo-overlay-canvas"></canvas>
        )}
        {!isPlaying && (
          <div className="canvas-placeholder"></div>
        )}
      </div>

    </div>
  );
}

