import { state, saveState } from './state.js';
import { logConsole, POI_PRESET_CATEGORIES } from './ui.js';

let directionsService;
let poiMarkers = []; 
let checklistMarkers = []; // pins for stop checklist items, kept separate from poiMarkers
                            // since they're cleared/redrawn independently and use a
                            // visually distinct icon (a list/flag pin instead of a dot).

// Each calculateRoute() call captures the generation counter at the moment it
// starts. Because the function is async and awaits directionsService.route()
// inside a loop, a second calculateRoute() call (e.g. triggered by another
// rapid edit before the first call's API requests have resolved) can begin
// and run its own "clear all layers" step while the first call is still
// mid-flight. When the first call's pending awaits eventually resolve, it
// would keep pushing layers onto (what it thinks is) state.mapLayers and
// otherwise mutating shared state — even though a newer call has already
// superseded it — leading to inconsistent or fully-blank map states that
// only a full page reload would clear up. Bumping/checking this counter after
// every await lets a stale call detect it's been superseded and bail out
// immediately without touching state.mapLayers, the DOM, or map bounds.
let routeCalculationGeneration = 0;

// Caches the result of each leg (one stop to the next) keyed by everything
// that could change its distance/duration/path: which two locations it
// connects, which travel mode, and whether traffic is factored in. On every
// calculateRoute() call, a leg whose key is unchanged from last time reuses
// its cached Directions/straight-line result and polyline instead of making
// a fresh API call — so editing one stop only triggers new API calls for the
// (at most two) legs actually touching that stop, not the whole trip.
// Keyed by a string built from buildLegCacheKey(); values are
// { distanceMiles, transitHours, polyline, isDrive }.
const legCache = new Map();

function buildLegCacheKey(originKey, destKey, mode, includeTraffic) {
    return `${originKey}::${destKey}::${mode}::${includeTraffic ? 'traffic' : 'notraffic'}`;
}

export function initMap() {
    logConsole("Initializing Google Maps Engine...");
    if (typeof google === 'undefined') {
        logConsole("ERROR: Google Maps API not loaded. Check index.html script tag.");
        return;
    }

    state.mapInstance = new google.maps.Map(document.getElementById('map'), {
        center: { lat: 39.8283, lng: -98.5795 },
        zoom: 4,
        
        // --- NEW ZOOM SETTINGS ---
        minZoom: 2,                     // Let the user zoom all the way out to a global view
        maxZoom: 22,                    // Let the user zoom all the way in to a single building
        isFractionalZoomEnabled: true,  // Unlocks smooth, in-between zoom levels for trackpads/scroll wheels
        // -------------------------

        disableDefaultUI: true,
        zoomControl: true,
        styles: [
            { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] }
        ]
    });

    directionsService = new google.maps.DirectionsService();
    state.mapLayers = [];

    // The map's container size depends on the surrounding flex layout (stat
    // panels above it, etc.), which may not have fully settled at the exact
    // moment the map is constructed. A deferred resize trigger plus a
    // re-center guards against the map initializing with a stale/incorrect
    // viewport (which can show as a gray box until something else forces a
    // re-layout).
    setTimeout(() => {
        if (state.mapInstance) {
            google.maps.event.trigger(state.mapInstance, 'resize');
            state.mapInstance.setCenter({ lat: 39.8283, lng: -98.5795 });
        }
    }, 100);
}

