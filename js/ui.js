// js/ui.js
import { state, saveState, getSavedTripsIndex } from './state.js';

let placesService;
let autocompleteService;
let editingStopId = null; 
let editingKeyDateId = null; 
let tempEditKeyDateGeo = null; 
let editingStopIsNewInsert = false;

let poiScanTarget = null;
let checklistAddPoiId = null;
let expandedChecklistStopIds = new Set();
let checklistItemAddStopId = null;
let checklistItemAddSelectedPlace = null; 

export const POI_PRESET_CATEGORIES = [
    { keyword: 'Tesla Supercharger', label: '⚡ Tesla Supercharger', color: 'red' },
    { keyword: 'EV Charging Station', label: '🔌 EV Charging Station', color: 'red' },
    { keyword: 'Planet Fitness', label: '🏋️ Planet Fitness', color: 'purple' },
    { keyword: 'Brewery', label: '🍺 Brewery', color: 'blue' },
    { keyword: 'Coffee', label: '☕ Coffee Shop', color: 'orange' },
    { keyword: 'Gas Station', label: '⛽ Gas Station', color: 'yellow' },
    { keyword: 'Hotel', label: '🏨 Hotel', color: 'green' },
];

const ROW_HEIGHT_PX = 34; 
const GUTTER_WIDTH_PX = 24; 
const CHECKLIST_HEADER_PX = 24;      
const CHECKLIST_ITEM_PX = 22;        
const CHECKLIST_EMPTY_PX = 22;       
const CHECKLIST_BOTTOM_PADDING_PX = 6;

// --- ROW MENU HANDLERS ---
document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-menu-container')) {
        document.querySelectorAll('.row-menu-dropdown').forEach(el => el.classList.add('hidden'));
    }
});

window.toggleRowMenu = (stopId, e) => {
    e.stopPropagation();
    const menu = document.getElementById(`row-menu-${stopId}`);
    const isHidden = menu.classList.contains('hidden');
    
    // Close any other open row menus first
    document.querySelectorAll('.row-menu-dropdown').forEach(el => el.classList.add('hidden'));
    
    if (isHidden) {
        menu.classList.remove('hidden');
    }
};

// --- MULTI-TRIP MANAGEMENT ---

window.renameCurrentTrip = (newName) => {
    if (!newName.trim()) return;
    state.tripName = newName.trim();
    saveState();
};

window.toggleTripMenu = () => {
    const menu = document.getElementById('trip-dropdown-menu');
    const isHidden = menu.classList.contains('hidden');
    
    if (isHidden) {
        const container = document.getElementById('trip-list-container');
        const trips = getSavedTripsIndex().sort((a, b) => b.updatedAt - a.updatedAt);
        
        container.innerHTML = trips.map(t => `
            <div class="flex items-center justify-between px-3 py-2 hover:bg-gray-50 border-b border-gray-50 group cursor-pointer" onclick="window.switchTrip('${t.id}')">
                <div class="flex-1 min-w-0 pr-2">
                    <div class="text-sm font-bold truncate ${t.id === state.activeTripId ? 'text-emerald-600' : 'text-gray-800'}">
                        ${t.id === state.activeTripId ? '✓ ' : ''}${t.name}
                    </div>
                    <div class="text-[9px] text-gray-400">Last updated: ${new Date(t.updatedAt).toLocaleDateString()}</div>
                </div>
                ${t.id !== state.activeTripId ? `
                    <button onclick="event.stopPropagation(); window.deleteTrip('${t.id}')" class="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 text-xs px-2 py-1 font-bold transition-opacity">✕</button>
                ` : ''}
            </div>
        `).join('');
    }
    menu.classList.toggle('hidden');
};

window.switchTrip = (tripId) => {
    if (tripId === state.activeTripId) return;
    saveState();
    localStorage.setItem('nifty_force_load_trip', tripId);
    window.location.reload();
};

window.createNewTrip = () => {
    saveState();
    const newTripId = 'trip_' + Date.now();
    localStorage.setItem('nifty_force_load_trip', newTripId);
    
    const blankState = {
        stops: [{ id: "1", key: "San Francisco, CA", mode: "drive", days: 1 }],
        appSettings: { ...state.appSettings, startDate: new Date().toISOString().split('T')[0] },
        geoDatabase: { "San Francisco, CA": { lat: 37.7749, lng: -122.4194 } },
        keyDates: [],
        savedPOIs: [],
        tripName: "New Trip"
    };
    localStorage.setItem(`nifty_trip_${newTripId}`, JSON.stringify(blankState));
    window.location.reload();
};

window.deleteTrip = (tripId) => {
    if (!confirm("Are you sure you want to permanently delete this trip?")) return;
    localStorage.removeItem(`nifty_trip_${tripId}`);
    let index = getSavedTripsIndex();
    index = index.filter(t => t.id !== tripId);
    localStorage.setItem('nifty_trip_index', JSON.stringify(index));
    document.getElementById('trip-dropdown-menu').classList.add('hidden');
    window.toggleTripMenu();
};


// --- DRAG & DROP ---

window.dragStart = (e, index) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    e.target.style.opacity = '0.4';
};

window.dragOver = (e) => {
    e.preventDefault(); 
    e.dataTransfer.dropEffect = 'move';
    return false;
};

window.dragEnd = (e) => {
    e.target.style.opacity = '1';
};

window.drop = (e, targetIndex) => {
    e.preventDefault();
    e.stopPropagation(); 
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'));
    if (isNaN(sourceIndex) || sourceIndex === targetIndex) return;
    
    const movedItem = state.stops.splice(sourceIndex, 1)[0];
    state.stops.splice(targetIndex, 0, movedItem);
    if (state.stops[0]) state.stops[0].mode = "drive";
    handleStateChange();
};

// --- GOOGLE API HELPERS ---

function initGoogleServices() {
    if (typeof google !== 'undefined' && !placesService) {
        const mapTarget = state.mapInstance || document.createElement('div');
        placesService = new google.maps.places.PlacesService(mapTarget);
        autocompleteService = new google.maps.places.AutocompleteService();
    }
}

async function getPlaceDetails(placeId) {
    initGoogleServices();
    return new Promise((resolve) => {
        if (!placesService) return resolve(null);
        placesService.getDetails({ placeId: placeId, fields: ['geometry'] }, (place, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && place && place.geometry) {
                resolve({ lat: place.geometry.location.lat(), lng: place.geometry.location.lng() });
            } else {
                resolve(null);
            }
        });
    });
}

// --- STOP MANAGEMENT ---

window.beginEditStop = (id) => {
    editingStopId = id;
    editingStopIsNewInsert = false;
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
    setTimeout(() => {
        const input = document.getElementById(`edit-stop-${id}`);
        if (input) { input.focus(); input.select(); }
    }, 50);
};

window.beginInsertStop = (insertAtIndex) => {
    const newStop = { id: String(Date.now()), key: '', mode: 'drive', days: 1, skipped: false };
    state.stops.splice(insertAtIndex, 0, newStop);
    if (state.stops[0]) state.stops[0].mode = 'drive';
    editingStopId = newStop.id;
    editingStopIsNewInsert = true;
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
    setTimeout(() => {
        const input = document.getElementById(`edit-stop-${newStop.id}`);
        if (input) { input.focus(); input.select(); }
    }, 50);
};

window.cancelEditStop = (e) => {
    if(e) { e.preventDefault(); e.stopPropagation(); }
    if (editingStopIsNewInsert && editingStopId) {
        state.stops = state.stops.filter(s => s.id !== editingStopId);
        if (state.stops[0]) state.stops[0].mode = 'drive';
        saveState();
    }
    editingStopId = null;
    editingStopIsNewInsert = false;
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
};

