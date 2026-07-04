export const state = {
    geoDatabase: {
        "San Francisco, CA": { lat: 37.7749, lng: -122.4194 },
        "Denver, CO": { lat: 39.7392, lng: -104.9903 },
        "Philadelphia, PA": { lat: 39.9526, lng: -75.1652 },
        "Toronto, ON": { lat: 43.6510, lng: -79.3470 }
    },
    appSettings: { 
        engine: 'standard',
        autoCalc: false,
        vehicleRange: 260,
        showGlobalChargers: true,
        includeTraffic: false,
        includeChargingDelays: false,
        showTimelineInactiveStops: true,
        startDate: new Date().toISOString().split('T')[0],
        showTimelineStops: true,
        showTimelineTransit: true,
        // Without these two existing here, updateSettings()'s hasOwnProperty
        // guard silently refuses to persist changes made via the return-leg
        // transit pill's mode dropdown / days input — they'd appear to work
        // for the current render but revert on the next reload or edit.
        returnMode: 'drive',
        returnTransitDays: null  // null = "not set yet"; falls back to a
                                  // computed default (Math.floor(retHours/10))
                                  // in ui.js until the person edits it directly.
    }, 
    keyDates: [], // The Master Library of Constraints
    stops: [
        { id: "1", key: "San Francisco, CA", mode: "drive", days: 1 },
        { id: "2", key: "Denver, CO", mode: "drive", days: 3 },
        { id: "3", key: "Philadelphia, PA", mode: "drive", days: 4 },
        { id: "4", key: "Toronto, ON", mode: "drive", days: 3 }
    ],
    savedPOIs: [], // Charger/brewery/etc. pins saved from the POI scan popover
    mapInstance: null,
    mapLayers: [],
    currentSelectedGeo: null,
    currentSelectedKeyDateGeo: null,
    searchTimeout: null
};

// --- CENTRALIZED PERSISTENCE ---

export function saveState() {
    // We package the entire state object into one single JSON block
    const dataToSave = { 
        stops: state.stops, 
        appSettings: state.appSettings, 
        geoDatabase: state.geoDatabase, 
        keyDates: state.keyDates,
        savedPOIs: state.savedPOIs,
        includeTraffic: state.appSettings.includeTraffic // Synced up from settings block
    };
    localStorage.setItem('hybridRoutePlanner', JSON.stringify(dataToSave));
}

export function loadState() {
    const saved = localStorage.getItem('hybridRoutePlanner');
    if (!saved) return;

    try {
        const parsed = JSON.parse(saved);
        // Deep merge/overwrite the state object safely
        if (parsed.stops) state.stops = parsed.stops;
        if (parsed.keyDates) state.keyDates = parsed.keyDates;
        if (parsed.geoDatabase) state.geoDatabase = parsed.geoDatabase;
        if (parsed.savedPOIs) state.savedPOIs = parsed.savedPOIs;
        if (parsed.appSettings) {
            state.appSettings = { ...state.appSettings, ...parsed.appSettings };
            
            // Sync any existing range layout sliders you have bound
            const rangeInput = document.getElementById('range-slider');
            if (rangeInput) rangeInput.value = state.appSettings.vehicleRange;
            const rangeDisplay = document.getElementById('range-display');
            if (rangeDisplay) rangeDisplay.innerText = `${state.appSettings.vehicleRange} mi`;
        }
        if (parsed.hasOwnProperty('includeTraffic')) {
            state.appSettings.includeTraffic = parsed.includeTraffic;
        }
    } catch (e) {
        console.error("Failed to load state:", e);
    }
}

export function exportToFile() {
    const dataToSave = { 
        stops: state.stops, 
        appSettings: state.appSettings, 
        geoDatabase: state.geoDatabase, 
        keyDates: state.keyDates,
        savedPOIs: state.savedPOIs
    };
    const jsonString = JSON.stringify(dataToSave, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ev-route-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

export function importFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parsed = JSON.parse(e.target.result);
            if (parsed.stops && parsed.geoDatabase) {
                state.stops = parsed.stops;
                state.geoDatabase = parsed.geoDatabase;
                if (parsed.keyDates) state.keyDates = parsed.keyDates;
                if (parsed.appSettings) state.appSettings = { ...state.appSettings, ...parsed.appSettings };
                if (parsed.savedPOIs) state.savedPOIs = parsed.savedPOIs;
                saveState();
                window.location.reload();
            } else {
                alert("This doesn't look like a valid EV Route Planner backup file.");
            }
        } catch (err) {
            console.error(err);
            alert("Error reading file.");
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}