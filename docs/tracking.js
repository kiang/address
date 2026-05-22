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

function makeSessionKey(city, code, segment) {
    return `${city}/${code}/${segment}`;
}

function getTrackForSegment(city, code, segment) {
    const key = makeSessionKey(city, code, segment);
    const tracks = getAllTracks();
    return tracks[key] || null;
}

function startTracking() {
    if (tracking.active) return;
    if (!currentCity || !currentData) return;

    if (!navigator.geolocation) {
        alert('您的瀏覽器不支援 GPS 定位');
        return;
    }

    const key = makeSessionKey(currentCity, currentCode, currentSegment);
    const existing = getTrackForSegment(currentCity, currentCode, currentSegment);

    tracking.active = true;
    tracking.sessionKey = key;
    tracking.startTime = existing ? existing.startTime : Date.now();
    tracking.points = existing ? existing.points : [];
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
    const btnClear = document.getElementById('btn-track-clear');
    const statsEl = document.getElementById('tracking-stats');

    if (!btnStart) return;

    if (tracking.active) {
        btnStart.style.display = 'none';
        btnStop.style.display = '';
        btnClear.style.display = 'none';
        updateTrackingStats();
    } else {
        btnStop.style.display = 'none';

        const saved = currentCity && currentCode != null
            ? getTrackForSegment(currentCity, currentCode, currentSegment)
            : null;
        if (saved && saved.points.length > 0) {
            btnStart.textContent = '繼續掃街';
            btnClear.style.display = '';
            statsEl.textContent = `已記錄 ${saved.points.length} 點 / ${(saved.distanceM / 1000).toFixed(2)} km`;
        } else {
            btnStart.textContent = '開始掃街';
            btnClear.style.display = 'none';
            statsEl.textContent = '';
        }
        btnStart.style.display = '';
    }
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

function clearTrackForCurrentSegment() {
    if (!currentCity || currentCode == null) return;
    const key = makeSessionKey(currentCity, currentCode, currentSegment);
    deleteTrack(key);
    updateTrackingUI();
    showSegment(currentSegment);
}

function drawSavedTrack() {
    if (!currentCity || currentCode == null) return;
    const saved = getTrackForSegment(currentCity, currentCode, currentSegment);
    if (!saved || saved.points.length < 2) return;

    const latlngs = saved.points.map(p => [p.lat, p.lng]);
    const line = L.polyline(latlngs, {
        color: '#e67e22', weight: 4, opacity: 0.7, dashArray: '8,6'
    }).addTo(map);
    segmentLayers.push(line);
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
