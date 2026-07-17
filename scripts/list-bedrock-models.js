#!/usr/bin/env node
// List Bedrock foundation models + inference profiles available to this account.
// Run: node scripts/list-bedrock-models.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
    const region = process.env.BEDROCK_REGION || 'us-east-1';
    const keyId = process.env.BEDROCK_ACCESS_KEY_ID || '';
    const secret = process.env.BEDROCK_SECRET_ACCESS_KEY || '';

    const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = require('@aws-sdk/client-bedrock');
    const client = new BedrockClient({
        region,
        credentials: { accessKeyId: keyId, secretAccessKey: secret },
    });

    console.log(`Region: ${region}\n`);

    const providers = ['Anthropic', 'OpenAI', 'DeepSeek', 'Meta', 'Mistral AI', 'Amazon', 'Qwen', 'Moonshot'];
    for (const p of providers) {
        try {
            const fm = await client.send(new ListFoundationModelsCommand({ byProvider: p }));
            const list = fm.modelSummaries || [];
            if (list.length === 0) continue;
            console.log(`\n=== ${p} (${list.length}) ===`);
            for (const m of list) console.log(`  ${m.modelId}`);
        } catch (e) {
            console.log(`  (${p} list failed: ${e.message})`);
        }
    }

    try {
        console.log('\n=== Inference profiles (cross-region) ===');
        const ip = await client.send(new ListInferenceProfilesCommand({}));
        for (const p of ip.inferenceProfileSummaries || []) {
            const id = String(p.inferenceProfileId || '').toLowerCase();
            const name = String(p.inferenceProfileName || '').toLowerCase();
            if (!/(anthropic|claude|deepseek)/.test(`${id} ${name}`)) continue;
            console.log(`  ${p.inferenceProfileId}  (${p.inferenceProfileName})`);
        }
    } catch (e) {
        console.log(`  (ListInferenceProfiles failed: ${e.message})`);
    }
})();
