const STORAGE_KEY = 'sweep_tracks';
const MIN_DISTANCE_M = 10;

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
    distanceM: 0
};

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

    tracking.watchId = navigator.geolocation.watchPosition(
        onGpsPosition,
        onGpsError,
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    updateTrackingUI();
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
            segment: currentSegment
        });
    }

    tracking.active = false;
    tracking.sessionKey = null;
    tracking.lastPoint = null;
    tracking.gpsLine = null;
    tracking.gpsMarker = null;
    tracking.accuracyCircle = null;
    tracking.points = [];
    tracking.startTime = null;
    tracking.distanceM = 0;

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

    if (tracking.lastPoint) {
        const d = haversineM(tracking.lastPoint.lat, tracking.lastPoint.lng, lat, lng);
        if (d < MIN_DISTANCE_M) return;
        tracking.distanceM += d;
    }

    const point = { lat, lng, acc, ts };
    tracking.points.push(point);
    tracking.lastPoint = point;

    if (tracking.gpsLine) tracking.gpsLine.addLatLng([lat, lng]);

    if (tracking.points.length % 5 === 0) {
        saveTrack(tracking.sessionKey, {
            startTime: tracking.startTime,
            points: tracking.points,
            distanceM: tracking.distanceM,
            city: currentCity,
            code: currentCode,
            segment: currentSegment
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
    const statsEl = document.getElementById('tracking-stats');

    if (!btnStart) return;

    if (tracking.active) {
        btnStart.style.display = 'none';
        btnStop.style.display = '';
        updateTrackingStats();
    } else {
        btnStop.style.display = 'none';
        btnStart.textContent = '開始掃街';
        statsEl.textContent = '';
        btnStart.style.display = '';
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
    statsEl.textContent = `${tracking.points.length} 點 / ${km} km / ${min}:${sec.toString().padStart(2, '0')}`;
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
    keys.forEach(key => {
        const t = tracks[key];
        const city = t.city;
        const code = t.code;
        const seg = t.segment;

        const cityLabel = cityNames[city] || city;
        const distLabel = districtNames[code] || code;
        const km = (t.distanceM / 1000).toFixed(2);
        const pts = t.points ? t.points.length : 0;
        const date = t.startTime ? new Date(t.startTime).toLocaleString('zh-TW') : '';

        const item = document.createElement('div');
        item.className = 'track-item';
        item.innerHTML =
            `<div class="track-item-title">${cityLabel} ${distLabel} 第 ${seg + 1} 段</div>` +
            `<div class="track-item-meta">${date} / ${pts} 點 / ${km} km</div>` +
            `<div class="track-item-actions">` +
                `<button class="track-btn-continue">繼續</button>` +
                `<button class="track-btn-export">匯出</button>` +
                `<button class="track-btn-delete">刪除</button>` +
            `</div>`;

        item.querySelector('.track-btn-continue').addEventListener('click', () => {
            closeDashboard();
            loadDistrict(city, code).then(() => {
                showSegment(seg);
                startTracking(key);
            });
        });

        item.querySelector('.track-btn-export').addEventListener('click', () => {
            exportTrack(key);
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

function exportTrack(key) {
    const tracks = getAllTracks();
    const track = tracks[key];
    if (!track) return;

    const features = [{
        type: 'Feature',
        properties: {
            city: track.city,
            district: track.code,
            segment: track.segment + 1,
            distanceKm: +(track.distanceM / 1000).toFixed(2),
            startTime: new Date(track.startTime).toISOString(),
            pointCount: track.points.length
        },
        geometry: {
            type: 'LineString',
            coordinates: track.points.map(p => [p.lng, p.lat])
        }
    }];
    const geojson = { type: 'FeatureCollection', features };
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `track_${key.replace(/\//g, '_')}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
}
