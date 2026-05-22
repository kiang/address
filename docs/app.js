const map = L.map('map', {zoomControl: false}).setView([23.7, 120.9], 8);
L.control.zoom({position: 'topright'}).addTo(map);
L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', {
    attribution: '&copy; 內政部國土測繪中心 | <a href="https://docs.google.com/forms/d/e/1FAIpQLSeMEfdW_1AG7-OBxD_P0_qW0WEUOwxSvZoLWsVLxvrRY7A8eA/viewform" target="_blank">府城 AI 科技診療室</a>',
    maxZoom: 20
}).addTo(map);

let currentData = null;
let currentSegment = 0;
let currentCity = null;
let currentCode = null;
let segmentLayers = [];
let allSegmentsLayer = null;

const panelBody = document.getElementById('panel-body');
const panelHeader = document.getElementById('panel-header');
const panel = document.getElementById('panel');
const segNav = document.getElementById('segment-nav');
const segInfo = document.getElementById('segment-info');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');

panelHeader.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    document.getElementById('panel-toggle').textContent =
        panel.classList.contains('collapsed') ? '▶' : '▼';
});

cityOrder.forEach(cityKey => {
    const cityLabel = cityNames[cityKey];
    const codes = cityDistricts[cityKey];

    const header = document.createElement('div');
    header.className = 'city-group-header';
    header.dataset.city = cityKey;
    header.innerHTML = `<span>${cityLabel} (${codes.length})</span><span class="toggle">▶</span>`;

    const container = document.createElement('div');
    container.className = 'city-districts';
    container.dataset.city = cityKey;

    codes.forEach(code => {
        const item = document.createElement('div');
        item.className = 'district-item';
        item.dataset.code = code;
        item.dataset.city = cityKey;
        item.innerHTML = `<span>${districtNames[code] || code}</span><span class="meta" id="meta-${code}"></span>`;
        item.addEventListener('click', () => loadDistrict(cityKey, code));
        container.appendChild(item);
    });

    header.addEventListener('click', () => {
        const isOpen = container.classList.contains('open');
        container.classList.toggle('open');
        header.querySelector('.toggle').textContent = isOpen ? '▶' : '▼';
    });

    panelBody.appendChild(header);
    panelBody.appendChild(container);
});

document.getElementById('search-input').addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    document.querySelectorAll('.city-group-header').forEach(header => {
        const cityKey = header.dataset.city;
        const cityLabel = cityNames[cityKey];
        const container = panelBody.querySelector(`.city-districts[data-city="${cityKey}"]`);
        const codes = cityDistricts[cityKey];

        if (!q) {
            header.style.display = '';
            container.style.display = '';
            container.classList.remove('open');
            header.querySelector('.toggle').textContent = '▶';
            container.querySelectorAll('.district-item').forEach(item => item.style.display = '');
            return;
        }

        const cityMatch = cityLabel.includes(q);
        let anyDistrictMatch = false;
        codes.forEach(code => {
            const name = districtNames[code] || code;
            const match = cityMatch || name.toLowerCase().includes(q) || code.includes(q);
            const item = container.querySelector(`[data-code="${code}"]`);
            if (item) item.style.display = match ? '' : 'none';
            if (match) anyDistrictMatch = true;
        });

        const show = cityMatch || anyDistrictMatch;
        header.style.display = show ? '' : 'none';
        container.style.display = show ? '' : 'none';
        if (show && q) {
            container.classList.add('open');
            header.querySelector('.toggle').textContent = '▼';
        }
    });
});

const trackingBar = document.getElementById('tracking-bar');

document.getElementById('btn-dashboard').addEventListener('click', openDashboard);
document.getElementById('btn-dashboard-close').addEventListener('click', closeDashboard);
updateDashboardButton();

document.getElementById('btn-track-start').addEventListener('click', startTracking);
document.getElementById('btn-track-stop').addEventListener('click', stopTracking);
document.getElementById('btn-track-clear').addEventListener('click', () => {
    if (confirm('確定清除此段的掃街紀錄？')) clearTrackForCurrentSegment();
});
document.getElementById('btn-track-export').addEventListener('click', () => {
    if (currentCity && currentCode != null) {
        exportTrack(makeSessionKey(currentCity, currentCode, currentSegment));
    }
});

function clearMap() {
    if (tracking.active) stopTracking();
    segmentLayers.forEach(l => map.removeLayer(l));
    segmentLayers = [];
    if (allSegmentsLayer) {
        map.removeLayer(allSegmentsLayer);
        allSegmentsLayer = null;
    }
}

