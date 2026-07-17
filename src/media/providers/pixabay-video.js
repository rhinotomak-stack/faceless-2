const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');

class PixabayVideoProvider extends BaseProvider {
    constructor() {
        super('Pixabay Videos', 'video');
    }

    isAvailable() {
        return !!config.pixabay?.apiKey;
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        const response = await axios.get('https://pixabay.com/api/videos/', {
            params: {
                key: config.pixabay.apiKey,
                q: keyword,
                per_page: 20,
                orientation: 'horizontal',
                video_type: 'film',
                safesearch: 'true',
            },
            timeout: 15000,
        });

        const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
        return hits.map(hit => {
            const videos = hit.videos || {};
            const best = videos.large || videos.medium || videos.small || videos.tiny;
            if (!best?.url) return null;
            return {
                id: `pixabay-${hit.id}`,
                url: best.url,
                width: Number(best.width || 0),
                height: Number(best.height || 0),
                duration: Number(hit.duration || 0),
                title: hit.tags || `Pixabay video ${hit.id}`,
                _provider: 'pixabay',
                _directVideoUrl: best.url,
            };
        }).filter(Boolean);
    }
}

module.exports = PixabayVideoProvider;
