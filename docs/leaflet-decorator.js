L.polylineDecorator = function(paths, options) { return new L.PolylineDecorator(paths, options); };
L.PolylineDecorator = L.FeatureGroup.extend({
    options: { patterns: [] },
    initialize: function(paths, options) {
        L.FeatureGroup.prototype.initialize.call(this);
        L.setOptions(this, options);
        this._paths = paths;
    },
    onAdd: function(map) {
        this._map = map;
        this._draw();
        map.on('zoomend', this._draw, this);
    },
    onRemove: function(map) {
        this.clearLayers();
        map.off('zoomend', this._draw, this);
    },
    _draw: function() {
        this.clearLayers();
        var latlngs = this._paths instanceof L.Polyline ? this._paths.getLatLngs() : this._paths;
        if (!latlngs || latlngs.length < 2) return;
        this.options.patterns.forEach(function(pattern) {
            this._drawPattern(latlngs, pattern);
        }, this);
    },
    _drawPattern: function(latlngs, pattern) {
        var offset = pattern.offset || '50%';
        var repeat = pattern.repeat || 100;
        var symbol = pattern.symbol;
        if (!symbol) return;
        var totalDist = 0;
        var segDists = [];
        for (var i = 1; i < latlngs.length; i++) {
            var d = this._map.latLngToLayerPoint(latlngs[i]).distanceTo(
                this._map.latLngToLayerPoint(latlngs[i-1]));
            segDists.push(d);
            totalDist += d;
        }
        var repeatPx = typeof repeat === 'string' && repeat.endsWith('%')
            ? totalDist * parseFloat(repeat) / 100 : repeat;
        if (repeatPx < 1) repeatPx = 1;
        var startOffset = typeof offset === 'string' && offset.endsWith('%')
            ? totalDist * parseFloat(offset) / 100 : offset;
        for (var dist = startOffset; dist < totalDist; dist += repeatPx) {
            var pos = this._getPointAtDistance(latlngs, segDists, dist);
            if (pos) {
                var marker = symbol.buildSymbol(pos.pt, pos.angle, this._map);
                if (marker) this.addLayer(marker);
            }
        }
    },
    _getPointAtDistance: function(latlngs, segDists, targetDist) {
        var accum = 0;
        for (var i = 0; i < segDists.length; i++) {
            if (accum + segDists[i] >= targetDist) {
                var ratio = (targetDist - accum) / segDists[i];
                var p1 = this._map.latLngToLayerPoint(latlngs[i]);
                var p2 = this._map.latLngToLayerPoint(latlngs[i+1]);
                var pt = L.point(p1.x + (p2.x - p1.x) * ratio, p1.y + (p2.y - p1.y) * ratio);
                var angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                return { pt: this._map.layerPointToLatLng(pt), angle: angle };
            }
            accum += segDists[i];
        }
        return null;
    }
});

L.Symbol = L.Symbol || {};
L.Symbol.arrowHead = function(options) { return new L.Symbol.ArrowHead(options); };
L.Symbol.ArrowHead = L.Class.extend({
    options: { pixelSize: 14, headAngle: 50, pathOptions: {} },
    initialize: function(options) { L.setOptions(this, options); },
    buildSymbol: function(latlng, angle, map) {
        var s = this.options.pixelSize;
        var ha = this.options.headAngle * Math.PI / 180 / 2;
        var center = map.latLngToLayerPoint(latlng);
        var tip = L.point(center.x + s * 0.4 * Math.cos(angle), center.y + s * 0.4 * Math.sin(angle));
        var p1 = L.point(center.x - s * Math.cos(angle - ha), center.y - s * Math.sin(angle - ha));
        var p2 = L.point(center.x - s * Math.cos(angle + ha), center.y - s * Math.sin(angle + ha));
        return L.polygon([
            map.layerPointToLatLng(tip),
            map.layerPointToLatLng(p1),
            map.layerPointToLatLng(p2)
        ], L.extend({ stroke: true, weight: 1, fill: true, fillOpacity: 0.85 }, this.options.pathOptions));
    }
});
