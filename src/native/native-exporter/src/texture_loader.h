#pragma once

#include <d3d11.h>
#include <cstdint>
#include <string>

namespace nativeexporter {

struct LoadedTexture {
    ID3D11Texture2D* texture = nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
    uint32_t width = 0;
    uint32_t height = 0;
};

// Load image file (PNG/JPEG/BMP) via WIC → BGRA premultiplied → D3D11 texture + SRV.
// Returns true on success. Caller owns the resources (release via releaseTexture).
bool loadImageWIC(ID3D11Device* device, const std::string& path, LoadedTexture& out);

void releaseTexture(LoadedTexture& tex);

} // namespace nativeexporter
