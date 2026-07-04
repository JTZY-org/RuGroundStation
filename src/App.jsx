import React from 'react';
import { VideoPlayer } from './components/VideoPlayer';
import { MspDashboard } from './components/MspDashboard';
import './App.css';

function App() {
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-logo">
          <div className="pulse-dot"></div>
          <h1>RuAPS Ground Station Tester</h1>
        </div>
        <div className="header-subtitle">
          RTSP Live Stream & MSP Telemetry Client
        </div>
      </header>

      <main className="app-main">
        <div className="tester-grid">
          <div className="grid-col video-section">
            <VideoPlayer />
          </div>
          
          <div className="grid-col dashboard-section">
            <MspDashboard />
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <p>RuAPS GClient Testing Suite &copy; 2026. Designed with rich glassmorphism & binary decoding.</p>
      </footer>
    </div>
  );
}

export default App;