window.handleEditSearch = (query, id) => {
    const resultsBox = document.getElementById(`edit-results-${id}`);
    initGoogleServices();
    if (!query || query.length < 3 || !autocompleteService) return resultsBox && resultsBox.classList.add('hidden');
    
    autocompleteService.getPlacePredictions({ input: query }, (predictions, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions) return resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        predictions.forEach(pred => {
            const div = document.createElement('div');
            div.className = 'p-2 border-b border-gray-100 text-xs text-gray-800 hover:bg-blue-50 cursor-pointer truncate transition-colors';
            div.innerText = pred.description;
            div.onclick = async (e) => {
                e.stopPropagation();
                resultsBox.classList.add('hidden');
                document.body.style.cursor = 'wait';
                
                const coords = await getPlaceDetails(pred.place_id);
                document.body.style.cursor = 'default';
                
                if (coords) {
                    state.geoDatabase[pred.description] = { lat: coords.lat, lng: coords.lng };
                    const stop = state.stops.find(s => s.id === id);
                    if (stop) {
                        stop.key = pred.description;
                        if (stop.isKeyDate) {
                            const kd = state.keyDates.find(k => k.id === stop.kdId);
                            if (kd) kd.location = pred.description;
                            if (typeof window.renderKeyDatesList === 'function') renderKeyDatesList();
                        }
                    }
                    editingStopId = null;
                    editingStopIsNewInsert = false;
                    saveState();
                    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
                    if (typeof window.calculateRoute === 'function') window.calculateRoute();
                }
            };
            resultsBox.appendChild(div);
        });
        resultsBox.classList.remove('hidden');
    });
};

window.handleEditStopKeydown = (e, id) => {
    if (e.key === 'Escape') {
        e.preventDefault();
        window.cancelEditStop(e);
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        const resultsBox = document.getElementById(`edit-results-${id}`);
        if (resultsBox && !resultsBox.classList.contains('hidden')) {
            const firstResult = resultsBox.querySelector('div');
            if (firstResult) {
                firstResult.click();
                return;
            }
        }
    }
};

export async function handleSearch(query) {
    const resultsBox = document.getElementById('search-results');
    initGoogleServices();
    if (!query || query.length < 3 || !autocompleteService) return resultsBox && resultsBox.classList.add('hidden');
    
    autocompleteService.getPlacePredictions({ input: query }, (predictions, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions) return resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        predictions.forEach(pred => {
            const div = document.createElement('div');
            div.className = 'p-3 border-b border-gray-200 text-xs text-gray-800 hover:bg-gray-50 cursor-pointer transition';
            div.innerText = pred.description;
            div.onclick = async () => {
                document.getElementById('location-search').value = pred.description;
                resultsBox.classList.add('hidden');
                const coords = await getPlaceDetails(pred.place_id);
                if (coords) state.currentSelectedGeo = { key: pred.description, lat: coords.lat, lng: coords.lng };
            };
            resultsBox.appendChild(div);
        });
        resultsBox.classList.remove('hidden');
    });
}

export function handleFormSubmit(e) {
    if(e) e.preventDefault();
    if (!state.currentSelectedGeo) return alert("Please select a location from the dropdown results.");
    const key = state.currentSelectedGeo.key;
    state.geoDatabase[key] = { lat: state.currentSelectedGeo.lat, lng: state.currentSelectedGeo.lng };
    state.stops.push({ id: String(Date.now()), key: key, mode: "drive", days: 2, skipped: false });
    document.getElementById('location-search').value = '';
    state.currentSelectedGeo = null;
    handleStateChange();
}

export function handleStateChange() {
    saveState();
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI(); 
    if (typeof window.calculateRoute === 'function') window.calculateRoute();
}

export function toggleModal(open) { document.getElementById('settings-modal').classList.toggle('hidden', !open); }
export function updateStartDate(dateString) { 
    if (!dateString) return; 
    const parsedDate = new Date(dateString);
    if (isNaN(parsedDate.getTime())) return;
    state.appSettings.startDate = dateString; 
    handleStateChange(); 
}
export function changeMode(id, value) { state.stops.find(s => s.id === id).mode = value; handleStateChange(); }
export function changeDays(id, value) { state.stops.find(s => s.id === id).days = parseInt(value) || 0; handleStateChange(); }

window.updateTransitDays = (id, value) => {
    const stop = state.stops.find(s => s.id === id);
    if (stop) { stop.transitDays = parseInt(value) || 0; handleStateChange(); }
};

export function toggleSkip(id, isSkipped) {
    const stop = state.stops.find(s => s.id === id);
    if (stop) { stop.skipped = isSkipped; handleStateChange(); }
}

export function moveStop(index, direction) {
    if ((direction === -1 && index === 0) || (direction === 1 && index === state.stops.length - 1)) return;
    const targetIndex = index + direction;
    const temp = state.stops[index];
    state.stops[index] = state.stops[targetIndex];
    state.stops[targetIndex] = temp;
    if (state.stops[0]) state.stops[0].mode = "drive";
    handleStateChange();
}

export function removeStop(index) { 
    state.stops.splice(index, 1); 
    if (state.stops.length > 0) state.stops[0].mode = "drive";
    handleStateChange(); 
}

export function logConsole(msg) {
    const el = document.getElementById('status-console');
    if (el) {
        el.innerHTML += `<div>> ${msg}</div>`;
        el.scrollTop = el.scrollHeight;
    }
}

// --- KEY DATES ---

export async function handleKeyDateSearch(query) {
    const resultsBox = document.getElementById('kd-search-results');
    initGoogleServices();
    if (!query || query.length < 3 || !autocompleteService) return resultsBox && resultsBox.classList.add('hidden');
    
    autocompleteService.getPlacePredictions({ input: query }, (predictions, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions) return resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        predictions.forEach(pred => {
            const div = document.createElement('div');
            div.className = 'p-3 border-b border-gray-200 text-xs text-gray-800 hover:bg-gray-50 cursor-pointer transition';
            div.innerText = pred.description;
            div.onclick = async () => {
                document.getElementById('kd-location').value = pred.description;
                resultsBox.classList.add('hidden');
                const coords = await getPlaceDetails(pred.place_id);
                if (coords) state.currentSelectedKeyDateGeo = { key: pred.description, lat: coords.lat, lng: coords.lng };
            };
            resultsBox.appendChild(div);
        });
        resultsBox.classList.remove('hidden');
    });
}

export function toggleKeyDatesModal(open) {
    if (open) {
        editingKeyDateId = null;
        renderKeyDatesList();
    }
    document.getElementById('key-dates-modal').classList.toggle('hidden', !open);
}

export function handleKeyDateSubmit(e) {
    e.preventDefault();
    if (!state.currentSelectedKeyDateGeo) return alert("Please select a location from the dropdown results.");
    const loc = state.currentSelectedKeyDateGeo.key;
    const start = document.getElementById('kd-start').value;
    const end = document.getElementById('kd-end').value;
    
    state.geoDatabase[loc] = { lat: state.currentSelectedKeyDateGeo.lat, lng: state.currentSelectedKeyDateGeo.lng };
    const newKdId = String(Date.now());
    const days = Math.round((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24));
    
    if (!state.keyDates) state.keyDates = [];
    state.keyDates.push({ id: newKdId, location: loc, startDate: start, endDate: end, enabled: true });
    state.stops.push({ id: 'stop_'+newKdId, key: loc, mode: 'drive', days: days, isKeyDate: true, kdId: newKdId, skipped: false });
    
    document.getElementById('kd-location').value = '';
    state.currentSelectedKeyDateGeo = null;
    saveState(); renderKeyDatesList(); handleStateChange();
}

export function toggleKeyDateStatus(id, isEnabled) {
    const kd = state.keyDates.find(k => k.id === id);
    if (kd) {
        kd.enabled = isEnabled;
        if (isEnabled) {
            const days = Math.round((new Date(kd.endDate) - new Date(kd.startDate)) / (1000 * 60 * 60 * 24));
            state.stops.push({ id: 'stop_'+kd.id, key: kd.location, mode: 'drive', days: days, isKeyDate: true, kdId: kd.id, skipped: false });
        } else {
            state.stops = state.stops.filter(s => s.kdId !== kd.id);
        }
        saveState(); handleStateChange();
    }
}