export async function calculateRoute() {
    if (!state.mapInstance || !directionsService) return;

    // Claim this invocation as the newest one. Any earlier in-flight call will
    // see a mismatch the next time it checks and stop mutating shared state.
    const myGeneration = ++routeCalculationGeneration;

    logConsole("Calculating routes...");

    state.mapLayers.forEach(layer => layer.setMap(null));
    state.mapLayers = [];

    if (state.stops.length < 2) return;

    // Track Distance
    let totalDistanceMiles = 0;
    let totalDriveMiles = 0;
    let totalFlightMiles = 0;
    
    // Track Time
    let totalTransitHours = 0;
    let totalDriveHours = 0;
    let totalFlightHours = 0;
    
    let totalStayDays = 0;
    const bounds = new google.maps.LatLngBounds();

    state.stops.forEach((stop, index) => {
        const geo = state.geoDatabase[stop.key];
        if (geo) {
            const position = { lat: geo.lat, lng: geo.lng };
            bounds.extend(position);
            const isSkipped = stop.skipped;

            const marker = new google.maps.Marker({
                position: position,
                map: state.mapInstance,
                label: { text: (index + 1).toString(), color: isSkipped ? "#6b7280" : "white", fontSize: "10px", fontWeight: "bold" },
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    fillColor: isSkipped ? "#e5e7eb" : (stop.isKeyDate ? "#b45309" : "#374151"),
                    fillOpacity: isSkipped ? 0.8 : 1,
                    strokeWeight: 2,
                    strokeColor: isSkipped ? "#9ca3af" : (stop.isKeyDate ? "#f59e0b" : "#4b5563"),
                    scale: 10
                },
                title: stop.key + (isSkipped ? " (Skipped)" : "")
            });
            state.mapLayers.push(marker);
        }
        if (!stop.skipped) totalStayDays += stop.days || 0;
    });

    const activeStops = state.stops.filter(s => !s.skipped);
    const legsUsedThisCalculation = new Set(); // cache keys still in use, so stale entries can be pruned below

    for (let i = 1; i <= activeStops.length; i++) {
        const prevStop = activeStops[i - 1];
        const currentStop = (i === activeStops.length) ? activeStops[0] : activeStops[i];
        const prevGeo = state.geoDatabase[prevStop.key];
        const currentGeo = state.geoDatabase[currentStop.key];

        if (!prevGeo || !currentGeo) continue;

        const origin = new google.maps.LatLng(prevGeo.lat, prevGeo.lng);
        const destination = new google.maps.LatLng(currentGeo.lat, currentGeo.lng);
        
        const legMode = (i === activeStops.length) ? (state.appSettings.returnMode || 'drive') : (currentStop.mode || 'drive');
        const isDrive = legMode !== 'flight';
        const includeTraffic = !!(state.appSettings && state.appSettings.includeTraffic && isDrive);
        const cacheKey = buildLegCacheKey(prevStop.key, currentStop.key, legMode, includeTraffic);
        legsUsedThisCalculation.add(cacheKey);

        const cached = legCache.get(cacheKey);
        if (cached) {
            // This exact leg (same origin, destination, mode, and traffic
            // setting) was already computed in a previous calculateRoute()
            // call — reuse its numbers and re-attach its existing polyline
            // instead of spending another Directions API call on it.
            currentStop.distanceMiles = cached.distanceMiles;
            currentStop.baseTransitHours = cached.transitHours;
            currentStop.transitHours = cached.transitHours;

            totalDistanceMiles += cached.distanceMiles;
            totalTransitHours += cached.transitHours;
            if (cached.isDrive) {
                totalDriveMiles += cached.distanceMiles;
                totalDriveHours += cached.transitHours;
            } else {
                totalFlightMiles += cached.distanceMiles;
                totalFlightHours += cached.transitHours;
            }

            cached.polyline.setMap(state.mapInstance);
            state.mapLayers.push(cached.polyline);
            continue;
        }

        if (isDrive) {
            try {
                const routeOptions = {
                    origin: origin, destination: destination, travelMode: google.maps.TravelMode.DRIVING
                };

                if (includeTraffic) {
                    routeOptions.drivingOptions = { departureTime: new Date(), trafficModel: google.maps.TrafficModel.BEST_GUESS };
                }

                const result = await new Promise((resolve, reject) => {
                    directionsService.route(routeOptions, (response, status) => {
                        if (status === 'OK') resolve(response); else reject(status);
                    });
                });

                // A newer calculateRoute() call may have started (and already
                // cleared/rebuilt state.mapLayers) while this one was waiting
                // on the Directions API. If so, this call is stale — stop here
                // rather than pushing a polyline into a map state that no
                // longer belongs to this invocation.
                if (myGeneration !== routeCalculationGeneration) return;

                const leg = result.routes[0].legs[0];
                const distanceMiles = Math.round(leg.distance.value * 0.000621371);
                const durationSeconds = (includeTraffic && leg.duration_in_traffic) ? leg.duration_in_traffic.value : leg.duration.value;
                const legHours = durationSeconds / 3600;

                currentStop.distanceMiles = distanceMiles;
                currentStop.baseTransitHours = legHours; 
                currentStop.transitHours = legHours;     
                
                totalDistanceMiles += distanceMiles;
                totalDriveMiles += distanceMiles; // Log to drive miles
                
                totalTransitHours += legHours;
                totalDriveHours += legHours;

                const polyline = new google.maps.Polyline({
                    path: result.routes[0].overview_path, geodesic: true, strokeColor: '#10b981', strokeOpacity: 0.9, strokeWeight: 4, map: state.mapInstance
                });
                state.mapLayers.push(polyline);
                legCache.set(cacheKey, { distanceMiles, transitHours: legHours, polyline, isDrive: true });
            } catch (error) {
                logConsole(`Drive api failed for ${currentStop.key}. Running fallback.`);
                drawStraightLine(origin, destination, true, currentStop, isDrive, cacheKey);
            }
        } else {
            drawStraightLine(origin, destination, false, currentStop, isDrive, cacheKey);
        }
    }

    // Any cache entry not touched by this calculation belongs to a leg that
    // no longer exists in the current trip (e.g. a stop was removed/reordered
    // such that this origin/destination pair is no longer adjacent). Drop its
    // polyline from the map and free the cache entry so it doesn't leak.
    for (const [key, entry] of legCache) {
        if (!legsUsedThisCalculation.has(key)) {
            entry.polyline.setMap(null);
            legCache.delete(key);
        }
    }

    function drawStraightLine(start, end, isFailedDrive, currentStop, isDriveLeg, cacheKey) {
        const R = 3958.8, dLat = (end.lat() - start.lat()) * Math.PI / 180, dLng = (end.lng() - start.lng()) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(start.lat() * Math.PI / 180) * Math.cos(end.lat() * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
        const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const legMiles = isFailedDrive ? miles * 1.25 : miles;
        const legHours = isFailedDrive ? legMiles / 62 : (legMiles / 500) + 1.5;

        if (currentStop) {
            currentStop.distanceMiles = Math.round(legMiles);
            currentStop.baseTransitHours = legHours; 
            currentStop.transitHours = legHours;
        }
        
        const roundedMiles = Math.round(legMiles);
        totalDistanceMiles += roundedMiles;
        
        if (isDriveLeg) {
            totalDriveHours += legHours;
            totalDriveMiles += roundedMiles;
        } else {
            totalFlightHours += legHours;
            totalFlightMiles += roundedMiles;
        }

        totalTransitHours += legHours;

        const lineSymbol = { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 };
        const polyline = new google.maps.Polyline({
            path: [start, end], geodesic: true, strokeColor: isFailedDrive ? '#10b981' : '#3b82f6', 
            strokeOpacity: isFailedDrive ? 0.9 : 0, strokeWeight: isFailedDrive ? 4 : 3,
            icons: isFailedDrive ? [] : [{ icon: lineSymbol, offset: '0', repeat: '15px' }],
            map: state.mapInstance
        });
        state.mapLayers.push(polyline);
        if (cacheKey) {
            legCache.set(cacheKey, { distanceMiles: roundedMiles, transitHours: legHours, polyline, isDrive: isDriveLeg });
        }
    }

    // Apply EV Charging Delay Proxy strictly to Drive Legs
    if (state.appSettings && state.appSettings.includeChargingDelays) {
        totalDriveHours = totalDriveHours * 1.10;
        totalTransitHours = totalDriveHours + totalFlightHours;
        activeStops.forEach(stop => { 
            if (stop.baseTransitHours && stop.mode !== 'flight') stop.transitHours = stop.baseTransitHours * 1.10; 
        });
    } else {
        activeStops.forEach(stop => { if (stop.baseTransitHours) stop.transitHours = stop.baseTransitHours; });
    }

    // --- AT THE BOTTOM OF calculateRoute() ---

    // Final staleness check: only the most recent calculateRoute() call should
    // update the stat panels, recenter the map, or trigger a timeline re-render.
    if (myGeneration !== routeCalculationGeneration) return;

    const transitDays = Math.floor(totalTransitHours / 10);
    
    // 1. Format Distance
    const statDistance = document.getElementById('stat-distance');
    if (statDistance) {
        statDistance.innerHTML = `
            <span class="text-sm font-bold text-gray-800 leading-none">${totalDistanceMiles.toLocaleString()} mi</span>
            <div class="flex flex-col text-[9px] text-gray-500 font-medium mt-1.5 leading-tight">
                <span>🚗 ${totalDriveMiles.toLocaleString()} mi</span>
                <span>✈️ ${totalFlightMiles.toLocaleString()} mi</span>
            </div>
        `;
    }
    
    // 2. Format Transit Times
    const statTransit = document.getElementById('stat-transit-days');
    if (statTransit) {
        statTransit.innerHTML = `
            <span class="text-sm font-bold text-blue-600 leading-none">${transitDays}d / ${totalTransitHours.toFixed(1)}h</span>
            <div class="flex flex-col text-[9px] text-gray-500 font-medium mt-1.5 leading-tight">
                <span>🚗 ${totalDriveHours.toFixed(1)}h</span>
                <span>✈️ ${totalFlightHours.toFixed(1)}h</span>
            </div>
        `;
    }
    
    // 3. Format Stay (With invisible spacer to preserve box height)
    const statStay = document.getElementById('stat-stay-days');
    if (statStay) {
        statStay.innerHTML = `
            <span class="text-sm font-bold text-emerald-600 leading-none">${totalStayDays}d</span>
            <div class="flex flex-col text-[9px] opacity-0 pointer-events-none mt-1.5 leading-tight select-none">
                <span>-</span><span>-</span>
            </div>
        `;
    }
    
    // 4. Format Total (With invisible spacer to preserve box height)
    const statTotal = document.getElementById('stat-total-days');
    if (statTotal) {
        statTotal.innerHTML = `
            <span class="text-sm font-bold text-amber-600 leading-none">${totalStayDays + transitDays}d</span>
            <div class="flex flex-col text-[9px] opacity-0 pointer-events-none mt-1.5 leading-tight select-none">
                <span>-</span><span>-</span>
            </div>
        `;
    }

    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();

    // The map's container is a flex-1 box sharing its column with the stat
    // panels above it. Updating those stat panels' innerHTML can change their
    // height (e.g. distance/hour text wrapping differently), which resizes
    // the map's container — but Google Maps doesn't detect container resizes
    // on its own. Without an explicit 'resize' trigger, the map keeps its old
    // tile layout and renders as a gray box until something else forces a
    // re-layout (e.g. manually panning/zooming, or a full page reload).
    google.maps.event.trigger(state.mapInstance, 'resize');

    if (!bounds.isEmpty()) state.mapInstance.fitBounds(bounds);
    logConsole("Routing complete.");
}

