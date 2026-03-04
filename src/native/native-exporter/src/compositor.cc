#include "compositor.h"
#include "texture_loader.h"
#include <d3dcompiler.h>
#include <cstdio>
#include <cstring>
#include <vector>
#include <cmath>

namespace nativeexporter {

// ============================================================================
// HLSL Shaders (embedded)
// ============================================================================

static const char* VS_FULLSCREEN = R"(
struct VS_OUT {
    float4 pos : SV_POSITION;
    float2 uv  : TEXCOORD0;
};

// Fullscreen triangle from vertex ID (0,1,2) — no vertex buffer needed.
VS_OUT main(uint id : SV_VertexID) {
    VS_OUT o;
    o.uv  = float2((id << 1) & 2, id & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}
)";

static const char* PS_SOLID_COLOR = R"(
cbuffer CB : register(b0) {
    float4 u_color;
};

float4 main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    return u_color;
}
)";

static const char* PS_BLIT = R"(
Texture2D    u_texture : register(t0);
SamplerState u_sampler : register(s0);

cbuffer CB : register(b0) {
    float4 u_transform;  // scaleX, scaleY, offsetX, offsetY
    float  u_opacity;
    float3 _pad;
};

float4 main(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    // Apply fit-mode transform: inverse scale then offset
    float2 tc = (uv - 0.5) / u_transform.xy + 0.5 - u_transform.zw;

    // Out-of-bounds → transparent
    if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0)
        return float4(0, 0, 0, 0);

    float4 c = u_texture.Sample(u_sampler, tc);
    // Input is premultiplied alpha; scale both color and alpha by opacity
    c *= u_opacity;
    return c;
}
)";

// ============================================================================
// Static state
// ============================================================================

static ID3D11Device*            s_device = nullptr;
static ID3D11DeviceContext*     s_ctx    = nullptr;
static ID3D11VertexShader*      s_vs     = nullptr;
static ID3D11PixelShader*       s_psSolid = nullptr;
static ID3D11PixelShader*       s_psBlit  = nullptr;
static ID3D11Buffer*            s_cbuffer = nullptr;
static ID3D11SamplerState*      s_sampler = nullptr;
static ID3D11BlendState*        s_blendOpaque = nullptr;  // track 1
static ID3D11BlendState*        s_blendAlpha  = nullptr;  // track 2-3 (premul)
static bool                     s_ready  = false;

// Texture cache (indexed by layerIndex)
static std::vector<LoadedTexture> s_textures;

// Constant buffer data — 32 bytes, 16-byte aligned
struct alignas(16) CBData {
    float transform[4]; // scaleX, scaleY, offsetX, offsetY
    float opacity;
    float _pad[3];
};

// ============================================================================
// Shader compilation helper
// ============================================================================

static ID3DBlob* compileShader(const char* source, const char* target, const char* entryPoint) {
    ID3DBlob* blob = nullptr;
    ID3DBlob* errors = nullptr;

    HRESULT hr = D3DCompile(
        source, strlen(source),
        nullptr, nullptr, nullptr,
        entryPoint, target,
        D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
        &blob, &errors
    );

    if (FAILED(hr)) {
        if (errors) {
            fprintf(stderr, "[Compositor] Shader compile error: %s\n",
                    (const char*)errors->GetBufferPointer());
            errors->Release();
        }
        return nullptr;
    }
    if (errors) errors->Release();
    return blob;
}

// ============================================================================
// Public API
// ============================================================================

