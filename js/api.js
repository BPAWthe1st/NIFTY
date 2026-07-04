// js/api.js

export const API_KEYS = {
    // Replace with your actual Google Maps API Key
    GOOGLE_MAPS: 'AIzaSyBdumfp_DSeXWJbCG9Lz-IsegEgHz1YhgY', 
    
    // Chargetrip Credentials
    CHARGETRIP_CLIENT_ID: 'YOUR_CLIENT_ID_HERE',
    CHARGETRIP_APP_ID: 'YOUR_APP_ID_HERE',
};

// --- DYNAMIC GOOGLE MAPS LOADER ---
let googleMapsPromise = null;

export function loadGoogleMapsAPI() {
    if (googleMapsPromise) return googleMapsPromise;

    googleMapsPromise = new Promise((resolve, reject) => {
        // If it's already loaded, resolve immediately
        if (typeof google !== 'undefined') {
            resolve();
            return;
        }

        // Dynamically inject the script tag into the HTML head
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${API_KEYS.GOOGLE_MAPS}&libraries=places`;
        script.async = true;
        script.defer = true;
        
        script.onload = resolve;
        script.onerror = () => reject(new Error("Failed to load Google Maps API"));
        
        document.head.appendChild(script);
    });

    return googleMapsPromise;
}