export function scanRouteForPOIs(directionsResult, keywords, searchRadiusMiles = 30) {
    if (!state.savedPOIs) state.savedPOIs = [];
    if (!Array.isArray(keywords)) keywords = [keywords];

    const route = directionsResult.routes[0];
    const path = route.overview_path;
    const radiusMeters = searchRadiusMiles * 1609.34; 
    const stepDistanceMeters = radiusMeters * 0.8; 
    
    let searchPoints = [path[0]];
    let accumulatedDistance = 0;

    for (let i = 0; i < path.length - 1; i++) {
        const p1 = path[i];
        const p2 = path[i+1];
        const dist = google.maps.geometry.spherical.computeDistanceBetween(p1, p2);
        accumulatedDistance += dist;
        if (accumulatedDistance >= stepDistanceMeters) {
            searchPoints.push(p2);
            accumulatedDistance = 0;
        }
    }
    searchPoints.push(path[path.length - 1]);

    const placesService = new google.maps.places.PlacesService(state.mapInstance);
    let newItemsFound = false;
    let scanTasks = [];
    
    searchPoints.forEach(point => {
        keywords.forEach(kw => scanTasks.push({ location: point, keyword: kw }));
    });
    
    scanTasks.forEach((task, index) => {
        setTimeout(() => {
            placesService.nearbySearch({
                location: task.location, radius: radiusMeters, keyword: task.keyword
            }, (results, status) => {
                if (status === google.maps.places.PlacesServiceStatus.OK && results) {
                    results.forEach(place => {
                        if (!state.savedPOIs.some(p => p.id === place.place_id)) {
                            state.savedPOIs.push({
                                id: place.place_id, name: place.name,
                                lat: place.geometry.location.lat(), lng: place.geometry.location.lng(),
                                address: place.vicinity, type: task.keyword
                            });
                            newItemsFound = true;
                        }
                    });
                }
                if (index === scanTasks.length - 1 && newItemsFound) {
                    // Persist directly rather than going through
                    // handleStateChange(), which would trigger a full
                    // calculateRoute() -> fitBounds() and re-zoom the map
                    // right after the person was just looking at scan
                    // results up close.
                    saveState();
                    renderSavedPOIs();          
                }
            });
        }, index * 300);
    });
}