export function removeKeyDate(id) {
    state.keyDates = state.keyDates.filter(kd => kd.id !== id);
    state.stops = state.stops.filter(s => s.kdId !== id);
    saveState(); renderKeyDatesList(); handleStateChange();
}

window.beginEditKeyDate = (id) => {
    editingKeyDateId = id;
    tempEditKeyDateGeo = null;
    renderKeyDatesList();
    setTimeout(() => {
        const input = document.getElementById(`edit-kd-loc-${id}`);
        if (input) { input.focus(); input.select(); }
    }, 50);
};

window.cancelEditKeyDate = (e) => {
    if(e) { e.preventDefault(); e.stopPropagation(); }
    editingKeyDateId = null;
    tempEditKeyDateGeo = null;
    renderKeyDatesList();
};

window.handleKeyDateEditSearch = (query, id) => {
    const resultsBox = document.getElementById(`edit-kd-results-${id}`);
    initGoogleServices();
    if (!query || query.length < 3 || !autocompleteService) return resultsBox && resultsBox.classList.add('hidden');
    
    autocompleteService.getPlacePredictions({ input: query }, (predictions, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions) return resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        predictions.forEach(pred => {
            const div = document.createElement('div');
            div.className = 'p-2 border-b border-gray-100 text-xs text-gray-800 hover:bg-blue-50 cursor-pointer truncate transition-colors';
            div.innerText = pred.description;
            div.onclick = async (e) => {
                e.stopPropagation();
                document.getElementById(`edit-kd-loc-${id}`).value = pred.description;
                resultsBox.classList.add('hidden');
                document.body.style.cursor = 'wait';
                
                const coords = await getPlaceDetails(pred.place_id);
                document.body.style.cursor = 'default';
                
                if (coords) {
                    tempEditKeyDateGeo = { key: pred.description, lat: coords.lat, lng: coords.lng };
                }
            };
            resultsBox.appendChild(div);
        });
        resultsBox.classList.remove('hidden');
    });
};

window.saveEditKeyDate = (id) => {
    const kd = state.keyDates.find(k => k.id === id);
    if (!kd) return;

    const locInput = document.getElementById(`edit-kd-loc-${id}`).value;
    const startInput = document.getElementById(`edit-kd-start-${id}`).value;
    const endInput = document.getElementById(`edit-kd-end-${id}`).value;

    if (!startInput || !endInput) return alert("Please provide both start and end dates.");
    if (new Date(startInput) > new Date(endInput)) return alert("End date must be after start date.");

    if (locInput !== kd.location) {
        if (!tempEditKeyDateGeo || tempEditKeyDateGeo.key !== locInput) {
            return alert("Please select a valid location from the dropdown results.");
        }
        state.geoDatabase[tempEditKeyDateGeo.key] = { lat: tempEditKeyDateGeo.lat, lng: tempEditKeyDateGeo.lng };
        kd.location = tempEditKeyDateGeo.key;
    }

    kd.startDate = startInput;
    kd.endDate = endInput;

    const stop = state.stops.find(s => s.kdId === id);
    if (stop) {
        stop.key = kd.location;
        stop.days = Math.round((new Date(kd.endDate) - new Date(kd.startDate)) / (1000 * 60 * 60 * 24));
    }

    editingKeyDateId = null;
    tempEditKeyDateGeo = null;
    
    saveState(); renderKeyDatesList(); handleStateChange(); 
};

export function renderKeyDatesList() {
    const container = document.getElementById('key-dates-list');
    if (!container) return;
    if (!state.keyDates || state.keyDates.length === 0) return container.innerHTML = '<div class="text-[10px] text-gray-500 italic text-center py-2">No key dates added yet.</div>';
    
    container.innerHTML = [...state.keyDates].sort((a, b) => new Date(a.startDate) - new Date(b.startDate)).map(kd => {
        const isEditing = editingKeyDateId === kd.id;
        
        if (isEditing) {
            return `
                <div class="bg-blue-50 border border-blue-200 p-2 rounded-lg mb-2 shadow-sm relative">
                    <div class="flex flex-col gap-2">
                        <div class="relative">
                            <input type="text" id="edit-kd-loc-${kd.id}" value="${kd.location}" oninput="window.handleKeyDateEditSearch(this.value, '${kd.id}')" class="w-full text-xs border border-blue-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-inner">
                            <div id="edit-kd-results-${kd.id}" class="absolute top-full left-0 right-0 bg-white border border-gray-200 shadow-xl z-[150] hidden max-h-48 overflow-y-auto rounded-lg mt-1 overflow-hidden"></div>
                        </div>
                        <div class="flex items-center gap-2">
                            <input type="date" id="edit-kd-start-${kd.id}" value="${kd.startDate}" class="flex-1 text-xs border border-gray-300 rounded px-1 py-1">
                            <span class="text-xs text-gray-500">to</span>
                            <input type="date" id="edit-kd-end-${kd.id}" value="${kd.endDate}" class="flex-1 text-xs border border-gray-300 rounded px-1 py-1">
                        </div>
                        <div class="flex justify-end gap-2 mt-1">
                            <button onclick="window.cancelEditKeyDate(event)" class="text-xs text-gray-500 hover:text-gray-700 font-bold px-2 py-1 transition">Cancel</button>
                            <button onclick="window.saveEditKeyDate('${kd.id}')" class="text-xs bg-blue-600 hover:bg-blue-50 text-white rounded px-3 py-1 font-bold shadow-sm transition">Save</button>
                        </div>
                    </div>
                </div>
            `;
        } else {
            return `
                <div class="bg-white border border-gray-200 p-2 rounded-lg flex justify-between items-center mb-2 shadow-sm group">
                    <div class="flex-1 min-w-0 pr-2 opacity-${kd.enabled !== false ? '100' : '50'} transition-opacity cursor-pointer" onclick="window.beginEditKeyDate('${kd.id}')" title="Click to edit dates or location">
                        <div class="flex items-center gap-1.5 mb-0.5">
                            <div class="text-xs font-bold text-amber-600 truncate group-hover:text-amber-500 transition-colors">${kd.location}</div>
                            <button class="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-500">✏️</button>
                        </div>
                        <div class="text-[9px] text-gray-500 font-medium">${kd.startDate} to ${kd.endDate}</div>
                    </div>
                    <div class="flex items-center gap-3 shrink-0 pl-2 border-l border-gray-100">
                        <label class="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" ${kd.enabled !== false ? 'checked' : ''} onchange="toggleKeyDateStatus('${kd.id}', this.checked)" class="w-3.5 h-3.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500">
                            <span class="text-[9px] text-gray-500 uppercase tracking-wider font-bold">En</span>
                        </label>
                        <div class="w-px h-4 bg-gray-200"></div>
                        <button onclick="removeKeyDate('${kd.id}')" class="text-red-400 hover:text-red-600 text-[10px] font-bold pb-0.5 transition-colors">✕</button>
                    </div>
                </div>
            `;
        }
    }).join('');
}

function getFallbackStats(prevStop, currentStop) {
    const prevGeo = state.geoDatabase[prevStop.key];
    const currentGeo = state.geoDatabase[currentStop.key];
    if (!prevGeo || !currentGeo) return { miles: 0, hours: 0 };
    const R = 3958.8, dLat = (currentGeo.lat - prevGeo.lat) * Math.PI / 180, dLng = (currentGeo.lng - prevGeo.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(prevGeo.lat * Math.PI / 180) * Math.cos(currentGeo.lat * Math.PI / 180) * Math.sin(dLng/2) * Math.sin(dLng/2);
    const miles = Math.round((currentStop.mode === 'drive' ? R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.25 : R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))));
    return { miles, hours: currentStop.mode === 'drive' ? Math.round((miles / 62) * 10) / 10 : Math.round(((miles / 500) + 1.5) * 10) / 10 };
}

