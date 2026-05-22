const STORAGE_KEY = 'sweep_tracks';
const MIN_DISTANCE_M = 10;
const TOUCH_RADIUS_M = 30;

let tracking = {
    active: false,
    watchId: null,
    sessionKey: null,
    lastPoint: null,
    gpsLine: null,
    gpsMarker: null,
    accuracyCircle: null,
    points: [],
    startTime: null,
    distanceM: 0,
    targetCoords: [],
    touchedSet: new Set(),
    touchMarkers: [],
    guideLine: null,
    guideTarget: null,
    nextTargetIdx: -1,
    nextTargetDist: 0,
    followUser: true
};

let wakeLock = null;

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* user denied or not supported */ }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (!tracking.active) return;
    if (document.visibilityState === 'visible') {
        requestWakeLock();
        if (tracking.watchId === null) {
            tracking.watchId = navigator.geolocation.watchPosition(
                onGpsPosition,
                onGpsError,
                { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
            );
        }
    }
});

function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function getAllTracks() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { return {}; }
}

function saveTrack(key, data) {
    const tracks = getAllTracks();
    tracks[key] = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
}

function deleteTrack(key) {
    const tracks = getAllTracks();
    delete tracks[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
}

function makeSegmentPrefix(city, code, segment) {
    return `${city}/${code}/${segment}`;
}

function makeSessionKey(city, code, segment, ts) {
    return `${city}/${code}/${segment}/${ts}`;
}

function getTracksForSegment(city, code, segment) {
    const prefix = makeSegmentPrefix(city, code, segment) + '/';
    const tracks = getAllTracks();
    const result = [];
    for (const key in tracks) {
        if (key.startsWith(prefix)) {
            result.push({ key, ...tracks[key] });
        }
    }
    result.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    return result;
}

function findNextTarget(lat, lng) {
    let minDist = Infinity;
    let minIdx = -1;
    for (let i = 0; i < tracking.targetCoords.length; i++) {
        if (tracking.touchedSet.has(i)) continue;
        const tp = tracking.targetCoords[i];
        const d = haversineM(lat, lng, tp.lat, tp.lng);
        if (d < minDist) {
            minDist = d;
            minIdx = i;
        }
    }
    tracking.nextTargetIdx = minIdx;
    tracking.nextTargetDist = minIdx >= 0 ? minDist : 0;
    return minIdx;
}

function updateGuide(lat, lng) {
    const idx = findNextTarget(lat, lng);
    if (idx < 0) {
        if (tracking.guideLine) { map.removeLayer(tracking.guideLine); tracking.guideLine = null; }
        if (tracking.guideTarget) { map.removeLayer(tracking.guideTarget); tracking.guideTarget = null; }
        return;
    }
    const tp = tracking.targetCoords[idx];
    const targetLL = [tp.lat, tp.lng];
    const userLL = [lat, lng];

    if (tracking.guideLine) {
        tracking.guideLine.setLatLngs([userLL, targetLL]);
    } else {
        tracking.guideLine = L.polyline([userLL, targetLL], {
            color: '#e74c3c', weight: 3, opacity: 0.7, dashArray: '6,8'
        }).addTo(map);
        segmentLayers.push(tracking.guideLine);
    }

    if (tracking.guideTarget) {
        tracking.guideTarget.setLatLng(targetLL);
    } else {
        tracking.guideTarget = L.circleMarker(targetLL, {
            radius: 10, color: '#e74c3c', fillColor: '#e74c3c',
            fillOpacity: 0.4, weight: 2
        }).addTo(map);
        segmentLayers.push(tracking.guideTarget);
    }
}

function startTracking(resumeKey) {
    if (tracking.active) return;
    if (!currentCity || !currentData) return;

    if (!navigator.geolocation) {
        alert('您的瀏覽器不支援 GPS 定位');
        return;
    }

    let key, existing;
    if (resumeKey) {
        key = resumeKey;
        const tracks = getAllTracks();
        existing = tracks[key] || null;
    } else {
        const ts = Date.now();
        key = makeSessionKey(currentCity, currentCode, currentSegment, ts);
        existing = null;
    }

    tracking.active = true;
    tracking.sessionKey = key;
    tracking.startTime = existing ? existing.startTime : Date.now();
    tracking.points = existing ? [...existing.points] : [];
    tracking.distanceM = existing ? existing.distanceM : 0;
    tracking.lastPoint = tracking.points.length > 0
        ? tracking.points[tracking.points.length - 1]
        : null;
    tracking.followUser = true;

    const feat = currentData.features[currentSegment];
    tracking.targetCoords = feat.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
    tracking.touchedSet = new Set(existing && existing.touchedPoints ? existing.touchedPoints : []);
    tracking.touchMarkers = [];
    drawTouchPoints();

    const latlngs = tracking.points.map(p => [p.lat, p.lng]);
    tracking.gpsLine = L.polyline(latlngs, {
        color: '#e67e22', weight: 4, opacity: 0.85, dashArray: '8,6'
    }).addTo(map);
    segmentLayers.push(tracking.gpsLine);

    tracking.gpsMarker = L.circleMarker([0, 0], {
        radius: 8, color: '#fff', fillColor: '#e67e22', fillOpacity: 1, weight: 3
    }).addTo(map);
    segmentLayers.push(tracking.gpsMarker);

    tracking.accuracyCircle = L.circle([0, 0], {
        radius: 0, color: '#e67e22', fillColor: '#e67e22',
        fillOpacity: 0.1, weight: 1, opacity: 0.3
    }).addTo(map);
    segmentLayers.push(tracking.accuracyCircle);

    tracking.guideLine = null;
    tracking.guideTarget = null;
    tracking.nextTargetIdx = -1;
    tracking.nextTargetDist = 0;

    tracking.watchId = navigator.geolocation.watchPosition(
        onGpsPosition,
        onGpsError,
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    requestWakeLock();
    map.on('dragstart', onUserDrag);

    updateTrackingUI();
}

function onUserDrag() {
    tracking.followUser = false;
}

function stopTracking() {
    if (!tracking.active) return;

    if (tracking.watchId !== null) {
        navigator.geolocation.clearWatch(tracking.watchId);
        tracking.watchId = null;
    }

    if (tracking.points.length > 0) {
        saveTrack(tracking.sessionKey, {
            startTime: tracking.startTime,
            points: tracking.points,
            distanceM: tracking.distanceM,
            city: currentCity,
            code: currentCode,
            segment: currentSegment,
            touchedPoints: [...tracking.touchedSet],
            totalRoutePoints: tracking.targetCoords.length
        });
    }

    tracking.touchMarkers.forEach(m => map.removeLayer(m));
    if (tracking.guideLine) { map.removeLayer(tracking.guideLine); }
    if (tracking.guideTarget) { map.removeLayer(tracking.guideTarget); }
    releaseWakeLock();
    map.off('dragstart', onUserDrag);

    tracking.active = false;
    tracking.sessionKey = null;
    tracking.lastPoint = null;
    tracking.gpsLine = null;
    tracking.gpsMarker = null;
    tracking.accuracyCircle = null;
    tracking.points = [];
    tracking.startTime = null;
    tracking.distanceM = 0;
    tracking.targetCoords = [];
    tracking.touchedSet = new Set();
    tracking.touchMarkers = [];
    tracking.guideLine = null;
    tracking.guideTarget = null;
    tracking.nextTargetIdx = -1;
    tracking.nextTargetDist = 0;
    tracking.followUser = true;

    updateTrackingUI();
}

function onGpsPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;
    const ts = pos.timestamp;

    if (tracking.gpsMarker) tracking.gpsMarker.setLatLng([lat, lng]);
    if (tracking.accuracyCircle) {
        tracking.accuracyCircle.setLatLng([lat, lng]);
        tracking.accuracyCircle.setRadius(acc);
    }

    if (tracking.followUser) {
        map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: true });
    }

    updateGuide(lat, lng);

    if (tracking.lastPoint) {
        const d = haversineM(tracking.lastPoint.lat, tracking.lastPoint.lng, lat, lng);
        if (d < MIN_DISTANCE_M) {
            updateTrackingStats();
            return;
        }
        tracking.distanceM += d;
    }

    const point = { lat, lng, acc, ts };
    tracking.points.push(point);
    tracking.lastPoint = point;

    if (tracking.gpsLine) tracking.gpsLine.addLatLng([lat, lng]);

    checkTouchPoints(lat, lng, ts);

    if (tracking.points.length % 5 === 0) {
        saveTrack(tracking.sessionKey, {
            startTime: tracking.startTime,
            points: tracking.points,
            distanceM: tracking.distanceM,
            city: currentCity,
            code: currentCode,
            segment: currentSegment,
            touchedPoints: [...tracking.touchedSet],
            totalRoutePoints: tracking.targetCoords.length
        });
    }

    updateTrackingStats();
}