// 5-pointed star path, centered at (0,0), used as a custom marker icon for
// saved POIs (ones already attached to a stop's checklist via sourcePoiId).
// Google Maps' built-in SymbolPath set has no star, so this is a hand-built
// SVG path rather than risking an external icon URL that might not exist.
const STAR_ICON_PATH = 'M 0,-10 L 2.245,-3.09 L 9.511,-3.09 L 3.633,1.18 L 5.878,8.09 L 0,3.82 L -5.878,8.09 L -3.633,1.18 L -9.511,-3.09 L -2.245,-3.09 Z';

export function renderSavedPOIs() {
    poiMarkers.forEach(m => m.setMap(null));
    poiMarkers = [];

    // If the setting is explicitly false, skip drawing POI markers
    if (state.appSettings && state.appSettings.showPOIPins === false) {
        renderChecklistItemPins(); // Still let checklist pins check their own toggle
        return;
    }

    if (state.savedPOIs && state.savedPOIs.length > 0) {
        const savedPoiIds = new Set();
        (state.stops || []).forEach(stop => {
            (stop.checklistItems || []).forEach(item => {
                if (item.sourcePoiId) savedPoiIds.add(item.sourcePoiId);
            });
        });

        state.savedPOIs.forEach(poi => {
            const matchedPreset = POI_PRESET_CATEGORIES.find(cat => cat.keyword.toLowerCase() === poi.type.toLowerCase());
            const iconColor = matchedPreset ? matchedPreset.color : 'red';
            const isSaved = savedPoiIds.has(poi.id);

            const marker = new google.maps.Marker({
                map: state.mapInstance,
                position: { lat: poi.lat, lng: poi.lng },
                title: poi.name + (isSaved ? ' (saved to checklist)' : ''),
                icon: isSaved
                    ? { path: STAR_ICON_PATH, fillColor: iconColor, fillOpacity: 1, strokeColor: '#1f2937', strokeWeight: 1, scale: 1.4 }
                    : { url: `http://maps.google.com/mapfiles/ms/icons/${iconColor}-dot.png` }
            });
            
            const mapsLink = `https://www.google.com/maps/search/?api=1&query=${poi.lat},${poi.lng}`;
            const infoWindow = new google.maps.InfoWindow({
                content: `<div class="p-2 min-w-[150px]"><strong class="text-sm">${poi.name}</strong>${isSaved ? ' ⭐' : ''}<br><span class="text-xs text-gray-500">${poi.address}</span><br><span class="text-[10px] text-gray-400 uppercase tracking-wide">${poi.type}</span><br><a href="${mapsLink}" target="_blank" rel="noopener noreferrer" class="mt-2 text-[10px] text-blue-600 font-bold uppercase tracking-wider hover:underline block">Open in Google Maps ↗</a><button onclick="window.openAddToChecklistPopover('${poi.id}', event)" class="mt-1 text-[10px] text-emerald-600 font-bold uppercase tracking-wider hover:underline block">+ Add to Stop Checklist</button><button onclick="window.removePOI('${poi.id}')" class="mt-1 text-[10px] text-red-500 font-bold uppercase tracking-wider hover:underline block">Delete Pin</button></div>`
            });
            
            marker.addListener('click', () => infoWindow.open(state.mapInstance, marker));
            poiMarkers.push(marker);
        });
    }

    renderChecklistItemPins();
}

