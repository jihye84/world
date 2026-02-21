let currentMode = 'map'; // 'map' or 'globe'
let worldData = null;
const countryCache = {}; // Cache API responses to save memory and network

// UI Elements
const infoPanel = document.getElementById('info-panel');
const countryNameEl = document.getElementById('country-name');
const countryFlagEl = document.getElementById('country-flag');
const capitalNameEl = document.getElementById('capital-name');
const closeBtn = document.getElementById('close-btn');
const welcomeMsg = document.getElementById('welcome-message');
const modeToggleBtn = document.getElementById('mode-toggle');
const soundToggleBtn = document.getElementById('sound-toggle');
const mapContainer = document.getElementById('map');
const globeContainer = document.getElementById('globe');

let isSoundOn = true;

// ----------------------------------------------------
// 2D MAP SETUP (Leaflet)
// ----------------------------------------------------
const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 10,
    minZoom: 2
}).addTo(map);

const capitalIcon = L.divIcon({
    className: 'capital-icon-container',
    html: '<div class="capital-marker"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
});

let geojsonLayer;
let currentCapitalMarker;
let selectedFeatureId = null;

// Style configurations
const defaultStyle = { color: "#fff", weight: 1, fillColor: "#4ECDC4", fillOpacity: 0.6 };
const highlightStyle = { color: "#fff", weight: 2, fillColor: "#FF6B6B", fillOpacity: 0.8 };
const selectedStyle = { color: "#fff", weight: 3, fillColor: "#FFE66D", fillOpacity: 0.9 };

// ----------------------------------------------------
// 3D GLOBE SETUP (Globe.gl)
// ----------------------------------------------------
const globe = Globe()(globeContainer)
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-water.png')
    .polygonAltitude(0.01)
    .polygonCapColor(feat => feat.id === selectedFeatureId ? '#FFE66D' : '#4ECDC4')
    .polygonSideColor(() => 'rgba(0, 100, 0, 0.15)')
    .polygonStrokeColor(() => '#ffffff')
    /*
    .polygonLabel(({ properties: d }) => `
      <div style="background: white; color: black; padding: 5px; border-radius: 5px; border: 2px solid #FF6B6B; font-family: 'Jua', sans-serif;">
        <b>${d.ADMIN || d.name || ''}</b>
      </div>
    `)
    */
    .onPolygonHover(hoverD => {
        globe.polygonCapColor(d => {
            if (d.id === selectedFeatureId) return '#FFE66D';
            if (d === hoverD) return '#FF6B6B';
            return '#4ECDC4';
        });
    })
    .onPolygonClick(polygon => {
        handleLocationClick(polygon, 'globe');
    });

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.5;

// Handle window resize for globe
window.addEventListener('resize', () => {
    if (currentMode === 'globe') {
        globe.width(window.innerWidth).height(window.innerHeight);
    }
});

// ----------------------------------------------------
// TOGGLE MODE LOGIC
// ----------------------------------------------------
modeToggleBtn.addEventListener('click', () => {
    if (currentMode === 'map') {
        currentMode = 'globe';
        mapContainer.classList.add('hidden');
        globeContainer.classList.remove('hidden');
        modeToggleBtn.innerText = '🗺️ 지도 모드';

        // Ensure globe draws correctly after being un-hidden
        globe.width(window.innerWidth).height(window.innerHeight);
    } else {
        currentMode = 'map';
        globeContainer.classList.add('hidden');
        mapContainer.classList.remove('hidden');
        modeToggleBtn.innerText = '🌍 지구본 모드';

        map.invalidateSize(); // Fix leafet rendering when un-hidden
    }
    closePanel();
});

soundToggleBtn.addEventListener('click', () => {
    isSoundOn = !isSoundOn;
    if (isSoundOn) {
        soundToggleBtn.innerText = '🔊 소리 켜짐';
        soundToggleBtn.style.borderColor = '#FF6B6B'; // primary color
    } else {
        soundToggleBtn.innerText = '🔇 소리 꺼짐';
        soundToggleBtn.style.borderColor = '#ccc';
        if (window.responsiveVoice) window.responsiveVoice.cancel();
        window.speechSynthesis.cancel(); // Fallback
    }
});

let voiceToggleIndex = 0;

function speakText(text) {
    if (!isSoundOn) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 0.95; // Just slightly slower for clarity
    utterance.pitch = 1.0; // Natural pitch

    // Get all available Korean voices
    const voices = window.speechSynthesis.getVoices();
    const koreanVoices = voices.filter(v => v.lang.includes('ko'));

    if (koreanVoices.length > 0) {
        // Try to filter out duplicate names/engines to find truly different voices
        const distinctVoices = [];
        const seenNames = new Set();

        for (const v of koreanVoices) {
            // Group by base name (e.g., 'Google 한국의', 'Microsoft Heami')
            const baseName = v.name.split(' ')[0] + ' ' + (v.name.split(' ')[1] || '');
            if (!seenNames.has(baseName)) {
                seenNames.add(baseName);
                distinctVoices.push(v);
            }
        }

        // If we found at least 2 distinct voices (e.g., Heami and InJoon, or Apple Yuna and Google)
        if (distinctVoices.length >= 2) {
            voiceToggleIndex = (voiceToggleIndex + 1) % distinctVoices.length;
            utterance.voice = distinctVoices[voiceToggleIndex];
        } else if (koreanVoices.length >= 2) {
            // If we couldn't find distinct families, just alternate the first two
            voiceToggleIndex = (voiceToggleIndex + 1) % 2;
            utterance.voice = koreanVoices[voiceToggleIndex];
        } else {
            // Only 1 voice exists on this machine, just use it naturally without weird pitching
            utterance.voice = koreanVoices[0];
        }
    }

    window.speechSynthesis.speak(utterance);
}