function onGpsError(err) {
    console.warn('GPS error:', err.message);
    const statsEl = document.getElementById('tracking-stats');
    if (statsEl) statsEl.textContent = 'GPS 訊號取得失敗，請確認定位權限';
}

function updateTrackingUI() {
    const btnStart = document.getElementById('btn-track-start');
    const btnStop = document.getElementById('btn-track-stop');
    const btnRecenter = document.getElementById('btn-recenter');
    const statsEl = document.getElementById('tracking-stats');

    if (!btnStart) return;

    const segNavEl = document.getElementById('segment-nav');

    if (tracking.active) {
        btnStart.style.display = 'none';
        btnStop.style.display = '';
        btnRecenter.style.display = '';
        if (segNavEl) segNavEl.style.display = 'none';
        updateTrackingStats();
    } else {
        btnStop.style.display = 'none';
        btnRecenter.style.display = 'none';
        btnStart.textContent = '開始掃街';
        statsEl.textContent = '';
        btnStart.style.display = '';
        if (segNavEl) segNavEl.style.display = 'flex';
    }

    updateDashboardButton();
}

function updateTrackingStats() {
    const statsEl = document.getElementById('tracking-stats');
    if (!statsEl) return;
    const km = (tracking.distanceM / 1000).toFixed(2);
    const elapsed = Math.floor((Date.now() - tracking.startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const touched = tracking.touchedSet.size;
    const total = tracking.targetCoords.length;
    const remaining = total - touched;
    const pct = total > 0 ? Math.round(touched / total * 100) : 0;
    let nextInfo = '';
    if (tracking.nextTargetIdx >= 0) {
        const distM = Math.round(tracking.nextTargetDist);
        nextInfo = distM >= 1000
            ? ` · 下一點 ${(distM / 1000).toFixed(1)} km`
            : ` · 下一點 ${distM} m`;
    } else if (remaining === 0 && total > 0) {
        nextInfo = ' · 全部完成!';
    }
    statsEl.innerHTML =
        `${km} km / ${min}:${sec.toString().padStart(2, '0')}` +
        `<br>路線點: ${touched}/${total} (${pct}%) · 剩餘 ${remaining}${nextInfo}`;
}

function checkTouchPoints(lat, lng, ts) {
    let changed = false;
    for (let i = 0; i < tracking.targetCoords.length; i++) {
        if (tracking.touchedSet.has(i)) continue;
        const tp = tracking.targetCoords[i];
        const d = haversineM(lat, lng, tp.lat, tp.lng);
        if (d <= TOUCH_RADIUS_M) {
            tracking.touchedSet.add(i);
            changed = true;
        }
    }
    if (changed) {
        drawTouchPoints();
        updateGuide(lat, lng);
    }
}

function drawTouchPoints() {
    tracking.touchMarkers.forEach(m => map.removeLayer(m));
    tracking.touchMarkers = [];

    for (let i = 0; i < tracking.targetCoords.length; i++) {
        const tp = tracking.targetCoords[i];
        const touched = tracking.touchedSet.has(i);
        const marker = L.circleMarker([tp.lat, tp.lng], {
            radius: 4,
            color: touched ? '#2ecc40' : '#ccc',
            fillColor: touched ? '#2ecc40' : '#eee',
            fillOpacity: touched ? 0.9 : 0.5,
            weight: 1
        }).addTo(map);
        tracking.touchMarkers.push(marker);
        segmentLayers.push(marker);
    }
}

function drawSavedTracks() {
    if (!currentCity || currentCode == null) return;
    const saved = getTracksForSegment(currentCity, currentCode, currentSegment);
    const colors = ['#e67e22', '#9b59b6', '#1abc9c', '#e74c3c', '#3498db'];
    saved.forEach((t, i) => {
        if (!t.points || t.points.length < 2) return;
        const latlngs = t.points.map(p => [p.lat, p.lng]);
        const line = L.polyline(latlngs, {
            color: colors[i % colors.length], weight: 4, opacity: 0.7, dashArray: '8,6'
        }).addTo(map);
        segmentLayers.push(line);
    });
}

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function computeTrackAnalytics(t) {
    const pts = t.points || [];
    const distKm = (t.distanceM || 0) / 1000;
    let durationMs = 0;
    if (pts.length >= 2) {
        durationMs = pts[pts.length - 1].ts - pts[0].ts;
    }
    const durationMin = durationMs / 60000;
    const avgSpeedKmh = durationMin > 0 ? (distKm / durationMin) * 60 : 0;
    const avgAcc = pts.length > 0
        ? pts.reduce((sum, p) => sum + (p.acc || 0), 0) / pts.length
        : 0;
    const touchedCount = t.touchedPoints ? t.touchedPoints.length : 0;
    const totalRoute = t.totalRoutePoints || 0;
    const touchPct = totalRoute > 0 ? Math.round(touchedCount / totalRoute * 100) : 0;
    return {
        pointCount: pts.length,
        distKm,
        durationMs,
        durationStr: formatDuration(durationMs),
        avgSpeedKmh: +avgSpeedKmh.toFixed(1),
        avgAccM: +avgAcc.toFixed(1),
        startTime: t.startTime || (pts.length > 0 ? pts[0].ts : 0),
        endTime: pts.length > 0 ? pts[pts.length - 1].ts : 0,
        touchedCount,
        totalRoutePoints: totalRoute,
        remainingPoints: totalRoute - touchedCount,
        touchPct
    };
}

function computeSummary(tracks) {
    let totalDist = 0, totalDuration = 0, totalPoints = 0, trackCount = 0;
    let totalTouched = 0, totalRoutePoints = 0;
    const cities = new Set();
    const districts = new Set();
    for (const key in tracks) {
        const t = tracks[key];
        const a = computeTrackAnalytics(t);
        totalDist += a.distKm;
        totalDuration += a.durationMs;
        totalPoints += a.pointCount;
        totalTouched += a.touchedCount;
        totalRoutePoints += a.totalRoutePoints;
        trackCount++;
        if (t.city) cities.add(t.city);
        if (t.code) districts.add(t.code);
    }
    const totalTouchPct = totalRoutePoints > 0 ? Math.round(totalTouched / totalRoutePoints * 100) : 0;
    return {
        trackCount,
        totalDistKm: +totalDist.toFixed(2),
        totalDurationStr: formatDuration(totalDuration),
        totalDurationMs: totalDuration,
        totalPoints,
        cityCount: cities.size,
        districtCount: districts.size,
        totalTouched,
        totalRoutePoints,
        totalTouchPct
    };
}

function openDashboard() {
    document.getElementById('dashboard-modal').style.display = 'flex';
    renderDashboardList();
}

function closeDashboard() {
    document.getElementById('dashboard-modal').style.display = 'none';
}

function renderDashboardList() {
    const list = document.getElementById('dashboard-list');
    const tracks = getAllTracks();
    const keys = Object.keys(tracks);

    if (keys.length === 0) {
        list.innerHTML = '<div class="dashboard-empty">尚無掃街紀錄</div>';
        return;
    }

    keys.sort((a, b) => (tracks[b].startTime || 0) - (tracks[a].startTime || 0));

    list.innerHTML = '';

    const summary = computeSummary(tracks);
    const summaryEl = document.createElement('div');
    summaryEl.className = 'dashboard-summary';
    summaryEl.innerHTML =
        `<div class="summary-title">總計</div>` +
        (summary.totalRoutePoints > 0
            ? `<div class="track-progress summary-progress"><div class="progress-bar"><div class="progress-fill" style="width:${summary.totalTouchPct}%"></div></div><span class="progress-text">路線覆蓋 ${summary.totalTouched}/${summary.totalRoutePoints} 點 (${summary.totalTouchPct}%)</span></div>`
            : '') +
        `<div class="summary-grid">` +
            `<div class="summary-stat"><span class="summary-value">${summary.trackCount}</span><span class="summary-label">筆紀錄</span></div>` +
            `<div class="summary-stat"><span class="summary-value">${summary.totalDistKm}</span><span class="summary-label">公里</span></div>` +
            `<div class="summary-stat"><span class="summary-value">${summary.totalDurationStr}</span><span class="summary-label">總時間</span></div>` +
            `<div class="summary-stat"><span class="summary-value">${summary.totalPoints}</span><span class="summary-label">GPS 點</span></div>` +
            `<div class="summary-stat"><span class="summary-value">${summary.cityCount}</span><span class="summary-label">縣市</span></div>` +
            `<div class="summary-stat"><span class="summary-value">${summary.districtCount}</span><span class="summary-label">行政區</span></div>` +
        `</div>`;
    list.appendChild(summaryEl);

    keys.forEach(key => {
        const t = tracks[key];
        const city = t.city;
        const code = t.code;
        const seg = t.segment;
        const a = computeTrackAnalytics(t);

        const cityLabel = cityNames[city] || city;
        const distLabel = districtNames[code] || code;
        const date = a.startTime ? new Date(a.startTime).toLocaleString('zh-TW') : '';

        const item = document.createElement('div');
        item.className = 'track-item';
        item.innerHTML =
            `<div class="track-item-header">` +
                `<div>` +
                    `<div class="track-item-title">${cityLabel} ${distLabel} 第 ${seg + 1} 段</div>` +
                    `<div class="track-item-meta">${date}</div>` +
                `</div>` +
                `<button class="track-item-toggle">&#x25BC;</button>` +
            `</div>` +
            `<div class="track-item-details" style="display:none">` +
                (a.totalRoutePoints > 0
                    ? `<div class="track-progress"><div class="progress-bar"><div class="progress-fill" style="width:${a.touchPct}%"></div></div><span class="progress-text">${a.touchedCount}/${a.totalRoutePoints} 點 (${a.touchPct}%) · 剩餘 ${a.remainingPoints}</span></div>`
                    : '') +
                `<div class="track-details-grid">` +
                    `<div class="detail-cell"><span class="detail-value">${a.distKm.toFixed(2)}</span><span class="detail-label">公里</span></div>` +
                    `<div class="detail-cell"><span class="detail-value">${a.durationStr}</span><span class="detail-label">時間</span></div>` +
                    `<div class="detail-cell"><span class="detail-value">${a.avgSpeedKmh}</span><span class="detail-label">km/h</span></div>` +
                    `<div class="detail-cell"><span class="detail-value">${a.pointCount}</span><span class="detail-label">GPS 點</span></div>` +
                    `<div class="detail-cell"><span class="detail-value">${a.avgAccM}</span><span class="detail-label">平均精度(m)</span></div>` +
                    `<div class="detail-cell"><span class="detail-value">${a.endTime ? new Date(a.endTime).toLocaleTimeString('zh-TW') : '-'}</span><span class="detail-label">最後記錄</span></div>` +
                `</div>` +
                `<div class="track-item-actions">` +
                    `<button class="track-btn-continue">繼續</button>` +
                    `<button class="track-btn-export">匯出</button>` +
                    `<button class="track-btn-delete">刪除</button>` +
                `</div>` +
            `</div>`;

        const toggleBtn = item.querySelector('.track-item-toggle');
        const details = item.querySelector('.track-item-details');
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = details.style.display !== 'none';
            details.style.display = open ? 'none' : '';
            toggleBtn.textContent = open ? '▼' : '▲';
        });

        item.querySelector('.track-item-header').addEventListener('click', () => {
            const open = details.style.display !== 'none';
            details.style.display = open ? 'none' : '';
            toggleBtn.textContent = open ? '▼' : '▲';
        });

        item.querySelector('.track-btn-continue').addEventListener('click', () => {
            closeDashboard();
            loadDistrict(city, code).then(() => {
                showSegment(seg);
                startTracking(key);
            });
        });

        item.querySelector('.track-btn-export').addEventListener('click', () => {
            showExportMenu(`匯出紀錄 - ${cityLabel} ${distLabel}`, (fmt) => exportTrack(key, fmt));
        });

        item.querySelector('.track-btn-delete').addEventListener('click', () => {
            if (confirm(`確定刪除「${cityLabel} ${distLabel} 第 ${seg + 1} 段」的紀錄？`)) {
                deleteTrack(key);
                renderDashboardList();
                updateDashboardButton();
            }
        });

        list.appendChild(item);
    });
}

