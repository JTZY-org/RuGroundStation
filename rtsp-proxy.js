import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';

const WS_PORT = 9999;
const DEFAULT_RTSP_URL = 'rtsp://192.168.222.1:554/live';

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`[RTSP-Proxy] WebSocket server listening on ws://localhost:${WS_PORT}`);

wss.on('connection', (ws, req) => {
  // Parse RTSP URL from request query parameter, or use default
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const rtspUrl = urlObj.searchParams.get('url') || DEFAULT_RTSP_URL;
  
  console.log(`[RTSP-Proxy] Client connected. Streaming from: ${rtspUrl}`);

  // FFmpeg command to transcode RTSP h264/h265 to MPEG-1 TS format
  // MPEG1 is supported natively by JSMpeg in the browser via WebGL/Canvas
  const ffmpegParams = [
    '-rtsp_transport', 'tcp',        // Force TCP transport
    '-fflags', 'nobuffer',           // Low latency: don't buffer input
    '-flags', 'low_delay',           // Low latency flag
    '-i', rtspUrl,                   // Input RTSP Stream URL
    '-f', 'mpegts',                  // Format Output as MPEG-TS
    '-codec:v', 'mpeg1video',        // Transcode video to MPEG1
    '-b:v', '4000k',                 // Higher bitrate for high framerate
    '-preset', 'ultrafast',          // Low latency preset
    '-tune', 'zerolatency',          // Zero latency tuning
    '-an',                           // Disable Audio (not needed for preview)
    '-'                              // Output to stdout
  ];

  console.log(`[RTSP-Proxy] Spawning ffmpeg with params: ${ffmpegParams.join(' ')}`);
  const ffmpeg = spawn('ffmpeg', ffmpegParams);

  // Send binary stream data to client
  ffmpeg.stdout.on('data', (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ffmpeg.stderr.on('data', (data) => {
    // Optional debug logging for ffmpeg
    // console.log(`[FFmpeg] ${data.toString()}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`[RTSP-Proxy] ffmpeg process exited with code ${code}`);
    ws.close();
  });

  ws.on('close', () => {
    console.log('[RTSP-Proxy] Client disconnected, killing ffmpeg process');
    ffmpeg.kill('SIGINT');
  });

  ws.on('error', (err) => {
    console.error('[RTSP-Proxy] WebSocket error:', err.message);
    ffmpeg.kill('SIGINT');
  });
});