// --- POI / CHECKLISTS ---

window.removePOI = (poiId) => {
    if (!state.savedPOIs) return;
    state.savedPOIs = state.savedPOIs.filter(p => p.id !== poiId);
    saveState();
    if (typeof window.renderSavedPOIs === 'function') window.renderSavedPOIs();
};

function renderPoiScanPopoverContent() {
    const container = document.getElementById('poi-scan-popover');
    if (!container) return;
    container.innerHTML = `
        <div class="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Search for nearby places</div>
        <div class="space-y-1 max-h-36 overflow-y-auto pr-1">
            ${POI_PRESET_CATEGORIES.map((cat, i) => `
                <label class="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5">
                    <input type="checkbox" id="poi-preset-${i}" data-keyword="${cat.keyword}" class="w-3.5 h-3.5 text-emerald-600 rounded border-gray-300">
                    ${cat.label}
                </label>
            `).join('')}
        </div>
        <div class="mt-2 pt-2 border-t border-gray-100">
            <label class="block text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1">Custom keyword(s)</label>
            <input type="text" id="poi-custom-keywords" placeholder="e.g. Trader Joe's, dog park" class="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500">
        </div>
        <div class="flex justify-end gap-2 mt-3">
            <button onclick="window.closePoiScanPopover()" class="text-xs text-gray-500 hover:text-gray-700 font-bold px-2 py-1">Cancel</button>
            <button onclick="window.executePoiScan()" class="text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded px-3 py-1.5 font-bold shadow-sm">Search</button>
        </div>
    `;
}

window.openPoiScanPopover = (target, anchorEl) => {
    poiScanTarget = target;
    let popover = document.getElementById('poi-scan-popover');
    if (!popover) {
        popover = document.createElement('div');
        popover.id = 'poi-scan-popover';
        popover.className = 'fixed bg-white border border-gray-200 rounded-lg shadow-2xl p-3 z-[3000] w-64';
        document.body.appendChild(popover);
    }
    renderPoiScanPopoverContent();
    popover.classList.remove('hidden');

    if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const popoverWidth = 256; 
        let left = rect.left;
        if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8;
        popover.style.top = `${rect.bottom + 6}px`;
        popover.style.left = `${Math.max(8, left)}px`;
        popover.style.transform = 'none';
    } else {
        // Fallback: Center of the screen if triggered from the context menu
        popover.style.top = '50%';
        popover.style.left = '50%';
        popover.style.transform = 'translate(-50%, -50%)';
    }
};

window.closePoiScanPopover = () => {
    const popover = document.getElementById('poi-scan-popover');
    if (popover) popover.classList.add('hidden');
    poiScanTarget = null;
};

window.executePoiScan = () => {
    if (!poiScanTarget) return;

    const keywords = [];
    POI_PRESET_CATEGORIES.forEach((cat, i) => {
        const checkbox = document.getElementById(`poi-preset-${i}`);
        if (checkbox && checkbox.checked) keywords.push(cat.keyword);
    });
    const customInput = document.getElementById('poi-custom-keywords');
    if (customInput && customInput.value.trim()) {
        customInput.value.split(',').map(k => k.trim()).filter(Boolean).forEach(k => keywords.push(k));
    }

    if (keywords.length === 0) return alert('Pick at least one category or enter a custom keyword.');

    const target = poiScanTarget;
    window.closePoiScanPopover();

    if (target.type === 'leg') {
        window.scanSpecificLeg(target.prevIndex, target.currIndex, keywords);
    } else if (target.type === 'stop') {
        window.scanStopForPOIs(target.stopIndex, keywords);
    }
};

function addChecklistItemToStop(stopId, place, note) {
    const stop = state.stops.find(s => s.id === stopId);
    if (!stop) return null;
    if (!stop.checklistItems) stop.checklistItems = [];
    const item = {
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        name: place.name,
        address: place.address || '',
        lat: place.lat,
        lng: place.lng,
        note: note || '',
        done: false,
        sourcePoiId: place.sourcePoiId || null
    };
    stop.checklistItems.push(item);
    return item;
}

function renderAddToChecklistPopoverContent() {
    const container = document.getElementById('add-to-checklist-popover');
    if (!container) return;
    const activeStopOptions = state.stops
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !s.skipped)
        .map(({ s, i }) => `<option value="${s.id}">${i + 1}. ${s.key}</option>`)
        .join('');

    container.innerHTML = `
        <div class="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Add to a stop's checklist</div>
        <label class="block text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1">Stop</label>
        <select id="checklist-target-stop" class="w-full text-xs border border-gray-300 rounded px-2 py-1.5 mb-2 focus:outline-none focus:ring-1 focus:ring-emerald-500">
            ${activeStopOptions}
        </select>
        <label class="block text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1">Why save this? (optional)</label>
        <input type="text" id="checklist-note" placeholder="e.g. friend recommended the IPA" class="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500">
        <div class="flex justify-end gap-2 mt-3">
            <button onclick="window.closeAddToChecklistPopover()" class="text-xs text-gray-500 hover:text-gray-700 font-bold px-2 py-1">Cancel</button>
            <button onclick="window.confirmAddToChecklist()" class="text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded px-3 py-1.5 font-bold shadow-sm">Add</button>
        </div>
    `;
}

window.openAddToChecklistPopover = (poiId, clickEvent) => {
    checklistAddPoiId = poiId;
    let popover = document.getElementById('add-to-checklist-popover');
    if (!popover) {
        popover = document.createElement('div');
        popover.id = 'add-to-checklist-popover';
        popover.className = 'fixed bg-white border border-gray-200 rounded-lg shadow-2xl p-3 z-[3000] w-64';
        document.body.appendChild(popover);
    }
    renderAddToChecklistPopoverContent();
    popover.classList.remove('hidden');

    const popoverWidth = 256;
    let left = (clickEvent && clickEvent.clientX) || (window.innerWidth / 2);
    let top = (clickEvent && clickEvent.clientY) || (window.innerHeight / 2);
    if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8;
    popover.style.left = `${Math.max(8, left)}px`;
    popover.style.top = `${Math.min(top + 10, window.innerHeight - 200)}px`;
};

window.closeAddToChecklistPopover = () => {
    const popover = document.getElementById('add-to-checklist-popover');
    if (popover) popover.classList.add('hidden');
    checklistAddPoiId = null;
};

window.confirmAddToChecklist = () => {
    if (!checklistAddPoiId) return;
    const poi = (state.savedPOIs || []).find(p => p.id === checklistAddPoiId);
    if (!poi) return window.closeAddToChecklistPopover();

    const stopSelect = document.getElementById('checklist-target-stop');
    const noteInput = document.getElementById('checklist-note');
    const stopId = stopSelect ? stopSelect.value : null;
    const note = noteInput ? noteInput.value.trim() : '';

    if (!stopId) return;

    addChecklistItemToStop(stopId, { name: poi.name, address: poi.address, lat: poi.lat, lng: poi.lng, sourcePoiId: poi.id }, note);
    window.closeAddToChecklistPopover();
    saveState();
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
    if (typeof window.renderSavedPOIs === 'function') window.renderSavedPOIs();
};

window.toggleStopChecklist = (stopId) => {
    if (expandedChecklistStopIds.has(stopId)) {
        expandedChecklistStopIds.delete(stopId);
    } else {
        expandedChecklistStopIds.add(stopId);
    }
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
};

window.toggleChecklistItemDone = (stopId, itemId, done) => {
    const stop = state.stops.find(s => s.id === stopId);
    if (!stop || !stop.checklistItems) return;
    const item = stop.checklistItems.find(i => i.id === itemId);
    if (!item) return;
    item.done = done;
    saveState();
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
    if (typeof window.renderSavedPOIs === 'function') window.renderSavedPOIs();
};