// ----------------------------------------------------
// DATA FETCHING 
// ----------------------------------------------------
fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson')
    .then(response => response.json())
    .then(data => {
        worldData = data;

        // Add ID to each feature for tracking selection across views
        worldData.features.forEach(f => {
            f.id = f.properties.ISO_A3 !== '-99' ? f.properties.ISO_A3 : f.properties.ADM0_A3;
        });

        // Initialize 2D Map layer
        geojsonLayer = L.geoJSON(worldData, {
            style: defaultStyle,
            onEachFeature: (feature, layer) => {
                layer.on({
                    mouseover: (e) => {
                        if (feature.id !== selectedFeatureId) layer.setStyle(highlightStyle);
                    },
                    mouseout: (e) => {
                        if (feature.id !== selectedFeatureId) geojsonLayer.resetStyle(layer);
                    },
                    click: (e) => handleLocationClick(feature, 'map', layer)
                });
            }
        }).addTo(map);

        // Initialize 3D Globe polygons
        globe.polygonsData(worldData.features);
    })
    .catch(error => {
        console.error('Error loading GeoJSON:', error);
        alert('지도 데이터를 불러오는데 실패했어요. 새로고침 해주세요!');
    });


// ----------------------------------------------------
// SHARED CLICK HANDLER
// ----------------------------------------------------
async function handleLocationClick(feature, sourceView, layer = null) {
    welcomeMsg.style.display = 'none';

    // Stop rotation when clicked
    globe.controls().autoRotate = false;

    // Set selection state
    selectedFeatureId = feature.id;

    // Update Map Styles
    if (geojsonLayer) {
        geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l)); // reset all
        if (sourceView === 'map' && layer) {
            layer.setStyle(selectedStyle);
            layer.bringToFront();
        } else if (sourceView === 'globe') {
            // Find leafet layer and style it
            const matchingLayer = Object.values(geojsonLayer._layers).find(l => l.feature.id === feature.id);
            if (matchingLayer) {
                matchingLayer.setStyle(selectedStyle);
                matchingLayer.bringToFront();
            }
        }
    }

    // Update Globe Styles
    globe.polygonCapColor(d => d.id === selectedFeatureId ? '#FFE66D' : '#4ECDC4');

    const isoCode = feature.id;
    if (!isoCode || isoCode === '-99') {
        alert("이 지역의 정보는 아직 없어요!");
        return;
    }

    try {
        infoPanel.classList.remove('hidden');
        countryNameEl.innerText = "로딩 중... 🚀";
        capitalNameEl.innerText = "찾는 중...";
        countryFlagEl.style.display = 'none';

        let countryData;
        if (countryCache[isoCode]) {
            countryData = countryCache[isoCode];
        } else {
            const response = await fetch(`https://restcountries.com/v3.1/alpha/${isoCode}?fields=name,capital,capitalInfo,flags,translations`);
            const data = await response.json();
            // The API returns an array or single object depending on the endpoint, alpha/:code returns an array
            countryData = Array.isArray(data) ? data[0] : data;
            countryCache[isoCode] = countryData; // Save to cache
        }

        let koreanName = countryData.translations?.kor?.common || countryData.name.common;
        const flagUrl = countryData.flags.svg;

        let capitalNameEng = countryData.capital ? countryData.capital[0] : null;
        let capitalNameKor = '수도 정보 없음';
        if (capitalNameEng) {
            capitalNameKor = krCapitals[capitalNameEng] || capitalNameEng;
        }

        const capitalLatLng = countryData.capitalInfo?.latlng;

        // Update UI
        countryNameEl.innerText = koreanName;
        countryFlagEl.src = flagUrl;
        countryFlagEl.style.display = 'block';
        capitalNameEl.innerText = capitalNameKor;

        // Speak the country and capital
        if (capitalNameKor === '수도 정보 없음' || capitalNameKor === '-') {
            speakText(`${koreanName}. 수도 정보가 없습니다.`);
        } else {
            speakText(`${koreanName}. 수도는 ${capitalNameKor}입니다.`);
        }

        // Map updates (2D)
        if (currentCapitalMarker) map.removeLayer(currentCapitalMarker);

        if (capitalLatLng && capitalLatLng.length === 2) {
            currentCapitalMarker = L.marker([capitalLatLng[0], capitalLatLng[1]], {
                icon: capitalIcon
            }).addTo(map);

            if (sourceView === 'map') {
                map.flyTo([capitalLatLng[0], capitalLatLng[1]], 5, { duration: 1.5, easeLinearity: 0.25 });
            }

            // Globe updates (3D)
            // Focus camera on the capital
            globe.pointOfView({ lat: capitalLatLng[0], lng: capitalLatLng[1], altitude: 1.5 }, 1000);

        } else {
            if (sourceView === 'map' && layer) map.fitBounds(layer.getBounds(), { padding: [20, 20] });
        }

    } catch (error) {
        console.error("Error fetching country data:", error);
        countryNameEl.innerText = "정보를 찾을 수 없어요 😢";
        capitalNameEl.innerText = "-";
        countryFlagEl.style.display = 'none';
    }
}

function closePanel() {
    infoPanel.classList.add('hidden');
    window.speechSynthesis.cancel(); // stop speech when closed
    if (currentCapitalMarker) map.removeLayer(currentCapitalMarker);
    selectedFeatureId = null;
    if (geojsonLayer) geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l));
    globe.polygonCapColor(d => '#4ECDC4'); // Reset globe colors
    if (currentMode === 'map') {
        map.setView([20, 0], 2);
    } else {
        globe.controls().autoRotate = true; // Resume spin
    }
}

closeBtn.addEventListener('click', closePanel);
map.on('click', () => welcomeMsg.style.display = 'none');