function updateDashboardButton() {
    const btn = document.getElementById('btn-dashboard');
    if (!btn) return;
    const tracks = getAllTracks();
    const count = Object.keys(tracks).length;
    if (count > 0) {
        btn.classList.add('has-tracks');
        btn.textContent = `紀錄 (${count})`;
    } else {
        btn.classList.remove('has-tracks');
        btn.textContent = '掃街紀錄';
    }
}

function coordsToKML(coords, name, description) {
    const coordStr = coords.map(c => `${c[0]},${c[1]},0`).join('\n            ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(description)}</description>
    <Style id="line"><LineStyle><color>ff0000ff</color><width>3</width></LineStyle></Style>
    <Placemark>
      <name>${escapeXml(name)}</name>
      <styleUrl>#line</styleUrl>
      <LineString>
        <coordinates>
            ${coordStr}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportTrack(key, format) {
    const tracks = getAllTracks();
    const track = tracks[key];
    if (!track) return;

    const cityLabel = cityNames[track.city] || track.city;
    const distLabel = districtNames[track.code] || track.code;
    const name = `${cityLabel} ${distLabel} 第 ${track.segment + 1} 段 掃街紀錄`;
    const coords = track.points.map(p => [p.lng, p.lat]);
    const fileBase = `track_${key.replace(/\//g, '_')}`;

    if (format === 'kml') {
        const desc = `距離: ${(track.distanceM / 1000).toFixed(2)} km, GPS點: ${track.points.length}`;
        const kml = coordsToKML(coords, name, desc);
        downloadFile(kml, `${fileBase}.kml`, 'application/vnd.google-earth.kml+xml');
    } else {
        const geojson = {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {
                    name,
                    city: track.city,
                    district: track.code,
                    segment: track.segment + 1,
                    distanceKm: +(track.distanceM / 1000).toFixed(2),
                    startTime: new Date(track.startTime).toISOString(),
                    pointCount: track.points.length
                },
                geometry: { type: 'LineString', coordinates: coords }
            }]
        };
        downloadFile(JSON.stringify(geojson, null, 2), `${fileBase}.geojson`, 'application/json');
    }
}

