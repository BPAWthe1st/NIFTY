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
        showPOIPins: true,
        showSubStopPins: true,
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
    searchTimeout: null,
    activeTripId: 'default',
    tripName: 'My Trip',
};


// --- CENTRALIZED PERSISTENCE (UPGRADED FOR MULTI-TRIP) ---

export function getSavedTripsIndex() {
    return JSON.parse(localStorage.getItem('nifty_trip_index') || '[]');
}

export function saveState() {
    const dataToSave = { 
        stops: state.stops, 
        appSettings: state.appSettings, 
        geoDatabase: state.geoDatabase, 
        keyDates: state.keyDates,
        savedPOIs: state.savedPOIs,
        includeTraffic: state.appSettings.includeTraffic,
        tripName: state.tripName
    };
    
    // 1. Save the actual trip data to its unique slot
    localStorage.setItem(`nifty_trip_${state.activeTripId}`, JSON.stringify(dataToSave));

    // 2. Update the Master Index
    let index = getSavedTripsIndex();
    const existing = index.find(t => t.id === state.activeTripId);
    if (existing) {
        existing.name = state.tripName;
        existing.updatedAt = Date.now();
    } else {
        index.push({ id: state.activeTripId, name: state.tripName, updatedAt: Date.now() });
    }
    localStorage.setItem('nifty_trip_index', JSON.stringify(index));
}

export function loadState(specificTripId = null) {
    // ONE-TIME MIGRATION: Move old single-save data into the new multi-trip format
    const legacyData = localStorage.getItem('hybridRoutePlanner');
    if (legacyData) {
        localStorage.setItem('nifty_trip_default', legacyData);
        localStorage.setItem('nifty_trip_index', JSON.stringify([{ id: 'default', name: 'My First Trip', updatedAt: Date.now() }]));
        localStorage.removeItem('hybridRoutePlanner'); // Clean up old key
    }

    let index = getSavedTripsIndex();
    
    // If no specific trip requested, load the most recently updated one, or create a default
    if (!specificTripId) {
        if (index.length === 0) {
            state.activeTripId = 'default';
            state.tripName = 'New Trip';
            return; 
        }
        // Sort by newest first
        index.sort((a, b) => b.updatedAt - a.updatedAt);
        specificTripId = index[0].id;
    }

    const saved = localStorage.getItem(`nifty_trip_${specificTripId}`);
    if (!saved) return;

    try {
        const parsed = JSON.parse(saved);
        state.activeTripId = specificTripId;
        state.tripName = parsed.tripName || index.find(t => t.id === specificTripId)?.name || 'Unnamed Trip';
        
        // Deep merge/overwrite the state object safely
        if (parsed.stops) state.stops = parsed.stops;
        if (parsed.keyDates) state.keyDates = parsed.keyDates;
        if (parsed.geoDatabase) state.geoDatabase = parsed.geoDatabase;
        if (parsed.savedPOIs) state.savedPOIs = parsed.savedPOIs;
        if (parsed.appSettings) {
            state.appSettings = { ...state.appSettings, ...parsed.appSettings };
        }
        if (parsed.hasOwnProperty('includeTraffic')) {
            state.appSettings.includeTraffic = parsed.includeTraffic;
        }
    } catch (e) {
        console.error("Failed to load state for trip:", specificTripId, e);
    }
}

export function exportToFile() {
    const dataToSave = { 
        stops: state.stops, 
        appSettings: state.appSettings, 
        geoDatabase: state.geoDatabase, 
        keyDates: state.keyDates,
        savedPOIs: state.savedPOIs,
        tripName: state.tripName // Added for multi-trip support
    };
    const jsonString = JSON.stringify(dataToSave, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (state.tripName || 'backup').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    a.download = `nifty-${safeName}-${new Date().toISOString().split('T')[0]}.json`;
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
                if (parsed.tripName) state.tripName = parsed.tripName;
                
                saveState();
                window.location.reload();
            } else {
                alert("This doesn't look like a valid NIFTY backup file.");
            }
        } catch (err) {
            console.error(err);
            alert("Error reading file.");
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}