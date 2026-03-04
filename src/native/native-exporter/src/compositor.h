#pragma once

#include <d3d11.h>
#include <cstdint>
#include <string>
#include <vector>

namespace nativeexporter {

struct RenderLayer {
    std::string type;         // "solid" or "image"
    float color[4] = {0,0,0,1}; // RGBA for solid
    uint32_t startFrame = 0;
    uint32_t endFrame = 0;
    uint32_t trackNum = 1;    // 1=base(opaque), 2-3=alpha blend
    float opacity = 1.0f;
    // Image layer fields
    std::string mediaPath;    // filesystem path to PNG/JPEG
    std::string fitMode;      // "cover" or "contain"
    uint32_t mediaWidth = 0;
    uint32_t mediaHeight = 0;
    int layerIndex = -1;      // index into texture cache
};

struct RenderPlan {
    uint32_t width = 1920;
    uint32_t height = 1080;
    uint32_t fps = 30;
    uint32_t totalFrames = 0;
    std::vector<RenderLayer> layers;
};

bool initCompositor(ID3D11Device* device, ID3D11DeviceContext* ctx);
bool loadTextures(RenderPlan& plan);  // loads image layers, sets layerIndex
void renderFrame(uint32_t frameNum, const RenderPlan& plan,
                 ID3D11RenderTargetView* rtv, uint32_t width, uint32_t height);
void shutdownCompositor();

} // namespace nativeexporter
