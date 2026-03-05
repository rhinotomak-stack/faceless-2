#pragma once

#include <d3d11.h>
#include <cstdint>
#include <string>
#include <vector>

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

// Update an existing DEFAULT-usage texture with pixels from a new image file.
// Texture must match expectedW x expectedH. Used for per-frame imageSequence updates.
bool updateTextureWIC(ID3D11DeviceContext* ctx, const std::string& path,
                      ID3D11Texture2D* texture, uint32_t expectedW, uint32_t expectedH);

// Decode image to raw PBGRA pixels in RAM (thread-safe, no D3D11 calls).
bool decodeImageToRAM(const std::string& path,
                      std::vector<BYTE>& outPixels,
                      uint32_t& outW, uint32_t& outH);

// Upload pre-decoded PBGRA pixels to an existing DEFAULT-usage texture (fast, main thread).
bool updateTextureFromRAM(ID3D11DeviceContext* ctx,
                          ID3D11Texture2D* texture,
                          const std::vector<BYTE>& pixels,
                          uint32_t w, uint32_t h,
                          uint32_t expectedW, uint32_t expectedH);

void releaseTexture(LoadedTexture& tex);

} // namespace nativeexporter