bool initCompositor(ID3D11Device* device, ID3D11DeviceContext* ctx) {
    if (s_ready) return true;
    if (!device || !ctx) return false;

    s_device = device;
    s_ctx = ctx;

    fprintf(stderr, "[Compositor] Compiling shaders...\n");

    // Vertex shader
    ID3DBlob* vsBlob = compileShader(VS_FULLSCREEN, "vs_5_0", "main");
    if (!vsBlob) return false;
    HRESULT hr = device->CreateVertexShader(
        vsBlob->GetBufferPointer(), vsBlob->GetBufferSize(), nullptr, &s_vs);
    vsBlob->Release();
    if (FAILED(hr)) {
        fprintf(stderr, "[Compositor] CreateVertexShader failed: 0x%08X\n", (unsigned)hr);
        return false;
    }

    // Pixel shader — solid color
    {
        ID3DBlob* blob = compileShader(PS_SOLID_COLOR, "ps_5_0", "main");
        if (!blob) { shutdownCompositor(); return false; }
        hr = device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &s_psSolid);
        blob->Release();
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Pixel shader — blit (texture + opacity + transform)
    {
        ID3DBlob* blob = compileShader(PS_BLIT, "ps_5_0", "main");
        if (!blob) { shutdownCompositor(); return false; }
        hr = device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &s_psBlit);
        blob->Release();
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Constant buffer (32 bytes = CBData)
    {
        D3D11_BUFFER_DESC cbDesc = {};
        cbDesc.ByteWidth = sizeof(CBData);
        cbDesc.Usage = D3D11_USAGE_DYNAMIC;
        cbDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        cbDesc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        hr = device->CreateBuffer(&cbDesc, nullptr, &s_cbuffer);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Sampler (LINEAR + CLAMP)
    {
        D3D11_SAMPLER_DESC sd = {};
        sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sd.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        hr = device->CreateSamplerState(&sd, &s_sampler);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Blend state — opaque (no blending, overwrite)
    {
        D3D11_BLEND_DESC bd = {};
        bd.RenderTarget[0].BlendEnable = FALSE;
        bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        hr = device->CreateBlendState(&bd, &s_blendOpaque);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    // Blend state — premultiplied alpha (Src=ONE, Dst=INV_SRC_ALPHA)
    {
        D3D11_BLEND_DESC bd = {};
        bd.RenderTarget[0].BlendEnable = TRUE;
        bd.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        hr = device->CreateBlendState(&bd, &s_blendAlpha);
        if (FAILED(hr)) { shutdownCompositor(); return false; }
    }

    s_ready = true;
    fprintf(stderr, "[Compositor] Init OK (VS + PS_Solid + PS_Blit + sampler + blend states)\n");
    return true;
}

bool loadTextures(RenderPlan& plan) {
    // Release any previous textures
    for (auto& t : s_textures) releaseTexture(t);
    s_textures.clear();

    for (auto& layer : plan.layers) {
        if (layer.type == "image" && !layer.mediaPath.empty()) {
            LoadedTexture tex;
            if (loadImageWIC(s_device, layer.mediaPath, tex)) {
                layer.layerIndex = (int)s_textures.size();
                layer.mediaWidth = tex.width;
                layer.mediaHeight = tex.height;
                s_textures.push_back(tex);
            } else {
                fprintf(stderr, "[Compositor] WARNING: Failed to load '%s', skipping layer\n",
                        layer.mediaPath.c_str());
                layer.layerIndex = -1;
            }
        }
    }

    fprintf(stderr, "[Compositor] Loaded %zu image textures\n", s_textures.size());
    return true;
}

void renderFrame(uint32_t frameNum, const RenderPlan& plan,
                 ID3D11RenderTargetView* rtv, uint32_t width, uint32_t height) {
    if (!s_ready || !rtv) return;

    // 1. Clear to black
    float black[4] = { 0.0f, 0.0f, 0.0f, 1.0f };
    s_ctx->ClearRenderTargetView(rtv, black);

    // 2. Set render target + viewport
    s_ctx->OMSetRenderTargets(1, &rtv, nullptr);

    D3D11_VIEWPORT vp = {};
    vp.Width = (float)width;
    vp.Height = (float)height;
    vp.MinDepth = 0.0f;
    vp.MaxDepth = 1.0f;
    s_ctx->RSSetViewports(1, &vp);

    // 3. Set shared state
    s_ctx->IASetInputLayout(nullptr);
    s_ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    s_ctx->VSSetShader(s_vs, nullptr, 0);

    float blendFactor[4] = { 0, 0, 0, 0 };

    // 4. Draw active layers (plan.layers is pre-sorted by trackNum)
    for (const auto& layer : plan.layers) {
        if (frameNum < layer.startFrame || frameNum >= layer.endFrame) continue;

        // Set blend state: track 1 = opaque, track 2+ = premultiplied alpha
        if (layer.trackNum <= 1) {
            s_ctx->OMSetBlendState(s_blendOpaque, blendFactor, 0xFFFFFFFF);
        } else {
            s_ctx->OMSetBlendState(s_blendAlpha, blendFactor, 0xFFFFFFFF);
        }

        if (layer.type == "solid") {
            // Update CB with solid color
            D3D11_MAPPED_SUBRESOURCE mapped;
            HRESULT hr = s_ctx->Map(s_cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
            if (SUCCEEDED(hr)) {
                CBData* cb = (CBData*)mapped.pData;
                cb->transform[0] = layer.color[0];
                cb->transform[1] = layer.color[1];
                cb->transform[2] = layer.color[2];
                cb->transform[3] = layer.color[3];
                cb->opacity = 1.0f;
                s_ctx->Unmap(s_cbuffer, 0);
            }

            s_ctx->PSSetShader(s_psSolid, nullptr, 0);
            s_ctx->PSSetConstantBuffers(0, 1, &s_cbuffer);
            s_ctx->Draw(3, 0);

        } else if (layer.type == "image" && layer.layerIndex >= 0 &&
                   layer.layerIndex < (int)s_textures.size()) {

            const LoadedTexture& tex = s_textures[layer.layerIndex];

            // Compute fit-mode transform (cover: fill frame, crop overflow)
            float srcAspect = (float)tex.width / (float)tex.height;
            float dstAspect = (float)width / (float)height;
            float scaleX = 1.0f, scaleY = 1.0f;

            if (layer.fitMode == "contain") {
                // Fit inside: scale down the larger dimension
                if (srcAspect > dstAspect) {
                    scaleY = dstAspect / srcAspect;
                } else {
                    scaleX = srcAspect / dstAspect;
                }
            } else {
                // Cover (default): fill frame, crop overflow
                if (srcAspect > dstAspect) {
                    scaleX = srcAspect / dstAspect;
                } else {
                    scaleY = dstAspect / srcAspect;
                }
            }

            // Update CB
            D3D11_MAPPED_SUBRESOURCE mapped;
            HRESULT hr = s_ctx->Map(s_cbuffer, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped);
            if (SUCCEEDED(hr)) {
                CBData* cb = (CBData*)mapped.pData;
                cb->transform[0] = scaleX;
                cb->transform[1] = scaleY;
                cb->transform[2] = 0.0f;  // offsetX (Milestone C)
                cb->transform[3] = 0.0f;  // offsetY (Milestone C)
                cb->opacity = layer.opacity;
                s_ctx->Unmap(s_cbuffer, 0);
            }

            s_ctx->PSSetShader(s_psBlit, nullptr, 0);
            s_ctx->PSSetConstantBuffers(0, 1, &s_cbuffer);
            s_ctx->PSSetShaderResources(0, 1, &tex.srv);
            s_ctx->PSSetSamplers(0, 1, &s_sampler);
            s_ctx->Draw(3, 0);

            // Unbind SRV to avoid hazards
            ID3D11ShaderResourceView* nullSRV = nullptr;
            s_ctx->PSSetShaderResources(0, 1, &nullSRV);
        }
    }

    // Reset blend state
    s_ctx->OMSetBlendState(nullptr, blendFactor, 0xFFFFFFFF);
    s_ctx->Flush();
}

void shutdownCompositor() {
    for (auto& t : s_textures) releaseTexture(t);
    s_textures.clear();

    if (s_blendAlpha)  { s_blendAlpha->Release();  s_blendAlpha = nullptr; }
    if (s_blendOpaque) { s_blendOpaque->Release(); s_blendOpaque = nullptr; }
    if (s_sampler)     { s_sampler->Release();     s_sampler = nullptr; }
    if (s_cbuffer)     { s_cbuffer->Release();     s_cbuffer = nullptr; }
    if (s_psBlit)      { s_psBlit->Release();      s_psBlit = nullptr; }
    if (s_psSolid)     { s_psSolid->Release();     s_psSolid = nullptr; }
    if (s_vs)          { s_vs->Release();          s_vs = nullptr; }
    s_device = nullptr;
    s_ctx = nullptr;
    s_ready = false;
    fprintf(stderr, "[Compositor] Shutdown\n");
}

} // namespace nativeexporter
