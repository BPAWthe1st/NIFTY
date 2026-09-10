import { state, loadState, saveState, exportToFile, importFromFile } from './state.js';
import { 
    handleSearch, handleKeyDateSearch, handleFormSubmit, handleKeyDateSubmit, 
    toggleModal, toggleKeyDatesModal, toggleKeyDateStatus, removeKeyDate, 
    moveStop, removeStop, changeMode, changeDays, updateStartDate, 
    toggleSkip, renderTimelineUI, handleStateChange
} from './ui.js';
import { initMap, calculateRoute, renderSavedPOIs, scanRouteForPOIs } from './map.js';
import { loadGoogleMapsAPI } from './api.js';

// Bind imported functions to the global window for HTML onclick handlers
window.handleSearch = handleSearch;
window.handleKeyDateSearch = handleKeyDateSearch;
window.handleFormSubmit = handleFormSubmit;
window.handleKeyDateSubmit = handleKeyDateSubmit;
window.toggleModal = toggleModal;
window.toggleKeyDatesModal = toggleKeyDatesModal;
window.toggleKeyDateStatus = toggleKeyDateStatus;
window.removeKeyDate = removeKeyDate;
window.removeStop = removeStop;
window.changeMode = changeMode;
window.changeDays = changeDays;
window.updateStartDate = updateStartDate;
window.toggleSkip = toggleSkip;
window.calculateRoute = calculateRoute;
window.renderTimelineUI = renderTimelineUI;
window.exportToFile = exportToFile;
window.importFromFile = importFromFile;
window.handleStateChange = handleStateChange;
window.renderSavedPOIs = renderSavedPOIs;
window.scanRouteForPOIs = scanRouteForPOIs;

window.updateSettings = function(key, value) {
    if (state.appSettings && state.appSettings.hasOwnProperty(key)) {
        state.appSettings[key] = value;
        saveState();
    }
    if (typeof window.calculateRoute === 'function') {
        window.calculateRoute();
    }
    if (typeof window.renderTimelineUI === 'function') {
        window.renderTimelineUI();
    }
};

async function startApp() {
    
    // Check if we were told to load a specific trip via the trip switcher
    const forcedTripId = localStorage.getItem('nifty_force_load_trip');
    if (forcedTripId) {
        localStorage.removeItem('nifty_force_load_trip'); // clear it
        loadState(forcedTripId);
    } else {
        loadState(); // loads most recent
    }

    // Sync the UI input with the loaded trip name
    const titleInput = document.getElementById('trip-name-input');
    if (titleInput && state.tripName) titleInput.value = state.tripName;
    
    // Safety check for POI cache
    if (state && !state.savedPOIs) state.savedPOIs = [];

    // Safety check for the inactive-stops timeline setting, in case it doesn't
    // exist yet on previously-saved state (e.g. saves from before this setting
    // was introduced). Without this, updateSettings' hasOwnProperty check would
    // silently refuse to persist the toggle.
    if (state.appSettings && !state.appSettings.hasOwnProperty('showTimelineInactiveStops')) {
        state.appSettings.showTimelineInactiveStops = true;
    }
    
    try {
        await loadGoogleMapsAPI();
        initMap();
        renderTimelineUI();
        
        // Draw cached pins immediately
        if (typeof window.renderSavedPOIs === 'function') window.renderSavedPOIs();
        
        const tToggle = document.getElementById('traffic-toggle');
        if (tToggle) tToggle.checked = state.appSettings.includeTraffic;
        
        const cToggle = document.getElementById('charging-toggle');
        if (cToggle) cToggle.checked = state.appSettings.includeChargingDelays;

        const inactiveStopsToggle = document.getElementById('show-inactive-stops-toggle');
        if (inactiveStopsToggle) inactiveStopsToggle.checked = state.appSettings.showTimelineInactiveStops !== false;

        if (state.stops && state.stops.length > 1) {
            calculateRoute();
        }
    } catch (error) {
        console.error("Critical Boot Error: Could not load APIs", error);
        document.getElementById('map').innerHTML = `<div class="flex items-center justify-center h-full text-red-500 font-bold">Failed to load Google Maps API. Check console.</div>`;
    }
}

document.addEventListener('DOMContentLoaded', startApp);

document.addEventListener('click', (e) => {
    if(!e.target.closest('#add-form')) {
        const searchResults = document.getElementById('search-results');
        if (searchResults) searchResults.classList.add('hidden');
    }
    if(!e.target.closest('#key-date-form')) {
        const kdSearchResults = document.getElementById('kd-search-results');
        if (kdSearchResults) kdSearchResults.classList.add('hidden');
    }
    if (!e.target.closest('#poi-scan-popover') && !e.target.closest('[title="Search for places along this leg"]') && !e.target.closest('[title="Search for places near this stop"]')) {
        if (typeof window.closePoiScanPopover === 'function') window.closePoiScanPopover();
    }
    if (!e.target.closest('#add-to-checklist-popover') && !(e.target.tagName === 'BUTTON' && e.target.textContent.includes('Add to Stop Checklist'))) {
        if (typeof window.closeAddToChecklistPopover === 'function') window.closeAddToChecklistPopover();
    }
    if (!e.target.closest('#add-checklist-item-popover') && !(e.target.tagName === 'BUTTON' && e.target.textContent.includes('Add checklist item'))) {
        if (typeof window.closeAddChecklistItemPopover === 'function') window.closeAddChecklistItemPopover();
    }
    if (!e.target.closest('#trip-dropdown-menu') && !e.target.closest('button[onclick="window.toggleTripMenu()"]')) {
        const menu = document.getElementById('trip-dropdown-menu');
        if (menu) menu.classList.add('hidden');
    }
});