window.removeChecklistItem = (stopId, itemId) => {
    const stop = state.stops.find(s => s.id === stopId);
    if (!stop || !stop.checklistItems) return;
    stop.checklistItems = stop.checklistItems.filter(i => i.id !== itemId);
    saveState();
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
    if (typeof window.renderSavedPOIs === 'function') window.renderSavedPOIs();
};

window.promoteChecklistItemToStop = (stopId, itemId) => {
    const stop = state.stops.find(s => s.id === stopId);
    if (!stop || !stop.checklistItems) return;
    const item = stop.checklistItems.find(i => i.id === itemId);
    if (!item) return;

    if (!confirm(`Add "${item.name}" as its own stop in the trip, right after ${stop.key}?`)) return;

    const parentIndex = state.stops.findIndex(s => s.id === stopId);
    if (parentIndex === -1) return;

    state.geoDatabase[item.name] = { lat: item.lat, lng: item.lng };

    const newStop = { id: String(Date.now()), key: item.name, mode: 'drive', days: 1, skipped: false };
    state.stops.splice(parentIndex + 1, 0, newStop);
    if (state.stops[0]) state.stops[0].mode = 'drive';

    handleStateChange();
};

function renderAddChecklistItemPopoverContent() {
    const container = document.getElementById('add-checklist-item-popover');
    if (!container) return;
    container.innerHTML = `
        <div class="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Add a checklist item</div>
        <div class="relative mb-2">
            <input type="text" id="checklist-item-search" autocomplete="off" placeholder="Search for a place..." oninput="window.handleChecklistItemSearch(this.value)"
                   class="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500">
            <div id="checklist-item-search-results" class="absolute top-full left-0 bg-white border border-gray-200 shadow-xl z-[150] hidden max-h-48 overflow-y-auto rounded-lg mt-1 overflow-hidden" style="width: max(100%, 320px);"></div>
        </div>
        <label class="block text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1">Why save this? (optional)</label>
        <input type="text" id="checklist-item-note" placeholder="e.g. friend recommended the IPA" class="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-500">
        <div class="flex justify-end gap-2 mt-3">
            <button onclick="window.closeAddChecklistItemPopover()" class="text-xs text-gray-500 hover:text-gray-700 font-bold px-2 py-1">Cancel</button>
            <button onclick="window.confirmAddChecklistItem()" class="text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded px-3 py-1.5 font-bold shadow-sm">Add</button>
        </div>
    `;
}

window.openAddChecklistItemPopover = (stopId, anchorEl) => {
    checklistItemAddStopId = stopId;
    checklistItemAddSelectedPlace = null;
    let popover = document.getElementById('add-checklist-item-popover');
    if (!popover) {
        popover = document.createElement('div');
        popover.id = 'add-checklist-item-popover';
        popover.className = 'fixed bg-white border border-gray-200 rounded-lg shadow-2xl p-3 z-[3000] w-72';
        document.body.appendChild(popover);
    }
    renderAddChecklistItemPopoverContent();
    popover.classList.remove('hidden');

    if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const popoverWidth = 288;
        let left = rect.left;
        if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8;
        popover.style.top = `${rect.bottom + 6}px`;
        popover.style.left = `${Math.max(8, left)}px`;
    }
    setTimeout(() => {
        const input = document.getElementById('checklist-item-search');
        if (input) input.focus();
    }, 50);
};

window.closeAddChecklistItemPopover = () => {
    const popover = document.getElementById('add-checklist-item-popover');
    if (popover) popover.classList.add('hidden');
    checklistItemAddStopId = null;
    checklistItemAddSelectedPlace = null;
};

window.handleChecklistItemSearch = (query) => {
    const resultsBox = document.getElementById('checklist-item-search-results');
    initGoogleServices();
    checklistItemAddSelectedPlace = null; 
    if (!query || query.length < 3 || !autocompleteService) return resultsBox && resultsBox.classList.add('hidden');

    autocompleteService.getPlacePredictions({ input: query }, (predictions, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions) return resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        predictions.forEach(pred => {
            const div = document.createElement('div');
            div.className = 'p-2 border-b border-gray-100 text-xs text-gray-800 hover:bg-blue-50 cursor-pointer truncate transition-colors';
            div.innerText = pred.description;
            div.onclick = async (e) => {
                e.stopPropagation();
                resultsBox.classList.add('hidden');
                const searchInput = document.getElementById('checklist-item-search');
                if (searchInput) searchInput.value = pred.description;
                document.body.style.cursor = 'wait';
                const coords = await getPlaceDetails(pred.place_id);
                document.body.style.cursor = 'default';
                if (coords) {
                    checklistItemAddSelectedPlace = { name: pred.description, address: pred.description, lat: coords.lat, lng: coords.lng };
                }
            };
            resultsBox.appendChild(div);
        });
        resultsBox.classList.remove('hidden');
    });
};

window.confirmAddChecklistItem = () => {
    if (!checklistItemAddStopId) return;
    if (!checklistItemAddSelectedPlace) return alert('Pick a place from the dropdown results first.');
    const noteInput = document.getElementById('checklist-item-note');
    const note = noteInput ? noteInput.value.trim() : '';

    addChecklistItemToStop(checklistItemAddStopId, checklistItemAddSelectedPlace, note);
    window.closeAddChecklistItemPopover();
    saveState();
    if (typeof window.renderTimelineUI === 'function') window.renderTimelineUI();
    if (typeof window.renderSavedPOIs === 'function') window.renderSavedPOIs();
};

function renderStopChecklistSection(stop, stopIndex) {
    if (!expandedChecklistStopIds.has(stop.id)) return '';
    const items = stop.checklistItems || [];

    const itemsHtml = items.length > 0 ? items.map(item => `
        <div class="flex items-center gap-1.5 px-2" style="height: ${CHECKLIST_ITEM_PX}px;">
            <input type="checkbox" ${item.done ? 'checked' : ''} onchange="window.toggleChecklistItemDone('${stop.id}', '${item.id}', this.checked)" class="w-3.5 h-3.5 text-emerald-600 rounded border-gray-300 cursor-pointer shrink-0">
            <div class="flex-1 min-w-0 leading-tight">
                <div class="text-[11px] font-bold ${item.done ? 'text-gray-400 line-through' : 'text-gray-800'} truncate" title="${item.name}">${item.name}</div>
                ${item.note ? `<div class="text-[9px] text-gray-400 truncate" title="${item.note}">${item.note}</div>` : ''}
            </div>
            <button onclick="window.promoteChecklistItemToStop('${stop.id}', '${item.id}')" title="Make this its own stop"
                    class="shrink-0 text-[9px] text-blue-500 hover:text-blue-700 font-bold px-1 opacity-0 group-hover:opacity-100 transition-opacity">⤴ STOP</button>
            <button onclick="window.removeChecklistItem('${stop.id}', '${item.id}')" title="Remove from checklist"
                    class="shrink-0 text-red-400 hover:text-red-600 text-[10px] font-bold px-1">✕</button>
        </div>
    `).join('') : `
        <div class="flex items-center justify-center text-[10px] text-gray-400 italic" style="height: ${CHECKLIST_EMPTY_PX}px;">
            No items yet — scan for places nearby and add one.
        </div>
    `;

    return `
        <div class="absolute left-0 w-full bg-gray-50 border-l border-r border-b border-gray-200 rounded-b-md overflow-hidden" style="top: ${ROW_HEIGHT_PX}px;">
            <div class="flex items-center justify-between px-2" style="height: ${CHECKLIST_HEADER_PX}px;">
                <span class="text-[9px] font-bold uppercase tracking-wider text-gray-400">Checklist</span>
                <button onclick="window.openAddChecklistItemPopover('${stop.id}', this)" class="text-[9px] text-emerald-600 hover:text-emerald-700 font-bold">+ Add checklist item</button>
            </div>
            ${itemsHtml}
            <div style="height: ${CHECKLIST_BOTTOM_PADDING_PX}px;"></div>
        </div>
    `;
}