// Draws a pin for every checklist item across every stop. Uses pushpin
// icons (rather than the dot icons POIs use) so the two pin types are
// visually distinguishable at a glance on a map that may have both at once.
// A checklist item keeps its own pin even after a matching savedPOI is
// deleted (and vice versa) — they're independent once attached, by design.
export function renderChecklistItemPins() {
    checklistMarkers.forEach(m => m.setMap(null));
    checklistMarkers = [];

    // If the setting is explicitly false, skip drawing sub-stop pins
    if (state.appSettings && state.appSettings.showSubStopPins === false) return;
    if (!state.stops) return;

    state.stops.forEach(stop => {
        (stop.checklistItems || []).forEach(item => {
            if (typeof item.lat !== 'number' || typeof item.lng !== 'number') return;

            const marker = new google.maps.Marker({
                map: state.mapInstance,
                position: { lat: item.lat, lng: item.lng },
                title: item.name,
                icon: { url: `http://maps.google.com/mapfiles/ms/icons/${item.done ? 'green' : 'orange'}-pushpin.png` }
            });

            const mapsLink = `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}`;
            const infoWindow = new google.maps.InfoWindow({
                content: `<div class="p-2 min-w-[150px]"><strong class="text-sm">${item.name}</strong><br><span class="text-xs text-gray-500">${item.address || ''}</span><br><span class="text-[10px] text-gray-400">Checklist item for ${stop.key}</span>${item.note ? `<br><span class="text-[10px] text-gray-600 italic">"${item.note}"</span>` : ''}<br><a href="${mapsLink}" target="_blank" rel="noopener noreferrer" class="mt-2 text-[10px] text-blue-600 font-bold uppercase tracking-wider hover:underline block">Open in Google Maps ↗</a><button onclick="window.removeChecklistItem('${stop.id}', '${item.id}')" class="mt-1 text-[10px] text-red-500 font-bold uppercase tracking-wider hover:underline block">Remove from Checklist</button></div>`
            });

            marker.addListener('click', () => infoWindow.open(state.mapInstance, marker));
            checklistMarkers.push(marker);
        });
    });
}

