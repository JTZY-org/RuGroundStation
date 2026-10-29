import React, { useState, useCallback } from 'react';
import { VideoPlayer } from './components/VideoPlayer';
import { MspDashboard } from './components/MspDashboard';
import { GcsMapView } from './components/GcsMapView';
import './App.css';

function App() {
  const [currentPage, setCurrentPage] = useState('flight'); // 'flight' | 'map'
  const [yoloBox, setYoloBox] = useState(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [deviceIp, setDeviceIp] = useState('192.168.223.1');
  const [telemetry, setTelemetry] = useState({
    lat: 0,
    lon: 0,
    altitudeM: 0,
    gpsAlt: 0,
    yaw: 0,
    numSat: 0,
    gpsFix: 'No Fix',
    lastGpsPacketTime: 0,
    homeLat: 0,
    homeLon: 0,
    homeAlt: 0,
    hasHomeGps: false,
    waypoints: []
  });
  const [clearWpTrigger, setClearWpTrigger] = useState(0);

  const handleClearWaypoints = useCallback(() => {
    setTelemetry(prev => ({ ...prev, waypoints: [] }));
    setClearWpTrigger(c => c + 1);
  }, []);

  return (
    <div className={`app-container ${currentPage === 'map' ? 'map-mode' : ''}`}>
      <header className="app-header">
        <div className="header-logo">
          <div className="pulse-dot"></div>
          <h1>RuAPS Ground Station</h1>
          <div className="header-nav-pills">
            <button 
              type="button" 
              className={`nav-pill-btn ${currentPage === 'flight' ? 'active' : ''}`}
              onClick={() => setCurrentPage('flight')}
            >
              飞行与图传
            </button>
            <button 
              type="button" 
              className={`nav-pill-btn ${currentPage === 'map' ? 'active' : ''}`}
              onClick={() => setCurrentPage('map')}
            >
              航图与轨迹
            </button>
          </div>
        </div>
        <div className="header-subtitle">
          WebRTC Ultra-Low Latency Stream & MSP Telemetry Client
        </div>
      </header>

      {/* 顶栏被隐藏时的极简悬浮页面切换器（仅在窄高度下浮现） */}
      <div className="floating-page-switcher">
        <button 
          type="button" 
          className={`compact-pill ${currentPage === 'flight' ? 'active' : ''}`}
          onClick={() => setCurrentPage('flight')}
        >
          图传控制
        </button>
        <button 
          type="button" 
          className={`compact-pill ${currentPage === 'map' ? 'active' : ''}`}
          onClick={() => setCurrentPage('map')}
        >
          全屏航图
        </button>
      </div>

      <main className="app-main">
        {/* 页面 1：视讯与控制工作台 */}
        <div className={`page-view flight-page-view ${currentPage === 'flight' ? 'active' : 'hidden'}`}>
          <div className="tester-grid">
            <div className="grid-col video-section">
              <VideoPlayer 
                yoloBox={yoloBox} 
                onStreamConnected={setStreamConnected} 
                deviceIp={deviceIp}
                onChangeDeviceIp={setDeviceIp}
              />
            </div>
            
            <div className="grid-col dashboard-section">
              <MspDashboard 
                onYoloBoxUpdate={setYoloBox} 
                onTelemetryUpdate={setTelemetry}
                clearWaypointsTrigger={clearWpTrigger}
                streamConnected={streamConnected} 
                deviceIp={deviceIp}
              />
            </div>
          </div>
        </div>

        {/* 页面 2：全屏航图与机位监控（保持背景 MSP 通信不中断） */}
        <div className={`page-view map-page-view ${currentPage === 'map' ? 'active' : 'hidden'}`}>
          <GcsMapView 
            lat={telemetry.lat} 
            lon={telemetry.lon} 
            alt={telemetry.gpsAlt || telemetry.altitudeM} 
            yaw={telemetry.yaw} 
            numSat={telemetry.numSat} 
            gpsFix={telemetry.gpsFix}
            lastGpsPacketTime={telemetry.lastGpsPacketTime}
            homeLat={telemetry.homeLat}
            homeLon={telemetry.homeLon}
            hasHomeGps={telemetry.hasHomeGps}
            waypoints={telemetry.waypoints}
            onClearWaypoints={handleClearWaypoints}
            isConnected={streamConnected} 
          />
        </div>
      </main>

      {currentPage !== 'map' && (
        <footer className="app-footer">
          <p>RuAPS GClient Testing Suite &copy; 2026. Designed with rich glassmorphism & binary decoding.</p>
        </footer>
      )}
    </div>
  );
}

export default App;
