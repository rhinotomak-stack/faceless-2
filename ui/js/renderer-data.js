(() => {
    'use strict';

    window._countryGeoJSON = null;
    const api = window.electronAPI;
    if (!api?.getCountryGeoJSON) return;

    api.getCountryGeoJSON()
        .then((geojson) => {
            if (geojson && Array.isArray(geojson.features)) {
                window._countryGeoJSON = geojson;
            }
        })
        .catch((error) => {
            console.warn('[Renderer Data] Country boundaries unavailable:', error?.message || error);
        });
})();
