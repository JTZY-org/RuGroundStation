import React, { useState, useEffect, useRef, useCallback } from 'react';
import AMapLoader from '@amap/amap-jsapi-loader';
import { wgs84ToGcj02 } from '../utils/coordTransform';
import { getAmapKeys, saveAmapKeys } from '../utils/amapConfig';
import './GcsMapView.css';

// 请求本机/浏览器网络定位或 IP 城市定位（复刻自隔壁 RuConfigurator）
function requestLocalPosition(AMap, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!AMap?.Geolocation) {
      resolve(null);
      return;
    }

    let settled = false;
    let timer = 0;
    const done = (value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    timer = window.setTimeout(() => done(null), timeoutMs + 1000);

    const geo = new AMap.Geolocation({
      enableHighAccuracy: false,
      timeout: timeoutMs,
      showButton: false,
      showMarker: false,
      showCircle: false,
      panToLocation: false,
      needAddress: true,
    });

    const tryCity = () => {
      if (typeof geo.getCityInfo !== 'function') {
        done(null);
        return;
      }
      geo.getCityInfo((status, result) => {
        if (status === 'complete' && result?.center) {
          done({
            lng: result.center[0],
            lat: result.center[1],
            city: result.city || result.province || '本机网络定位',
            source: 'ip',
          });
          return;
        }
        done(null);
      });
    };

    geo.getCurrentPosition((status, result) => {
      if (status === 'complete' && result?.position) {
        done({
          lng: result.position.getLng ? result.position.getLng() : result.position.lng,
          lat: result.position.getLat ? result.position.getLat() : result.position.lat,
          city: result.addressComponent?.city || '本机网络定位',
          source: 'html5',
        });
        return;
      }
      tryCity();
    });
  });
}

