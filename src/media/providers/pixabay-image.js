const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');

class PixabayImageProvider extends BaseProvider {
    constructor() {
        super('Pixabay Images', 'image');
    }

    isAvailable() {
        return !!config.pixabay?.apiKey;
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        const response = await axios.get('https://pixabay.com/api/', {
            params: {
                key: config.pixabay.apiKey,
                q: keyword,
                per_page: 20,
                orientation: 'horizontal',
                image_type: 'photo',
                safesearch: 'true',
                min_width: 1280,
            },
            timeout: 15000,
        });

        const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
        return hits.map(hit => ({
            id: `pixabay-img-${hit.id}`,
            url: hit.largeImageURL || hit.webformatURL,
            width: Number(hit.imageWidth || hit.webformatWidth || 0),
            height: Number(hit.imageHeight || hit.webformatHeight || 0),
            title: hit.tags || `Pixabay image ${hit.id}`,
            _provider: 'pixabay',
        })).filter(item => item.url);
    }
}

module.exports = PixabayImageProvider;