// --- CORE UI RENDER ---

export function renderTimelineUI() {
    const counter = document.getElementById('stop-counter');
    if (counter) counter.innerText = `Stops: ${state.stops.length}`;
    
    const activeStops = state.stops.filter(s => !s.skipped);
    const showActiveStops = true; 
    const showInactiveStops = state.appSettings.showTimelineInactiveStops !== false;
    const showTransit = true; 

    const shortDate = (d) => d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });

    let currentDate = new Date(state.appSettings.startDate + 'T00:00:00');
    let prevActiveIdx = -1;
    let uiTotalDriveHours = 0;
    let uiTotalFlightHours = 0;

    let renderItems = [];
    state.stops.forEach((stop, index) => {
        let item = { stop, index, isSkipped: stop.skipped, isFirstActive: false, isLocked: stop.isKeyDate };
        if (stop.skipped) {
            renderItems.push(item);
            return;
        }

        item.isFirstActive = (prevActiveIdx === -1);
        let arriveDate = new Date(currentDate);
        let departDate = new Date(currentDate);
        let displayMiles = 0;
        let displayHours = 0;
        let transitDays = 0;

        if (stop.isKeyDate) {
            const kd = (state.keyDates || []).find(k => k.id === stop.kdId);
            if (kd) {
                arriveDate = new Date(kd.startDate + 'T00:00:00');
                departDate = new Date(kd.endDate + 'T00:00:00');

                if (!item.isFirstActive) {
                    const fb = getFallbackStats(state.stops[prevActiveIdx], stop);
                    displayMiles = stop.distanceMiles || fb.miles;
                    displayHours = stop.transitHours || fb.hours;
                    transitDays = stop.transitDays ?? Math.floor(displayHours / 10);

                    const projectedArrive = new Date(currentDate);
                    projectedArrive.setDate(projectedArrive.getDate() + transitDays);
                    item.isOutOfSync = projectedArrive.getTime() > arriveDate.getTime();
                    item.projectedArriveDate = projectedArrive;
                }

                currentDate = new Date(departDate);
            }
        } else {
            if (!item.isFirstActive) {
                const fb = getFallbackStats(state.stops[prevActiveIdx], stop);
                displayMiles = stop.distanceMiles || fb.miles;
                displayHours = stop.transitHours || fb.hours;
                transitDays = stop.transitDays ?? Math.floor(displayHours / 10);

                currentDate.setDate(currentDate.getDate() + transitDays);
                arriveDate = new Date(currentDate);
                currentDate.setDate(currentDate.getDate() + stop.days);
                departDate = new Date(currentDate);
            } else {
                departDate = new Date(currentDate);
            }
        }

        item.arriveDate = arriveDate;
        item.departDate = departDate;
        item.prevActiveIdx = prevActiveIdx;

        item.incomingTransit = item.isFirstActive ? null : {
            mode: stop.mode || 'drive',
            miles: displayMiles,
            hours: displayHours,
            days: transitDays,
            prevIndex: prevActiveIdx,
            currIndex: index,
            id: stop.id 
        };

        if (item.incomingTransit) {
            if (item.incomingTransit.mode === 'flight') uiTotalFlightHours += displayHours;
            else uiTotalDriveHours += displayHours;
        }

        renderItems.push(item);
        prevActiveIdx = index;
    });

    let finalArriveDate = null;
    let returnTransit = null;
    if (activeStops.length > 1) {
        const lastStop = activeStops[activeStops.length - 1];
        const startStop = activeStops[0];
        const fb = getFallbackStats(lastStop, startStop);
        const retMiles = startStop.distanceMiles || fb.miles;
        const retHours = startStop.transitHours || fb.hours;
        const retMode = state.appSettings.returnMode || 'drive';
        const retDays = state.appSettings.returnTransitDays ?? Math.floor(retHours / 10);

        finalArriveDate = new Date(currentDate);
        finalArriveDate.setDate(finalArriveDate.getDate() + retDays);

        returnTransit = {
            mode: retMode,
            miles: retMiles,
            hours: retHours,
            days: retDays,
            isReturn: true
        };

        if (retMode === 'flight') uiTotalFlightHours += retHours;
        else uiTotalDriveHours += retHours;
    }

    const finalDateStr = shortDate(finalArriveDate || currentDate);

    for (let i = 0; i < renderItems.length; i++) {
        let item = renderItems[i];
        if (item.isSkipped) continue;

        let nextActive = null;
        for (let j = i + 1; j < renderItems.length; j++) {
            if (!renderItems[j].isSkipped) { nextActive = renderItems[j]; break; }
        }

        if (nextActive && nextActive.incomingTransit) item.outgoingTransit = nextActive.incomingTransit;
        else if (!nextActive && returnTransit) item.outgoingTransit = returnTransit;
    }

    const visualTopPx = [];
    const heightPx = [];
    {
        let runningTopPx = 0;
        renderItems.forEach((item, i) => {
            const occupiesSlot = !item.isSkipped || showInactiveStops;
            if (!occupiesSlot) {
                visualTopPx[i] = null;
                heightPx[i] = 0;
                return;
            }

            let rowHeight = ROW_HEIGHT_PX;
            if (!item.isSkipped && expandedChecklistStopIds.has(item.stop.id)) {
                const items = item.stop.checklistItems || [];
                rowHeight += CHECKLIST_HEADER_PX + CHECKLIST_BOTTOM_PADDING_PX
                    + (items.length > 0 ? items.length * CHECKLIST_ITEM_PX : CHECKLIST_EMPTY_PX);
            }

            visualTopPx[i] = runningTopPx;
            heightPx[i] = rowHeight;
            runningTopPx += rowHeight;
        });
        visualTopPx.homeRowTopPx = runningTopPx; 
        visualTopPx.totalContentHeightPx = runningTopPx;
    }

    const timelineHeightPx = visualTopPx.totalContentHeightPx + (activeStops.length > 1 ? ROW_HEIGHT_PX : 0);

    let lineSvgContent = '';
    let rowsHtmlContent = '';
    let pillsHtmlContent = '';

    renderItems.forEach((item, renderIdx) => {
        const { stop, index, isSkipped, isFirstActive, isLocked, arriveDate, departDate, outgoingTransit, isOutOfSync, projectedArriveDate } = item;
        const isEditing = editingStopId === stop.id;
        const rowTopPx = visualTopPx[renderIdx];
        const rowHeightPx = heightPx[renderIdx];

        if (isSkipped) {
            if (showInactiveStops) {
                rowsHtmlContent += `
                    <div class="absolute left-0 flex items-start group" style="width: calc(100% - 240px); top: ${rowTopPx}px; height: ${ROW_HEIGHT_PX}px; z-index: ${100 - index};">
                        
                        <!-- STOP CARD -->
                        <div class="flex-1 w-full h-full relative flex items-center justify-between">
                            
                            <!-- Faded content wrapper -->
                            <div class="w-full h-full ${isEditing ? 'bg-white' : 'bg-gray-50 opacity-60 grayscale'} px-2 border border-gray-200 rounded-md flex items-center justify-between cursor-grab active:cursor-grabbing ${isEditing ? '' : 'hover:bg-gray-100'}"
                                 draggable="${!isEditing}" ondragstart="${!isEditing ? `dragStart(event, ${index})` : ''}" ondragover="dragOver(event)" ondragend="dragEnd(event)" ondrop="drop(event, ${index})"
                                 onmouseenter="if(window.highlightStopMapPin) window.highlightStopMapPin('${stop.id}')"
                                 onmouseleave="if(window.unhighlightStopMapPin) window.unhighlightStopMapPin('${stop.id}')">
                                 
                                <div class="flex items-center gap-2 min-w-0 flex-1 relative">
                                    <span class="w-5 h-5 shrink-0 rounded-full bg-gray-200 border border-gray-300 flex items-center justify-center text-[10px] font-bold text-gray-500 ${isEditing ? '' : 'line-through'}">${index + 1}</span>
                                    ${isEditing ? `
                                        <div class="flex-1 min-w-0 relative">
                                            <input type="text" id="edit-stop-${stop.id}" value="${stop.key}" oninput="window.handleEditSearch(this.value, '${stop.id}')" onmousedown="event.stopPropagation()" onkeydown="window.handleEditStopKeydown(event, '${stop.id}')" class="w-full text-xs border border-blue-400 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-inner z-[100] relative bg-white">
                                            <div id="edit-results-${stop.id}" class="absolute top-full left-0 bg-white border border-gray-200 shadow-xl z-[150] hidden max-h-48 overflow-y-auto rounded-lg mt-1 overflow-hidden" style="width: max(100%, 420px);"></div>
                                        </div>
                                        <button onclick="window.cancelEditStop(event)" class="text-gray-400 hover:text-red-500 text-xs font-bold px-1.5 z-[100] relative">✕</button>
                                    ` : `
                                        <h3 class="font-bold text-gray-500 text-xs truncate line-through flex-1 min-w-0" title="${stop.key}">${stop.key}</h3>
                                    `}
                                </div>
                            </div>
                            
                            <!-- MENU OUTSIDE FADED CONTAINER (Crisp & Clear) -->
                            ${isEditing ? '' : `
                            <div class="absolute right-2 top-1/2 -translate-y-1/2 inline-block text-left row-menu-container z-20">
                                <button onclick="window.toggleRowMenu('${stop.id}', event)" class="opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5 rounded bg-white/80 hover:bg-white border border-gray-200 text-gray-700 flex items-center justify-center font-bold shadow-sm">⋮</button>
                                <div id="row-menu-${stop.id}" class="row-menu-dropdown hidden absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 shadow-xl rounded-md z-[200] py-1 overflow-hidden">
                                    <button onclick="toggleSkip('${stop.id}', false)" class="w-full text-left px-3 py-1.5 text-[11px] font-bold text-emerald-600 hover:bg-emerald-50">✓ Enable Stop</button>
                                    <div class="h-px bg-gray-100 my-1"></div>
                                    <button onclick="window.beginInsertStop(${index})" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Insert Above</button>
                                    <button onclick="window.beginInsertStop(${index + 1})" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Insert Below</button>
                                    <button onclick="window.beginEditStop('${stop.id}')" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Edit Location</button>
                                    <button onclick="window.openPoiScanPopover({type:'stop', stopIndex:${index}}, null)" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Find Nearby POIs</button>
                                    <div class="h-px bg-gray-100 my-1"></div>
                                    <button onclick="removeStop(${index})" class="w-full text-left px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50">Delete</button>
                                </div>
                            </div>
                            `}
                        </div>
                    </div>
                `;
            }
            return;
        }

        if (showActiveStops) {
            const outOfSyncTitle = isOutOfSync ? `At the current pace you'd arrive ${shortDate(projectedArriveDate)}, after this key date's required start of ${shortDate(arriveDate)} — you'll miss it unless earlier stops are shortened or this one is moved up.` : '';
            rowsHtmlContent += `
                <div class="absolute left-0 flex items-start group" style="width: calc(100% - 240px); top: ${rowTopPx}px; height: ${rowHeightPx}px; z-index: ${100 - index};">

                    <div class="flex-1 w-full relative">
                        <div class="w-full bg-white px-2 border ${isOutOfSync ? 'border-red-400 ring-1 ring-red-300' : (isLocked ? 'border-amber-400' : 'border-gray-200')} rounded-md flex items-center justify-between shadow-sm relative hover:bg-gray-50 ${isEditing ? '' : 'cursor-grab active:cursor-grabbing'}" style="height: ${ROW_HEIGHT_PX}px;"
                             draggable="${!isEditing}" ondragstart="${!isEditing ? `dragStart(event, ${index})` : ''}" ondragover="dragOver(event)" ondragend="dragEnd(event)" ondrop="drop(event, ${index})" title="${outOfSyncTitle}"
                             onmouseenter="if(window.highlightStopMapPin) window.highlightStopMapPin('${stop.id}')"
                             onmouseleave="if(window.unhighlightStopMapPin) window.unhighlightStopMapPin('${stop.id}')">

                            <div class="flex items-center gap-2 flex-1 min-w-0 pr-1 relative">
                                <span class="w-5 h-5 shrink-0 rounded-full ${isOutOfSync ? 'bg-red-100 text-red-700' : (isLocked ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600')} border flex items-center justify-center text-[10px] font-bold">${index + 1}</span>

                                ${isEditing ? `
                                    <div class="flex-1 min-w-0 relative">
                                        <input type="text" id="edit-stop-${stop.id}" value="${stop.key}" oninput="window.handleEditSearch(this.value, '${stop.id}')" onmousedown="event.stopPropagation()" onkeydown="window.handleEditStopKeydown(event, '${stop.id}')" class="w-full text-xs border border-blue-400 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 shadow-inner z-[100] relative bg-white">
                                        <div id="edit-results-${stop.id}" class="absolute top-full left-0 bg-white border border-gray-200 shadow-xl z-[150] hidden max-h-48 overflow-y-auto rounded-lg mt-1 overflow-hidden" style="width: max(100%, 420px);"></div>
                                    </div>
                                    <button onclick="window.cancelEditStop(event)" class="text-gray-400 hover:text-red-500 text-xs font-bold px-1.5 z-[100] relative">✕</button>
                                ` : `
                                    <h3 class="font-bold ${isOutOfSync ? 'text-red-700' : (isLocked ? 'text-amber-700' : 'text-gray-800')} text-xs truncate flex-1 min-w-0" title="${stop.key}">${isOutOfSync ? '⚠️ ' : ''}${stop.key}</h3>
                                `}
                            </div>

                            ${isFirstActive ? `
                                <div class="flex items-center gap-1 shrink-0">
                                    <input type="date" value="${state.appSettings.startDate}" onchange="updateStartDate(this.value)" class="bg-gray-50 border border-gray-200 rounded px-1 py-0 text-emerald-600 text-[10px] font-bold focus:outline-none w-[90px]">
                                    <span class="text-[10px] font-bold text-amber-600">Ret: ${finalDateStr}</span>
                                </div>
                            ` : `
                                <div class="flex items-center gap-2 shrink-0">
                                    ${isLocked ? `
                                        <span class="text-[10px] font-bold rounded px-1 border ${isOutOfSync ? 'text-red-700 bg-red-50 border-red-200' : 'text-amber-600 bg-amber-50 border-amber-100'}">${isOutOfSync ? '⚠️' : '🔒'} ${stop.days}d</span>
                                    ` : `
                                        <div class="flex items-center bg-gray-50 rounded px-1 border border-gray-200">
                                            <span class="text-[9px] text-gray-400 font-bold mr-0.5">Stay:</span>
                                            <input type="number" value="${stop.days}" oninput="changeDays('${stop.id}', this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" class="w-6 bg-transparent text-gray-900 font-bold text-[11px] text-center focus:outline-none p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none">
                                        </div>
                                    `}
                                    <div class="text-[10px] font-bold flex items-center gap-0.5">
                                        <span class="text-emerald-600">${shortDate(arriveDate)}</span>
                                        <span class="text-gray-300">-</span>
                                        <span class="text-amber-600">${shortDate(departDate)}</span>
                                    </div>
                                </div>
                            `}
                            
                            <button onclick="window.toggleStopChecklist('${stop.id}')" title="${expandedChecklistStopIds.has(stop.id) ? 'Hide' : 'Show'} checklist"
                                    class="shrink-0 ml-1.5 h-[18px] min-w-[18px] px-1 rounded-full border text-[9px] font-bold flex items-center justify-center shadow-sm transition-colors ${(stop.checklistItems && stop.checklistItems.length > 0) ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-white border-gray-300 text-gray-400 opacity-0 group-hover:opacity-100'} ${expandedChecklistStopIds.has(stop.id) ? 'ring-1 ring-emerald-400' : ''}">📋${(stop.checklistItems && stop.checklistItems.length > 0) ? ' ' + stop.checklistItems.length : ''}</button>
                                    
                            <!-- MENU WITH 'DISABLE STOP' -->
                            <div class="relative inline-block text-left ml-1 row-menu-container shrink-0">
                                <button onclick="window.toggleRowMenu('${stop.id}', event)" class="opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5 rounded hover:bg-gray-200 text-gray-500 flex items-center justify-center font-bold">⋮</button>
                                <div id="row-menu-${stop.id}" class="row-menu-dropdown hidden absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 shadow-xl rounded-md z-[200] py-1 overflow-hidden">
                                    <button onclick="toggleSkip('${stop.id}', true)" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">🚫 Disable Stop</button>
                                    <div class="h-px bg-gray-100 my-1"></div>
                                    <button onclick="window.beginInsertStop(${index})" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Insert Above</button>
                                    <button onclick="window.beginInsertStop(${index + 1})" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Insert Below</button>
                                    <button onclick="window.beginEditStop('${stop.id}')" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Edit Location</button>
                                    <button onclick="window.openPoiScanPopover({type:'stop', stopIndex:${index}}, null)" class="w-full text-left px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50">Find Nearby POIs</button>
                                    <div class="h-px bg-gray-100 my-1"></div>
                                    <button onclick="removeStop(${index})" class="w-full text-left px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50">Delete</button>
                                </div>
                            </div>
                        </div>
                        ${renderStopChecklistSection(stop, index)}
                    </div>
                </div>
            `;
        }

        if (showTransit && outgoingTransit) {
            const isFlight = outgoingTransit.mode === 'flight';

            let nextActiveRenderIdx = -1;
            for (let j = renderIdx + 1; j < renderItems.length; j++) {
                if (!renderItems[j].isSkipped) {
                    nextActiveRenderIdx = j;
                    break;
                }
            }
            const targetRenderIdx = (nextActiveRenderIdx !== -1) ? nextActiveRenderIdx : renderItems.length;
            
            const originCenterPx = rowTopPx + ROW_HEIGHT_PX / 2;
            const targetTopPx = (nextActiveRenderIdx !== -1) ? visualTopPx[nextActiveRenderIdx] : visualTopPx.homeRowTopPx;
            const targetCenterPx = targetTopPx + ROW_HEIGHT_PX / 2;
            const pillCenterPx = (originCenterPx + targetCenterPx) / 2;
            const pillTopPx = pillCenterPx - (ROW_HEIGHT_PX / 2);

            // FIXED ANCHORING: Transit Pill explicitly pinned to the right edge. 
            // width 208px + right 8px padding = exactly 216px taken on the right.
            pillsHtmlContent += `
                <div class="absolute" style="top: ${pillTopPx}px; right: 8px; width: 208px; height: ${ROW_HEIGHT_PX}px; z-index: 120;">
                    <div class="h-full flex items-center justify-end">
                        <div class="w-full bg-white border border-gray-200 rounded-full px-2 py-1 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow">
                            <select onchange="${outgoingTransit.isReturn ? `window.updateSettings('returnMode', this.value)` : `changeMode('${outgoingTransit.id}', this.value)`}" class="bg-transparent text-[11px] focus:outline-none cursor-pointer py-0 w-8 shrink-0">
                                <option value="drive" ${!isFlight ? 'selected' : ''}>🚗</option>
                                <option value="flight" ${isFlight ? 'selected' : ''}>✈️</option>
                            </select>
                            <span class="text-[10px] text-emerald-600 font-mono tracking-tighter truncate">${outgoingTransit.miles.toLocaleString()}mi</span>

                            ${!isFlight && !outgoingTransit.isReturn ? `
                            <div class="flex items-center border-x border-gray-100 px-1">
                                <button onclick="window.openPoiScanPopover({type:'leg', prevIndex:${outgoingTransit.prevIndex}, currIndex:${outgoingTransit.currIndex}}, this)" class="hover:bg-gray-100 rounded px-1 py-0.5 text-xs transition flex items-center" title="Search for places along this leg">
                                    📍
                                </button>
                            </div>
                            ` : '<div class="w-6"></div>'}

                            <span class="text-[10px] text-blue-600 font-mono tracking-tighter truncate">${outgoingTransit.hours.toFixed(1)}h</span>
                            <div class="flex items-center bg-gray-50 rounded border border-gray-100 px-1 shrink-0">
                                <input type="number" value="${outgoingTransit.days}" oninput="${outgoingTransit.isReturn ? `window.updateSettings('returnTransitDays', parseInt(this.value) || 0)` : `window.updateTransitDays('${outgoingTransit.id}', this.value)`}" class="w-6 bg-transparent text-[10px] text-amber-600 font-bold text-center focus:outline-none py-0">
                                <span class="text-[8px] text-gray-400 uppercase tracking-widest font-bold">days</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            const lineColor = isFlight ? '#60a5fa' : '#34d399';
            const dashStyle = isFlight ? 'stroke-dasharray="4 4"' : '';
            const startY = originCenterPx;   
            const kinkY = pillCenterPx;       
            const endY = targetCenterPx;      

            // SVG is built normally. Container handles horizontal position.
            lineSvgContent += `
                <g>
                    <line x1="0" y1="${startY}" x2="100%" y2="${kinkY}" stroke="${lineColor}" stroke-width="2" ${dashStyle} />
                    <line x1="100%" y1="${kinkY}" x2="0" y2="${endY}" stroke="${lineColor}" stroke-width="2" ${dashStyle} />
                </g>
            `;
        }
    });

    if (activeStops.length > 1) {
        const startStop = activeStops[0];
        const homeRowTopPx = visualTopPx.homeRowTopPx;
        rowsHtmlContent += `
            <div class="absolute left-0 flex items-start" style="width: calc(100% - 240px); top: ${homeRowTopPx}px; height: ${ROW_HEIGHT_PX}px; z-index: 0;">
                <div class="flex-1 w-full h-full bg-emerald-50 px-2 border border-emerald-200 rounded-md flex items-center justify-between shadow-sm relative">
                    <div class="flex items-center gap-2 min-w-0 pr-1">
                        <span class="w-5 h-5 shrink-0 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300 flex items-center justify-center text-[10px] font-bold">⌂</span>
                        <h3 class="font-bold text-emerald-800 text-xs truncate">${startStop.key} (Home)</h3>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <span class="text-[9px] text-emerald-600 uppercase font-bold">Arrive</span>
                        <span class="text-emerald-700 text-[10px] font-bold bg-white px-1.5 py-0.5 rounded border border-emerald-100">${shortDate(finalArriveDate)}</span>
                    </div>
                </div>
            </div>
        `;
    }

    // FIXED ANCHORING: Master container handles overflow. SVG pinned to right: 216px
    const htmlContent = `
        <div class="relative w-full shrink-0" style="height: ${timelineHeightPx}px;">
            ${showTransit ? `
            <svg class="absolute pointer-events-none" style="top: 0; right: 216px; width: ${GUTTER_WIDTH_PX}px; height: ${timelineHeightPx}px; z-index: 1; overflow: visible;" preserveAspectRatio="none">
                ${lineSvgContent}
            </svg>
            ` : ''}
            ${rowsHtmlContent}
            ${showTransit ? pillsHtmlContent : ''}
        </div>
    `;

    const timelineContainer = document.getElementById('timeline-container');
    if (timelineContainer) timelineContainer.innerHTML = htmlContent;
}