function exportRoute(format) {
    if (!currentData || !currentCity) return;
    const feat = currentData.features[currentSegment];
    const cityLabel = cityNames[currentCity] || currentCity;
    const distLabel = districtNames[currentCode] || currentCode;
    const name = `${cityLabel} ${distLabel} 第 ${currentSegment + 1} 段 路線`;
    const coords = feat.geometry.coordinates.map(c => [c[0], c[1]]);
    const fileBase = `route_${currentCity}_${currentCode}_${currentSegment + 1}`;

    if (format === 'kml') {
        const desc = `${feat.properties.km} km`;
        const kml = coordsToKML(coords, name, desc);
        downloadFile(kml, `${fileBase}.kml`, 'application/vnd.google-earth.kml+xml');
    } else {
        const geojson = {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: {
                    name,
                    city: currentCity,
                    district: currentCode,
                    segment: currentSegment + 1,
                    km: feat.properties.km
                },
                geometry: feat.geometry
            }]
        };
        downloadFile(JSON.stringify(geojson, null, 2), `${fileBase}.geojson`, 'application/json');
    }
}

let pendingExportAction = null;

function showExportMenu(title, action) {
    pendingExportAction = action;
    const menu = document.getElementById('export-menu');
    menu.querySelector('.export-menu-title').textContent = title;
    menu.style.display = 'flex';
}

function hideExportMenu() {
    document.getElementById('export-menu').style.display = 'none';
    pendingExportAction = null;
}

document.querySelectorAll('#export-menu .export-opt').forEach(btn => {
    btn.addEventListener('click', () => {
        if (pendingExportAction) pendingExportAction(btn.dataset.format);
        hideExportMenu();
    });
});
document.querySelector('#export-menu .export-cancel').addEventListener('click', hideExportMenu);