// 计算大圆直线距离（米）
function calculateDistanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function GcsMapView({ 
  lat = 0, 
  lon = 0, 
  alt = 0, 
  yaw = 0, 
  numSat = 0, 
  gpsFix = 'No Fix', 
  lastGpsPacketTime = 0, 
  homeLat = 0,
  homeLon = 0,
  hasHomeGps = false,
  waypoints = [],
  onClearWaypoints = null,
  isConnected = false 
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const amapRef = useRef(null);
  const droneMarkerRef = useRef(null);
  const homeMarkerRef = useRef(null);
  const wpMarkersRef = useRef([]);
  const wpLineRef = useRef(null);
  const lastWpKeyRef = useRef('');
  const localMarkerRef = useRef(null);
  const trackLineRef = useRef(null);
  const trackPathRef = useRef([]);
  const hasAircraftGpsRef = useRef(false);

  const [keysConfig, setKeysConfig] = useState(getAmapKeys);
  const [inputKey, setInputKey] = useState('');
  const [inputSec, setInputSec] = useState('');
  const [mapState, setMapState] = useState('unconfigured'); // 'unconfigured' | 'loading' | 'ready' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [layerMode, setLayerMode] = useState('satellite'); // 'normal' | 'satellite'
  const [autoFollow, setAutoFollow] = useState(true);
  const [localLocInfo, setLocalLocInfo] = useState(null);
  const [trackCount, setTrackCount] = useState(0);

  const satelliteLayerRef = useRef(null);
  const roadNetLayerRef = useRef(null);

  // 初始化地图
  const initMap = useCallback(async (key, security) => {
    if (!key || !security) {
      setMapState('unconfigured');
      return;
    }

    setMapState('loading');
    setErrorMsg('');

    window._AMapSecurityConfig = {
      securityJsCode: security,
    };

    try {
      const AMap = await AMapLoader.load({
        key,
        version: '2.0',
        plugins: ['AMap.Scale', 'AMap.Geolocation'],
      });

      if (!mapContainerRef.current) return;

      amapRef.current = AMap;
      const map = new AMap.Map(mapContainerRef.current, {
        zoom: 17.3,
        center: [116.397428, 39.90923], // 初始临时中心，获取本机位置后自动平移
        mapStyle: 'amap://styles/dark',
        viewMode: '2D',
      });

      // 卫星与路网图层
      const sat = new AMap.TileLayer.Satellite();
      const road = new AMap.TileLayer.RoadNet();
      satelliteLayerRef.current = sat;
      roadNetLayerRef.current = road;
      map.add([sat, road]);

      mapRef.current = map;
      setMapState('ready');

      // 获取本机初始位置
      requestLocalPosition(AMap).then((loc) => {
        if (!loc || !mapRef.current) return;
        setLocalLocInfo(loc);

        // 如果此时飞机还没有 GPS 信号，以本机位置为中心
        if (!hasAircraftGpsRef.current) {
          mapRef.current.setZoomAndCenter(17.3, [loc.lng, loc.lat]);
        }

        // 在地图上绘制地面站 (本机) 标点
        const localMarkerHtml = `
          <div class="gcs-drone-marker local-gcs-marker">
            <div class="gcs-drone-dot local-gcs-dot"></div>
            <div class="gcs-drone-popup">
              <div>地面站 (本机)</div>
              <div>${loc.city || ''}</div>
            </div>
          </div>
        `;

        if (!localMarkerRef.current) {
          localMarkerRef.current = new AMap.Marker({
            position: [loc.lng, loc.lat],
            content: localMarkerHtml,
            offset: new AMap.Pixel(-10, -10),
            zIndex: 150,
          });
          mapRef.current.add(localMarkerRef.current);
        }
      });
    } catch (err) {
      console.error('[Map] Init failed:', err);
      setMapState('error');
      setErrorMsg(err.message || '地图组件加载失败，请检查高德Key与安全码');
    }
  }, []);

  useEffect(() => {
    if (keysConfig.isConfigured) {
      initMap(keysConfig.key, keysConfig.security);
    } else {
      setMapState('unconfigured');
    }
  }, [initMap, keysConfig]);

  // 卫星 / 标准模式切换
  useEffect(() => {
    if (!mapRef.current || !satelliteLayerRef.current) return;
    if (layerMode === 'satellite') {
      satelliteLayerRef.current.show();
      roadNetLayerRef.current?.show();
    } else {
      satelliteLayerRef.current.hide();
      roadNetLayerRef.current?.hide();
    }
  }, [layerMode]);

  // 保存自定义Key
  const handleSaveKeys = (e) => {
    e.preventDefault();
    if (!inputKey.trim() || !inputSec.trim()) return;
    saveAmapKeys(inputKey, inputSec);
    setKeysConfig(getAmapKeys());
  };

  // 随 MSP_RAW_GPS (lat, lon, alt, yaw) 刷新飞机位置与航迹
  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map || mapState !== 'ready') return;

    // 经纬度校验：MSP 经纬度为 1e-7 度，0视为无效定位
    if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return;

    // 标记已获取到真实飞机 GPS
    hasAircraftGpsRef.current = true;

    // WGS-84 (物理GPS) 转换至 GCJ-02 (高德火星坐标)
    const gcj = wgs84ToGcj02(lon, lat);
    const pos = [gcj.lng, gcj.lat];

    // 更新航迹点（过滤静止原地抖动，位移 > 1.5m 或首个点才追加，避免原地打结）
    const lastPos = trackPathRef.current[trackPathRef.current.length - 1];
    const isNewMove = !lastPos || Math.hypot(gcj.lng - lastPos[0], gcj.lat - lastPos[1]) > 0.000015;

    if (isNewMove) {
      trackPathRef.current.push(pos);
      if (trackPathRef.current.length > 2000) {
        trackPathRef.current.shift();
      }
      setTrackCount(trackPathRef.current.length);

      if (trackPathRef.current.length >= 2) {
        if (!trackLineRef.current) {
          trackLineRef.current = new AMap.Polyline({
            path: trackPathRef.current,
            strokeColor: '#38bdf8',
            strokeWeight: 3,
            strokeOpacity: 0.85,
            strokeStyle: 'solid',
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: 100
          });
          map.add(trackLineRef.current);
        } else {
          trackLineRef.current.setPath(trackPathRef.current);
        }
      }
    }

    // 构建无人机标点 HTML (纯字符与矢量几何图形，无 Emoji)
    const markerHtml = `
      <div class="gcs-drone-marker">
        <div class="gcs-drone-dot">
          <div class="gcs-drone-heading" style="transform: rotate(${yaw}deg);"></div>
        </div>
        <div class="gcs-drone-popup">
          <div>机位: ${gcj.lat.toFixed(6)}, ${gcj.lng.toFixed(6)}</div>
          <div>高度: ${alt}m | 卫星: ${numSat}</div>
        </div>
      </div>
    `;

    if (!droneMarkerRef.current) {
      droneMarkerRef.current = new AMap.Marker({
        position: pos,
        content: markerHtml,
        offset: new AMap.Pixel(-10, -10),
        zIndex: 200,
      });
      map.add(droneMarkerRef.current);
      map.setZoomAndCenter(17.3, pos);
    } else {
      droneMarkerRef.current.setPosition(pos);
      droneMarkerRef.current.setContent(markerHtml);
      if (autoFollow) {
        map.panTo(pos);
      }
    }
  }, [alt, autoFollow, lat, lon, mapState, numSat, yaw]);

  // 随 MSP_HOME_GPS 刷新返航点 (Home 点标点)
  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map || mapState !== 'ready') return;

    const isValidHome = (Math.abs(homeLat) > 0.0001 || Math.abs(homeLon) > 0.0001) && hasHomeGps;
    if (!isValidHome) {
      if (homeMarkerRef.current) {
        map.remove(homeMarkerRef.current);
        homeMarkerRef.current = null;
      }
      return;
    }

    const homeGcj = wgs84ToGcj02(homeLon, homeLat);
    const homePos = [homeGcj.lng, homeGcj.lat];

    const homeHtml = `
      <div class="gcs-home-marker">
        <div class="gcs-home-dot">H</div>
        <div class="gcs-home-popup">
          <div>返航点 (HOME)</div>
          <div>${homeGcj.lat.toFixed(6)}, ${homeGcj.lng.toFixed(6)}</div>
        </div>
      </div>
    `;

    if (!homeMarkerRef.current) {
      homeMarkerRef.current = new AMap.Marker({
        position: homePos,
        content: homeHtml,
        offset: new AMap.Pixel(-12, -12),
        zIndex: 195,
      });
      map.add(homeMarkerRef.current);
    } else {
      homeMarkerRef.current.setPosition(homePos);
      homeMarkerRef.current.setContent(homeHtml);
    }
  }, [hasHomeGps, homeLat, homeLon, mapState]);

  // 随 MSP_WP_GPS 刷新航点标点与航线连接线 (Polyline)
  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map || mapState !== 'ready') return;

    const list = waypoints || [];
    const wpKey = list.map(w => `${w.index}_${Number(w.lat).toFixed(6)}_${Number(w.lon).toFixed(6)}_${w.alt}`).join('|');
    if (wpKey === lastWpKeyRef.current) {
      return;
    }
    lastWpKeyRef.current = wpKey;

    if (list.length === 0) {
      if (wpMarkersRef.current.length > 0) {
        wpMarkersRef.current.forEach(m => {
          try { map.remove(m); } catch {}
        });
        wpMarkersRef.current = [];
      }
      if (wpLineRef.current) {
        try { map.remove(wpLineRef.current); } catch {}
        wpLineRef.current = null;
      }
      return;
    }

    const routePath = [];

    // 复用已有的 Marker 实例，避免反复 remove/add 触发大量 non-passive DOM 事件监听器 Violation 警告
    list.forEach((wp, i) => {
      const wGcj = wgs84ToGcj02(wp.lon, wp.lat);
      const pos = [wGcj.lng, wGcj.lat];
      routePath.push(pos);

      const wpHtml = `
        <div class="gcs-wp-marker">
          <div class="gcs-wp-dot">${wp.index}</div>
          <div class="gcs-wp-popup">
            <div>航点 WP #${wp.index}</div>
            <div>${wGcj.lat.toFixed(6)}, ${wGcj.lng.toFixed(6)}</div>
            <div>高度: ${wp.alt}m</div>
          </div>
        </div>
      `;

      if (i < wpMarkersRef.current.length) {
        // 就地更新已有 Marker
        const marker = wpMarkersRef.current[i];
        marker.setPosition(pos);
        marker.setContent(wpHtml);
      } else {
        // 创建新 Marker
        const marker = new AMap.Marker({
          position: pos,
          content: wpHtml,
          offset: new AMap.Pixel(-11, -11),
          zIndex: 180,
        });
        map.add(marker);
        wpMarkersRef.current.push(marker);
      }
    });

    // 移除多余的 Marker（如果有删减航点）
    while (wpMarkersRef.current.length > list.length) {
      const removed = wpMarkersRef.current.pop();
      try { map.remove(removed); } catch {}
    }

    // 若有 >= 2 个航点，绘制或更新航点规划折线（紫色虚线，区别于飞机历史青蓝轨迹）
    if (routePath.length >= 2) {
      if (!wpLineRef.current) {
        wpLineRef.current = new AMap.Polyline({
          path: routePath,
          strokeColor: '#c084fc',
          strokeWeight: 2,
          strokeOpacity: 0.85,
          strokeStyle: 'dashed',
          strokeDasharray: [8, 5],
          zIndex: 85
        });
        map.add(wpLineRef.current);
      } else {
        wpLineRef.current.setPath(routePath);
      }
    } else if (wpLineRef.current) {
      try { map.remove(wpLineRef.current); } catch {}
      wpLineRef.current = null;
    }
  }, [mapState, waypoints]);

  const hasValidGps = Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001;
  const hasReceivedGps = lastGpsPacketTime > 0;
  const isValidHome = (Math.abs(homeLat) > 0.0001 || Math.abs(homeLon) > 0.0001) && hasHomeGps;
  const distToHome = (hasValidGps && isValidHome) ? calculateDistanceM(lat, lon, homeLat, homeLon) : null;
  const hasWaypoints = waypoints && waypoints.length > 0;

  return (
    <div className="gcs-map-wrapper full-page-map">
      <div className="map-header-bar">
        <div className="map-title-row">
          <span className="map-title">高德航图 (GPS定位)</span>
          <span className={`map-badge ${hasValidGps ? 'gps-online' : (hasReceivedGps ? 'gps-receiving' : 'gps-waiting')}`}>
            {hasValidGps 
              ? `GPS信号锁定 (${numSat}星)` 
              : (hasReceivedGps 
                  ? `等待GPS信号 (${numSat}星 / ${gpsFix === 'No Fix' ? '未定位' : gpsFix})` 
                  : (localLocInfo ? `等待飞机GPS信息… (参考: ${localLocInfo.city || '本机网络'})` : '等待飞机GPS信息…')
                )
            }
          </span>
          {hasValidGps && (
            <span className="map-coord-text">
              机位: {lat.toFixed(6)}, {lon.toFixed(6)} | 高度: {alt}m
              {distToHome !== null && ` | 距返航点: ${distToHome}m`}
            </span>
          )}
          {hasWaypoints && (
            <span className="map-badge wp-badge">
              航点: {waypoints.length} 个
            </span>
          )}
        </div>

        <div className="map-ctrl-btns">
          {hasWaypoints && (
            <>
              <button 
                type="button" 
                className="map-chip-btn"
                onClick={() => {
                  if (mapRef.current && waypoints[0]) {
                    const firstGcj = wgs84ToGcj02(waypoints[0].lon, waypoints[0].lat);
                    mapRef.current.panTo([firstGcj.lng, firstGcj.lat]);
                  }
                }}
                title="地图视角平移至第 1 个航点 (WP #1)"
              >
                航点 ({waypoints.length})
              </button>
              <button 
                type="button" 
                className="map-chip-btn"
                onClick={() => {
                  if (onClearWaypoints) onClearWaypoints();
                }}
                title="清空当前航图上显示的规划航点与航线"
              >
                清空航点
              </button>
            </>
          )}
          {isValidHome && (
            <button 
              type="button" 
              className="map-chip-btn"
              onClick={() => {
                if (mapRef.current) {
                  const homeGcj = wgs84ToGcj02(homeLon, homeLat);
                  mapRef.current.panTo([homeGcj.lng, homeGcj.lat]);
                }
              }}
              title="地图视角平移至返航点 (HOME)"
            >
              返航点
            </button>
          )}
          <button 
            type="button" 
            className={`map-chip-btn ${layerMode === 'satellite' ? 'active' : ''}`}
            onClick={() => setLayerMode(m => m === 'satellite' ? 'normal' : 'satellite')}
          >
            {layerMode === 'satellite' ? '卫星图' : '标准图'}
          </button>
          <button 
            type="button" 
            className={`map-chip-btn ${autoFollow ? 'active' : ''}`}
            onClick={() => setAutoFollow(f => !f)}
          >
            {autoFollow ? '锁定居中: 开' : '锁定居中: 关'}
          </button>
          {trackCount > 0 && (
            <button 
              type="button" 
              className="map-chip-btn"
              title="清空当前飞机历史飞行轨迹"
              onClick={() => {
                trackPathRef.current = [];
                if (trackLineRef.current) {
                  try {
                    mapRef.current?.remove(trackLineRef.current);
                  } catch {}
                  trackLineRef.current = null;
                }
                setTrackCount(0);
              }}
            >
              清空轨迹 ({trackCount})
            </button>
          )}
        </div>
      </div>

      <div className="map-canvas-container">
        <div className="amap-target-box" ref={mapContainerRef}></div>

        {mapState === 'unconfigured' && (
          <div className="map-state-overlay">
            <form className="map-key-form" onSubmit={handleSaveKeys}>
              <p>高德地图密钥配置 (与隔壁 RuConfigurator 相同)</p>
              <input 
                type="text" 
                placeholder="高德 Web端 JSAPI Key" 
                value={inputKey} 
                onChange={e => setInputKey(e.target.value)} 
              />
              <input 
                type="text" 
                placeholder="高德 安全密钥 (Security Code)" 
                value={inputSec} 
                onChange={e => setInputSec(e.target.value)} 
              />
              <button type="submit" className="btn-primary-small">保存并加载地图</button>
            </form>
          </div>
        )}

        {mapState === 'loading' && (
          <div className="map-state-overlay">
            <span className="map-status-toast">高德地图资源加载中…</span>
          </div>
        )}

        {mapState === 'error' && (
          <div className="map-state-overlay">
            <div className="map-key-form">
              <p style={{ color: '#f87171' }}>加载失败：{errorMsg}</p>
              <button 
                type="button" 
                className="btn-primary-small"
                onClick={() => setMapState('unconfigured')}
              >
                重新设置 Key
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