async function loadDistrict(cityKey, code) {
    document.querySelectorAll('.district-item').forEach(el => {
        el.classList.toggle('active', el.dataset.code === code);
    });
    document.querySelectorAll('.city-group-header').forEach(el => {
        el.classList.toggle('active', el.dataset.city === cityKey);
    });

    const container = panelBody.querySelector(`.city-districts[data-city="${cityKey}"]`);
    if (container && !container.classList.contains('open')) {
        container.classList.add('open');
        const header = panelBody.querySelector(`.city-group-header[data-city="${cityKey}"]`);
        if (header) header.querySelector('.toggle').textContent = '▼';
    }

    clearMap();
    currentCity = cityKey;
    currentCode = code;

    const resp = await fetch(`output/${cityKey}/${code}.geojson`);
    currentData = await resp.json();
    currentSegment = 0;

    allSegmentsLayer = L.layerGroup().addTo(map);
    currentData.features.forEach((feat, i) => {
        const coords = feat.geometry.coordinates.map(c => [c[1], c[0]]);
        const line = L.polyline(coords, { color: '#999', weight: 2, opacity: 0.5 });
        line.on('click', () => showSegment(i));
        line.addTo(allSegmentsLayer);
    });

    const allBounds = allSegmentsLayer.getLayers().reduce((bounds, layer) => {
        return bounds.extend(layer.getBounds());
    }, L.latLngBounds([]));
    map.fitBounds(allBounds, { padding: [50, 50] });

    segNav.style.display = 'flex';
    showSegment(0);

    const metaEl = document.getElementById(`meta-${code}`);
    if (metaEl && !metaEl.textContent) {
        metaEl.textContent = `${currentData.features.length} 段`;
    }
}

function showSegment(idx) {
    currentSegment = idx;
    const total = currentData.features.length;
    const feat = currentData.features[idx];

    segmentLayers.forEach(l => map.removeLayer(l));
    segmentLayers = [];

    allSegmentsLayer.getLayers().forEach((layer, i) => {
        layer.setStyle({
            color: '#999',
            weight: i === idx ? 0 : 2,
            opacity: i === idx ? 0 : 0.4
        });
    });

    const coords = feat.geometry.coordinates.map(c => [c[1], c[0]]);

    const halo = L.polyline(coords, { color: '#fff', weight: 10, opacity: 0.9 }).addTo(map);
    segmentLayers.push(halo);

    const line = L.polyline(coords, { color: '#1a3a6b', weight: 5, opacity: 0.9 }).addTo(map);
    segmentLayers.push(line);

    const arrows = L.polylineDecorator(line, {
        patterns: [{
            offset: 20, repeat: 80,
            symbol: L.Symbol.arrowHead({
                pixelSize: 20, headAngle: 45,
                pathOptions: { color: '#fff', fillColor: '#1a3a6b', weight: 2, opacity: 1, fillOpacity: 1 }
            })
        }]
    }).addTo(map);
    segmentLayers.push(arrows);

    const startMarker = L.circleMarker(coords[0], {
        radius: 7, color: '#fff', fillColor: '#2ecc40', fillOpacity: 1, weight: 2
    }).bindTooltip('起點', { permanent: false }).addTo(map);
    segmentLayers.push(startMarker);

    const endMarker = L.circleMarker(coords[coords.length - 1], {
        radius: 7, color: '#fff', fillColor: '#e74c3c', fillOpacity: 1, weight: 2
    }).bindTooltip('終點', { permanent: false }).addTo(map);
    segmentLayers.push(endMarker);

    map.fitBounds(line.getBounds(), { padding: [60, 60] });

    const distName = districtNames[feat.properties.district] || feat.properties.district;
    const cityLabel = currentCity ? cityNames[currentCity] : '';
    segInfo.innerHTML = `<strong>${cityLabel} ${distName}</strong><br>第 ${idx + 1} / ${total} 段 (${feat.properties.km} km)`;

    btnPrev.disabled = idx === 0;
    btnNext.disabled = idx === total - 1;

    drawSavedTrack();
    trackingBar.style.display = 'flex';

    const saved = getTrackForSegment(currentCity, currentCode, idx);
    const btnExport = document.getElementById('btn-track-export');
    btnExport.style.display = (saved && saved.points.length > 0) ? '' : 'none';
    updateTrackingUI();
}

btnPrev.addEventListener('click', () => {
    if (currentSegment > 0) showSegment(currentSegment - 1);
});
btnNext.addEventListener('click', () => {
    if (currentSegment < currentData.features.length - 1) showSegment(currentSegment + 1);
});

function loadFromHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const parts = hash.split('/');
    if (parts.length >= 2) {
        const cityKey = parts[0];
        const code = parts[1];
        if (cityDistricts[cityKey] && cityDistricts[cityKey].includes(code)) {
            loadDistrict(cityKey, code);
        }
    }
}
loadFromHash();
