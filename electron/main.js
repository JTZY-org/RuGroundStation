import electron from 'electron';
const { app, BrowserWindow } = electron;
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getLogFile() {
  try {
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'app-debug.log');
    }
  } catch (e) {}
  return path.join(process.cwd(), 'app-debug.log');
}

function log(msg) {
  try {
    const time = new Date().toISOString();
    fs.appendFileSync(getLogFile(), `[${time}] ${msg}\n`);
  } catch (e) {}
}

// Disable hardware acceleration and direct composition to prevent GetGpuDriverOverlayInfo driver hangs on Windows
try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-direct-composition');
  app.commandLine.appendSwitch('disable-features', 'DirectCompositionOverlays,DirectComposition,CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('no-sandbox');
} catch (e) {}

const FFMPEG_PATH = path.join(__dirname, 'bin', 'ffmpeg.exe');

let mainWindow = null;
let wss = null;
let activeFfmpgProcesses = new Set();

const WS_PORT = 9999;
const DEFAULT_RTSP_URL = 'rtsp://192.168.223.1:554/live';

// Initialize the RTSP WebSocket Proxy inside Electron Main Process
function startRtspProxy() {
  wss = new WebSocketServer({ port: WS_PORT });
  console.log(`[Electron-Proxy] WebSocket proxy listening on ws://localhost:${WS_PORT}`);

  wss.on('connection', (ws, req) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const rtspUrl = urlObj.searchParams.get('url') || DEFAULT_RTSP_URL;
    
    console.log(`[Electron-Proxy] Client connected. Transcoding RTSP URL: ${rtspUrl}`);

    const ffmpegParams = [
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-i', rtspUrl,
      '-f', 'mpegts',
      '-codec:v', 'mpeg1video',
      '-r', '60',                      // Set stable 60fps (MPEG-1 specification maximum limit)
      '-threads', '0',                 // Enable multi-threaded encoding for high-speed performance
      '-b:v', '4000k',                 // Higher bitrate for clarity
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-an',
      '-'
    ];

    const ffmpegCmd = fs.existsSync(FFMPEG_PATH) ? FFMPEG_PATH : 'ffmpeg';
    log(`Spawning FFmpeg from: ${ffmpegCmd}`);
    const ffmpeg = spawn(ffmpegCmd, ffmpegParams);
    activeFfmpgProcesses.add(ffmpeg);

    ffmpeg.stdout.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      console.log(`[FFmpeg-Stderr] ${data.toString().trim()}`);
    });

    ffmpeg.on('close', (code) => {
      console.log(`[Electron-Proxy] FFmpeg process exited with code ${code}`);
      activeFfmpgProcesses.delete(ffmpeg);
      ws.close();
    });

    ws.on('close', () => {
      console.log('[Electron-Proxy] Client socket closed. Terminating FFmpeg process');
      try {
        ffmpeg.kill('SIGKILL');
      } catch (e) {}
      activeFfmpgProcesses.delete(ffmpeg);
    });

    ws.on('error', (err) => {
      console.error('[Electron-Proxy] WebSocket connection error:', err.message);
      try {
        ffmpeg.kill('SIGKILL');
      } catch (e) {}
      activeFfmpgProcesses.delete(ffmpeg);
    });
  });
}

function stopRtspProxy() {
  // Clean up all running ffmpeg processes
  for (const proc of activeFfmpgProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch (e) {}
  }
  activeFfmpgProcesses.clear();

  if (wss) {
    wss.close();
    wss = null;
  }
}

function createWindow() {
  try {
    log('createWindow() called');
    mainWindow = new BrowserWindow({
      width: 1300,
      height: 900,
      title: "RuAPS Ground Station Tester",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false
      }
    });

    // Remove default menu bar
    mainWindow.setMenuBarVisibility(false);

    // Automatically open DevTools docked to the right in dev mode
    mainWindow.webContents.openDevTools({ mode: 'right' });

    // Enable F12 and Ctrl+Shift+I shortcut to toggle DevTools
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    // Log renderer console messages to terminal and log file
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message}`);
      log(`[Renderer] ${message}`);
    });

    // In development, wait for local Vite server to be ready before loading
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    if (isDev) {
      log('Waiting for Vite dev server (http://localhost:5173)...');
      const checkAndLoad = () => {
        const req = http.get('http://localhost:5173', (res) => {
          log('Vite dev server is ready, loading URL');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL('http://localhost:5173');
          }
        });
        req.on('error', () => {
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              checkAndLoad();
            }
          }, 200);
        });
        req.setTimeout(500, () => {
          req.destroy();
        });
      };
      checkAndLoad();
    } else {
      const indexPath = path.join(__dirname, '../dist/index.html');
      log(`Loading HTML from: ${indexPath}. File exists: ${fs.existsSync(indexPath)}`);
      mainWindow.loadFile(indexPath);
    }

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      log(`[Renderer] Failed to load URL: ${validatedURL}, Error: ${errorDescription} (${errorCode})`);
      if (isDev && validatedURL.startsWith('http://localhost:5173')) {
        log('Retrying connection to dev server in 1000ms...');
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL('http://localhost:5173');
          }
        }, 1000);
      }
    });

    mainWindow.webContents.on('render-process-gone', (event, details) => {
      log(`[Renderer] Render process gone: ${details.reason}, exitCode: ${details.exitCode}`);
    });

    mainWindow.on('closed', () => {
      log('Window closed event');
      mainWindow = null;
    });
  } catch (err) {
    log(`Error in createWindow: ${err.message}\n${err.stack}`);
  }
}

app.whenReady().then(() => {
  startRtspProxy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopRtspProxy();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopRtspProxy();
});
