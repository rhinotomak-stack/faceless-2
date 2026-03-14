const axios = require('axios');
async function test() {
    const url = 'https://www.google.com/search?q=lumber+mill&tbm=isch&tbs=isz:l&hl=en&gl=us';
    try {
        const r = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2ODE5MjEyNTQaAmVuIAEaBgiA_LyaBg',
            },
            timeout: 10000, maxRedirects: 5,
        });
        const html = r.data;
        console.log('HTML length:', html.length);
        console.log('Has consent:', html.includes('consent.google'));
        console.log('Has captcha:', html.includes('unusual traffic'));

        // Method 1: ["url",width,height]
        const m1 = /\["(https?:\/\/[^"]{20,})",(\d+),(\d+)\]/gi;
        let count1 = 0, match;
        while ((match = m1.exec(html)) !== null) {
            count1++;
            if (count1 <= 2) console.log('M1:', match[1].substring(0, 100), match[2]+'x'+match[3]);
        }
        console.log('Method 1 total:', count1);

        // Broad: any jpg/png/webp URL
        const broadRe = /https?:\/\/[^\s"',\]\\>]{10,}\.(?:jpg|jpeg|png|webp)/gi;
        let countB = 0;
        while ((match = broadRe.exec(html)) !== null) {
            const u = match[0];
            if (!u.includes('gstatic') && !u.includes('google.com') && !u.includes('googleapis')) {
                countB++;
                if (countB <= 3) console.log('Broad:', u.substring(0, 120));
            }
        }
        console.log('Broad non-google total:', countB);

        // Save HTML snippet for analysis
        console.log('\n--- First 600 chars ---');
        console.log(html.substring(0, 600).replace(/\s+/g, ' '));

        // Check for image data patterns
        const hasAF = html.includes('AF_initDataCallback');
        const hasImgData = html.includes('"ischj"');
        const hasOu = html.includes('"ou"');
        console.log('\nAF_initDataCallback:', hasAF);
        console.log('ischj data:', hasImgData);
        console.log('"ou" pattern:', hasOu);

    } catch(e) { console.log('Error:', e.message); }
}
test();
