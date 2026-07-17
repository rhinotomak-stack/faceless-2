const axios = require('axios');
const config = require('../../settings/config');
const BaseProvider = require('./base-provider');

class PexelsVideoProvider extends BaseProvider {
    constructor() {
        super('Pexels Videos', 'video');
    }

    isAvailable() {
        return !!config.pexels?.apiKey;
    }

    async search(keyword) {
        if (!this.isAvailable()) return [];
        const response = await axios.get('https://api.pexels.com/videos/search', {
            params: {
                query: keyword,
                per_page: 20,
                orientation: 'landscape',
            },
            headers: { Authorization: config.pexels.apiKey },
            timeout: 15000,
        });

        const videos = Array.isArray(response.data?.videos) ? response.data.videos : [];
        return videos.map(video => {
            const files = Array.isArray(video.video_files) ? video.video_files : [];
            const best = files
                .filter(f => f?.link)
                .sort((a, b) => {
                    const ah = Number(a.height || 0);
                    const bh = Number(b.height || 0);
                    const aMp4 = String(a.file_type || '').includes('mp4') ? 1 : 0;
                    const bMp4 = String(b.file_type || '').includes('mp4') ? 1 : 0;
                    return (bMp4 - aMp4) || (bh - ah);
                })[0];
            if (!best?.link) return null;
            return {
                id: `pexels-${video.id}`,
                url: best.link,
                width: Number(best.width || video.width || 0),
                height: Number(best.height || video.height || 0),
                duration: Number(video.duration || 0),
                title: video.url || `Pexels video ${video.id}`,
                _provider: 'pexels',
                _directVideoUrl: best.link,
            };
        }).filter(Boolean);
    }
}

module.exports = PexelsVideoProvider;
