#!/usr/bin/env node
// Verify Bedrock credentials + model ID work through AWS Bedrock Runtime.
// Run manually only when you want to spend one tiny Bedrock request:
//   node scripts/test-bedrock.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
    const region = process.env.BEDROCK_REGION || 'us-east-1';
    const keyId = process.env.BEDROCK_ACCESS_KEY_ID || '';
    const secret = process.env.BEDROCK_SECRET_ACCESS_KEY || '';
    const model = process.env.BEDROCK_DIRECTOR_MODEL || '';

    console.log('Bedrock test config:');
    console.log(`  region: ${region}`);
    console.log(`  access key: ${keyId ? keyId.slice(0, 8) + '...' : '(missing)'}`);
    console.log(`  secret: ${secret ? '(set)' : '(missing)'}`);
    console.log(`  model: ${model || '(missing)'}\n`);

    if (!keyId || !secret || !model) {
        console.error('Missing required env vars. Aborting.');
        process.exit(1);
    }

    const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({
        region,
        credentials: {
            accessKeyId: keyId,
            secretAccessKey: secret,
        },
    });

    const t0 = Date.now();
    try {
        const res = await client.send(new ConverseCommand({
            modelId: model,
            messages: [{ role: 'user', content: [{ text: 'Reply with exactly: BEDROCK_OK' }] }],
            inferenceConfig: { maxTokens: 80 },
        }));
        const text = (res.output?.message?.content || []).map(b => b.text || '').join('').trim() || '(empty)';
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`Bedrock Runtime invocation succeeded in ${elapsed}s`);
        console.log(`   model response: ${text}`);
        console.log(`   usage: input=${res.usage?.inputTokens} output=${res.usage?.outputTokens}\n`);

        console.log('Testing router integration (callAI with provider:bedrock)...');
        const { callAI } = require('../src/brain/ai-provider');
        const t1 = Date.now();
        const routed = await callAI('Reply with exactly: ROUTER_OK', {
            provider: 'bedrock',
            taskType: 'brain',
            maxTokens: 40,
        });
        const elapsed2 = ((Date.now() - t1) / 1000).toFixed(1);
        console.log(`Router invocation succeeded in ${elapsed2}s`);
        console.log(`   response: ${String(routed).trim()}`);
    } catch (err) {
        console.error('Bedrock invocation FAILED');
        console.error(`   message: ${err.message}`);
        if (err.status) console.error(`   status: ${err.status}`);
        if (err.error) console.error(`   error: ${JSON.stringify(err.error, null, 2)}`);
        console.error('\nCommon causes:');
        console.error('  - Model ID wrong: paste the exact model ID from Bedrock model catalog / list-foundation-models');
        console.error('  - Access not granted: Bedrock console -> Model access -> confirm the model is enabled');
        console.error('  - IAM policy missing: user needs Bedrock Runtime invoke permissions');
        console.error('  - Wrong region: confirm BEDROCK_REGION matches the region where the model is enabled');
        process.exit(2);
    }
})();