window.scanSpecificLeg = (startIndex, endIndex, keywords) => {
    const startStop = state.stops[startIndex];
    const endStop = state.stops[endIndex];
    if (!startStop || !endStop) return;

    const startGeo = state.geoDatabase[startStop.key];
    const endGeo = state.geoDatabase[endStop.key];
    if (!startGeo || !endGeo) return;

    const origin = new google.maps.LatLng(startGeo.lat, startGeo.lng);
    const destination = new google.maps.LatLng(endGeo.lat, endGeo.lng);

    // Fall back to the original default categories if called without an
    // explicit list (keeps any other existing callers working unchanged).
    const searchKeywords = (Array.isArray(keywords) && keywords.length > 0) ? keywords : ['Tesla Supercharger', 'Planet Fitness'];

    document.body.style.cursor = 'wait';
    const ds = new google.maps.DirectionsService();
    ds.route({ origin: origin, destination: destination, travelMode: google.maps.TravelMode.DRIVING }, (response, status) => {
        document.body.style.cursor = 'default';
        if (status === 'OK') {
            scanRouteForPOIs(response, searchKeywords, 30);
        } else {
            alert("Could not calculate the path for this scan.");
        }
    });
};

// Searches for POIs in a radius around a single stop, rather than along an
// entire route between two stops. Used by the per-stop "search near this
// stop" button. No DirectionsService call needed — it's a single Places
// nearbySearch per keyword, centered on the stop's own coordinates.
window.scanStopForPOIs = (stopIndex, keywords, searchRadiusMiles = 15) => {
    const stop = state.stops[stopIndex];
    if (!stop) return;
    const geo = state.geoDatabase[stop.key];
    if (!geo) return;
    if (!Array.isArray(keywords) || keywords.length === 0) return;

    if (!state.savedPOIs) state.savedPOIs = [];

    const location = new google.maps.LatLng(geo.lat, geo.lng);
    const radiusMeters = searchRadiusMiles * 1609.34;
    const placesService = new google.maps.places.PlacesService(state.mapInstance);
    let newItemsFound = false;

    document.body.style.cursor = 'wait';
    keywords.forEach((keyword, index) => {
        setTimeout(() => {
            placesService.nearbySearch({
                location, radius: radiusMeters, keyword
            }, (results, status) => {
                if (status === google.maps.places.PlacesServiceStatus.OK && results) {
                    results.forEach(place => {
                        if (!state.savedPOIs.some(p => p.id === place.place_id)) {
                            state.savedPOIs.push({
                                id: place.place_id, name: place.name,
                                lat: place.geometry.location.lat(), lng: place.geometry.location.lng(),
                                address: place.vicinity, type: keyword
                            });
                            newItemsFound = true;
                        }
                    });
                }
                if (index === keywords.length - 1) {
                    document.body.style.cursor = 'default';
                    if (newItemsFound) {
                        // Same reasoning as scanRouteForPOIs — persist
                        // directly, skip the route recalc and re-zoom.
                        saveState();
                        renderSavedPOIs();
                    }
                }
            });
        }, index * 300);
    });
};

window.renderSavedPOIs = renderSavedPOIs;
window.scanRouteForPOIs = scanRouteForPOIs;