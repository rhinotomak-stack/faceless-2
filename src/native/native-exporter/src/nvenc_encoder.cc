#include "nvenc_encoder.h"
#include "nvenc_loader.h"
#include "d3d11_device.h"
#include "../include/nvEncodeAPI.h"
#include <windows.h>
#include <cstring>
#include <cstdio>

namespace nativeexporter {

static void* s_encoder = nullptr; // NVENC encoder handle
static ID3D11Texture2D* s_inputTexture = nullptr;
static NV_ENC_REGISTERED_PTR s_registeredResource = nullptr;
static std::string s_lastError;
static EncoderConfig s_config;
static uint64_t s_frameIndex = 0;
static bool s_initialized = false;

// Ring of output bitstream buffers (needed for B-frame reordering)
static const int MAX_OUTPUT_BUFFERS = 16;
static NV_ENC_OUTPUT_PTR s_bitstreamBuffers[MAX_OUTPUT_BUFFERS] = {};
static int s_numBuffers = 0;
static int s_sendIdx = 0;  // total frames submitted (monotonic)
static int s_readIdx = 0;  // total frames read out (monotonic)

static const char* nvencStatusStr(NVENCSTATUS s) {
    switch (s) {
        case NV_ENC_SUCCESS: return "SUCCESS";
        case NV_ENC_ERR_NO_ENCODE_DEVICE: return "NO_ENCODE_DEVICE";
        case NV_ENC_ERR_UNSUPPORTED_DEVICE: return "UNSUPPORTED_DEVICE";
        case NV_ENC_ERR_INVALID_ENCODERDEVICE: return "INVALID_ENCODERDEVICE";
        case NV_ENC_ERR_INVALID_DEVICE: return "INVALID_DEVICE";
        case NV_ENC_ERR_DEVICE_NOT_EXIST: return "DEVICE_NOT_EXIST";
        case NV_ENC_ERR_INVALID_PTR: return "INVALID_PTR";
        case NV_ENC_ERR_INVALID_EVENT: return "INVALID_EVENT";
        case NV_ENC_ERR_INVALID_PARAM: return "INVALID_PARAM";
        case NV_ENC_ERR_INVALID_CALL: return "INVALID_CALL";
        case NV_ENC_ERR_OUT_OF_MEMORY: return "OUT_OF_MEMORY";
        case NV_ENC_ERR_ENCODER_NOT_INITIALIZED: return "ENCODER_NOT_INITIALIZED";
        case NV_ENC_ERR_UNSUPPORTED_PARAM: return "UNSUPPORTED_PARAM";
        case NV_ENC_ERR_LOCK_BUSY: return "LOCK_BUSY";
        case NV_ENC_ERR_NOT_ENOUGH_BUFFER: return "NOT_ENOUGH_BUFFER";
        case NV_ENC_ERR_INVALID_VERSION: return "INVALID_VERSION";
        case NV_ENC_ERR_MAP_FAILED: return "MAP_FAILED";
        case NV_ENC_ERR_NEED_MORE_INPUT: return "NEED_MORE_INPUT";
        case NV_ENC_ERR_ENCODER_BUSY: return "ENCODER_BUSY";
        case NV_ENC_ERR_EVENT_NOT_REGISTERD: return "EVENT_NOT_REGISTERD";
        case NV_ENC_ERR_GENERIC: return "GENERIC";
        case NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY: return "INCOMPATIBLE_CLIENT_KEY";
        case NV_ENC_ERR_UNIMPLEMENTED: return "UNIMPLEMENTED";
        case NV_ENC_ERR_RESOURCE_REGISTER_FAILED: return "RESOURCE_REGISTER_FAILED";
        case NV_ENC_ERR_RESOURCE_NOT_REGISTERED: return "RESOURCE_NOT_REGISTERED";
        case NV_ENC_ERR_RESOURCE_NOT_MAPPED: return "RESOURCE_NOT_MAPPED";
        case NV_ENC_ERR_NEED_MORE_OUTPUT: return "NEED_MORE_OUTPUT";
        default: return "UNKNOWN";
    }
}

static const GUID& getPresetGuid(uint32_t preset) {
    switch (preset) {
        case 1: return NV_ENC_PRESET_P1_GUID;
        case 2: return NV_ENC_PRESET_P2_GUID;
        case 3: return NV_ENC_PRESET_P3_GUID;
        case 4: return NV_ENC_PRESET_P4_GUID;
        case 5: return NV_ENC_PRESET_P5_GUID;
        case 6: return NV_ENC_PRESET_P6_GUID;
        case 7: return NV_ENC_PRESET_P7_GUID;
        default: return NV_ENC_PRESET_P5_GUID;
    }
}

static NV_ENC_PARAMS_RC_MODE getRcMode(const std::string& rc) {
    if (rc == "cbr") return NV_ENC_PARAMS_RC_CBR;
    if (rc == "cbr_hq") return NV_ENC_PARAMS_RC_CBR;
    return NV_ENC_PARAMS_RC_VBR; // default
}

bool openSession(ID3D11Device* device) {
    if (s_encoder) return true;
    if (!device) { s_lastError = "No D3D11 device"; return false; }
    s_initialized = false;
    for (int i = 0; i < MAX_OUTPUT_BUFFERS; i++) s_bitstreamBuffers[i] = nullptr;
    s_numBuffers = 0;
    s_sendIdx = 0;
    s_readIdx = 0;
    s_registeredResource = nullptr;
    s_inputTexture = nullptr;
    s_frameIndex = 0;

    auto* fn = getNvencFunctions();
    if (!fn) {
        s_lastError = "NVENC function list is null";
        return false;
    }

    // Check critical function pointers
    fprintf(stderr, "[NVENC] === Function Pointer Check ===\n");
    fprintf(stderr, "[NVENC]   nvEncOpenEncodeSession:   %p\n", (void*)fn->nvEncOpenEncodeSession);
    fprintf(stderr, "[NVENC]   nvEncOpenEncodeSessionEx: %p\n", (void*)fn->nvEncOpenEncodeSessionEx);
    fprintf(stderr, "[NVENC]   nvEncGetEncodeGUIDCount:  %p\n", (void*)fn->nvEncGetEncodeGUIDCount);
    fprintf(stderr, "[NVENC]   nvEncInitializeEncoder:   %p\n", (void*)fn->nvEncInitializeEncoder);
    fprintf(stderr, "[NVENC]   nvEncEncodePicture:       %p\n", (void*)fn->nvEncEncodePicture);
    fprintf(stderr, "[NVENC]   nvEncDestroyEncoder:      %p\n", (void*)fn->nvEncDestroyEncoder);
    fprintf(stderr, "[NVENC]   nvEncRegisterResource:    %p\n", (void*)fn->nvEncRegisterResource);

    if (!fn->nvEncOpenEncodeSessionEx) {
        s_lastError = "nvEncOpenEncodeSessionEx function pointer is null";
        return false;
    }

    uint32_t maxSupportedVersion = getNvencMaxSupportedApiVersion();
    uint32_t requestedVersion = NVENCAPI_VERSION;
    uint32_t negotiatedVersion = requestedVersion;

    fprintf(stderr, "[NVENC] maxSupportedVersion=0x%08X\n", maxSupportedVersion);
    fprintf(stderr, "[NVENC] NVENCAPI_VERSION=0x%08X\n", requestedVersion);
    if (maxSupportedVersion != 0 && requestedVersion > maxSupportedVersion) {
        negotiatedVersion = maxSupportedVersion;
        fprintf(stderr, "[NVENC] NVENCAPI_VERSION > maxSupportedVersion, using apiVersion=0x%08X\n",
                negotiatedVersion);
    }

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS params = {0};
    params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    params.device = (void*)device;
    params.apiVersion = negotiatedVersion;

    const uint32_t adapterVendorId = getAdapterVendorId();
    const LUID adapterLuid = getAdapterLuid();

    fprintf(stderr, "[NVENC] === OpenEncodeSessionEx ===\n");
    fprintf(stderr, "[NVENC]   sizeof(params)=%zu\n", sizeof(params));
    fprintf(stderr, "[NVENC]   version=0x%08X\n", params.version);
    fprintf(stderr, "[NVENC]   apiVersion=0x%08X\n", params.apiVersion);
    fprintf(stderr, "[NVENC]   deviceType=%d\n", (int)params.deviceType);
    fprintf(stderr, "[NVENC]   device=%p (ID3D11Device*)\n", params.device);
    fprintf(stderr, "[NVENC]   adapterVendorId=0x%04X\n", adapterVendorId);
    fprintf(stderr, "[NVENC]   adapterLuid=%08X:%08X\n", adapterLuid.HighPart, adapterLuid.LowPart);
    fprintf(stderr, "[NVENC]   Process: %s-bit\n", sizeof(void*) == 8 ? "64" : "32");

    NVENCSTATUS st = fn->nvEncOpenEncodeSessionEx(&params, &s_encoder);
    fprintf(stderr, "[NVENC]   result: %s (%u) encoder=%p\n",
            nvencStatusStr(st), st, s_encoder);

    if (st != NV_ENC_SUCCESS) {
        s_lastError = std::string("nvEncOpenEncodeSessionEx: ") + nvencStatusStr(st) +
                      " (" + std::to_string(st) + ")";
        s_encoder = nullptr;
        return false;
    }

    return true;
}

bool configure(const EncoderConfig& cfg) {
    if (!s_encoder) { s_lastError = "Session not open"; return false; }

    auto* fn = getNvencFunctions();
    s_config = cfg;
    s_initialized = false;

    // Get preset config as starting point
    NV_ENC_PRESET_CONFIG presetConfig = {};
    presetConfig.version = NV_ENC_PRESET_CONFIG_VER;
    presetConfig.presetCfg.version = NV_ENC_CONFIG_VER;

    const GUID& presetGuid = getPresetGuid(cfg.preset);

    NVENCSTATUS status = fn->nvEncGetEncodePresetConfigEx(
        s_encoder,
        NV_ENC_CODEC_H264_GUID,
        presetGuid,
        NV_ENC_TUNING_INFO_HIGH_QUALITY,
        &presetConfig
    );

    if (status != NV_ENC_SUCCESS) {
        // Fallback: try without Ex (older drivers)
        status = fn->nvEncGetEncodePresetConfig(
            s_encoder,
            NV_ENC_CODEC_H264_GUID,
            presetGuid,
            &presetConfig
        );
        if (status != NV_ENC_SUCCESS) {
            s_lastError = "nvEncGetEncodePresetConfig failed: " + std::to_string(status);
            return false;
        }
    }

    // Customize the config
    NV_ENC_CONFIG encConfig = presetConfig.presetCfg;

    // Profile: High
    encConfig.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;

    // GOP + B-frames
    encConfig.gopLength = cfg.gop;
    encConfig.frameIntervalP = cfg.bframes + 1; // IBBP = 3

    // Rate control
    encConfig.rcParams.rateControlMode = getRcMode(cfg.rc);
    encConfig.rcParams.averageBitRate = cfg.bitrate;
    encConfig.rcParams.maxBitRate = cfg.maxBitrate;
    encConfig.rcParams.vbvBufferSize = cfg.maxBitrate; // 1 second buffer
    encConfig.rcParams.vbvInitialDelay = cfg.maxBitrate; // full buffer at start

    // Spatial AQ
    encConfig.rcParams.enableAQ = 1;
    encConfig.rcParams.aqStrength = 0; // 0 = auto

    // Lookahead DISABLED — requires N+bframes+1 output buffers which complicates
    // the pipeline. Quality difference is minimal for most content.
    encConfig.rcParams.enableLookahead = 0;
    encConfig.rcParams.lookaheadDepth = 0;

    // Multi-pass (VBR HQ / CBR HQ use two-pass full resolution)
    if (cfg.rc == "vbr_hq" || cfg.rc == "cbr_hq") {
        encConfig.rcParams.multiPass = NV_ENC_TWO_PASS_FULL_RESOLUTION;
    }

    // H.264 specific
    encConfig.encodeCodecConfig.h264Config.idrPeriod = cfg.gop;
    encConfig.encodeCodecConfig.h264Config.repeatSPSPPS = 1; // SPS/PPS before each IDR
    encConfig.encodeCodecConfig.h264Config.entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CABAC;
    encConfig.encodeCodecConfig.h264Config.chromaFormatIDC = 1; // 4:2:0
    encConfig.encodeCodecConfig.h264Config.level = NV_ENC_LEVEL_AUTOSELECT;

    // Initialize encoder
    NV_ENC_INITIALIZE_PARAMS initParams = {};
    initParams.version = NV_ENC_INITIALIZE_PARAMS_VER;
    initParams.encodeGUID = NV_ENC_CODEC_H264_GUID;
    initParams.presetGUID = presetGuid;
    initParams.encodeWidth = cfg.width;
    initParams.encodeHeight = cfg.height;
    initParams.darWidth = cfg.width;
    initParams.darHeight = cfg.height;
    initParams.frameRateNum = cfg.fps;
    initParams.frameRateDen = 1;
    initParams.enablePTD = 1; // picture type decision by encoder
    initParams.encodeConfig = &encConfig;
    initParams.maxEncodeWidth = cfg.width;
    initParams.maxEncodeHeight = cfg.height;
    initParams.tuningInfo = NV_ENC_TUNING_INFO_HIGH_QUALITY;

    status = fn->nvEncInitializeEncoder(s_encoder, &initParams);
    fprintf(stderr, "[NVENC] nvEncInitializeEncoder: %s (%u)\n",
            nvencStatusStr(status), status);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncInitializeEncoder failed: " + std::to_string(status);
        return false;
    }

    // Create ring of bitstream output buffers.
    // Minimum: frameIntervalP + 1 = bframes + 2 (for B-frame reorder pipeline).
    // Add +2 safety margin.
    s_numBuffers = cfg.bframes + 4;
    if (s_numBuffers > MAX_OUTPUT_BUFFERS) s_numBuffers = MAX_OUTPUT_BUFFERS;

    fprintf(stderr, "[NVENC] Creating %d output bitstream buffers (bframes=%u)\n",
            s_numBuffers, cfg.bframes);

    for (int i = 0; i < s_numBuffers; i++) {
        NV_ENC_CREATE_BITSTREAM_BUFFER bsParams = {};
        bsParams.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;

        status = fn->nvEncCreateBitstreamBuffer(s_encoder, &bsParams);
        fprintf(stderr, "[NVENC] nvEncCreateBitstreamBuffer[%d]: %s (%u) bitstream=%p\n",
                i, nvencStatusStr(status), status, bsParams.bitstreamBuffer);
        if (status != NV_ENC_SUCCESS) {
            s_lastError = "nvEncCreateBitstreamBuffer[" + std::to_string(i) + "] failed: " + std::to_string(status);
            // Destroy any already-created buffers
            for (int j = 0; j < i; j++) {
                fn->nvEncDestroyBitstreamBuffer(s_encoder, s_bitstreamBuffers[j]);
                s_bitstreamBuffers[j] = nullptr;
            }
            s_numBuffers = 0;
            return false;
        }
        s_bitstreamBuffers[i] = bsParams.bitstreamBuffer;
    }

    s_registeredResource = nullptr;
    s_frameIndex = 0;
    s_sendIdx = 0;
    s_readIdx = 0;
    s_initialized = true;

    return true;
}

bool registerTexture(ID3D11Texture2D* texture) {
    if (!s_encoder || !s_initialized || !texture || s_numBuffers == 0) {
        s_lastError = "No encoder or texture";
        return false;
    }

    s_inputTexture = texture;
    s_registeredResource = nullptr;
    fprintf(stderr, "[NVENC] registerTexture: cached texture=%p\n", (void*)s_inputTexture);

    return true;
}

// Write a single frame's bitstream data from a lock result
static bool writeBitstream(NV_ENC_LOCK_BITSTREAM& lockParams, FILE* outFile) {
    if (lockParams.bitstreamSizeInBytes > 0 && lockParams.bitstreamBufferPtr) {
        size_t written = fwrite(lockParams.bitstreamBufferPtr, 1, lockParams.bitstreamSizeInBytes, outFile);
        if (written != lockParams.bitstreamSizeInBytes) {
            s_lastError = "fwrite failed";
            return false;
        }
    }
    return true;
}

// Drain all pending output frames from s_readIdx up to (but not including) endIdx.
// Each pending frame has its encoded data in s_bitstreamBuffers[idx % s_numBuffers].
static bool drainPending(FILE* outFile, int endIdx) {
    auto* fn = getNvencFunctions();
    while (s_readIdx < endIdx) {
        int bufIdx = s_readIdx % s_numBuffers;

        NV_ENC_LOCK_BITSTREAM lockParams = {};
        lockParams.version = NV_ENC_LOCK_BITSTREAM_VER;
        lockParams.outputBitstream = s_bitstreamBuffers[bufIdx];

        NVENCSTATUS lockStatus = fn->nvEncLockBitstream(s_encoder, &lockParams);
        fprintf(stderr, "[NVENC] nvEncLockBitstream(drain buf[%d] frame=%d): %s (%u) bytes=%u\n",
                bufIdx, s_readIdx, nvencStatusStr(lockStatus), lockStatus,
                lockParams.bitstreamSizeInBytes);

        if (lockStatus != NV_ENC_SUCCESS) {
            s_lastError = "nvEncLockBitstream(drain) failed: " + std::to_string(lockStatus);
            return false;
        }

        bool ok = writeBitstream(lockParams, outFile);
        NVENCSTATUS unlockStatus = fn->nvEncUnlockBitstream(s_encoder, s_bitstreamBuffers[bufIdx]);
        if (unlockStatus != NV_ENC_SUCCESS) {
            s_lastError = "nvEncUnlockBitstream(drain) failed: " + std::to_string(unlockStatus);
            return false;
        }
        if (!ok) return false;

        s_readIdx++;
    }
    return true;
}

bool encodeFrame(FILE* outFile) {
    const bool hasEncoder = (s_encoder != nullptr);
    const bool hasReady = s_initialized;
    const bool hasBuffers = (s_numBuffers > 0);
    const bool hasTexture = (s_inputTexture != nullptr);
    if (!hasEncoder || !hasReady || !hasBuffers || !hasTexture) {
        fprintf(stderr,
                "[NVENC] encodeFrame precheck failed: encoder=%d initialized=%d buffers=%d texture=%d\n",
                hasEncoder ? 1 : 0, hasReady ? 1 : 0, hasBuffers ? 1 : 0, hasTexture ? 1 : 0);
        s_lastError = "Encoder not fully initialized";
        return false;
    }
    auto* fn = getNvencFunctions();
    if (!fn) {
        s_lastError = "NVENC function list is null";
        return false;
    }
    if (!s_registeredResource) {
        NV_ENC_REGISTER_RESOURCE regParams = {};
        regParams.version = NV_ENC_REGISTER_RESOURCE_VER;
        regParams.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
        regParams.resourceToRegister = s_inputTexture;
        regParams.width = s_config.width;
        regParams.height = s_config.height;
        regParams.pitch = 0;
        regParams.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;
        regParams.bufferUsage = NV_ENC_INPUT_IMAGE;
        NVENCSTATUS regStatus = fn->nvEncRegisterResource(s_encoder, &regParams);
        fprintf(stderr, "[NVENC] nvEncRegisterResource: %s (%u) resource=%p\n",
                nvencStatusStr(regStatus), regStatus, regParams.registeredResource);
        if (regStatus != NV_ENC_SUCCESS) {
            s_lastError = "nvEncRegisterResource failed: " + std::to_string(regStatus);
            return false;
        }
        s_registeredResource = regParams.registeredResource;
    }
    NV_ENC_MAP_INPUT_RESOURCE mapParams = {};
    mapParams.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapParams.registeredResource = s_registeredResource;
    NVENCSTATUS status = fn->nvEncMapInputResource(s_encoder, &mapParams);
    fprintf(stderr, "[NVENC] nvEncMapInputResource: %s (%u) mapped=%p\n",
            nvencStatusStr(status), status, mapParams.mappedResource);
    if (status != NV_ENC_SUCCESS) {
        s_lastError = "nvEncMapInputResource failed: " + std::to_string(status);
        return false;
    }

    // Pick the next output buffer in the ring
    int bufIdx = s_sendIdx % s_numBuffers;

    NV_ENC_PIC_PARAMS picParams = {};
    picParams.version = NV_ENC_PIC_PARAMS_VER;
    picParams.inputWidth = s_config.width;
    picParams.inputHeight = s_config.height;
    picParams.inputPitch = 0;
    picParams.encodePicFlags = 0;
    if (s_frameIndex == 0) {
        picParams.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }
    picParams.inputBuffer = mapParams.mappedResource;
    picParams.outputBitstream = s_bitstreamBuffers[bufIdx];
    picParams.bufferFmt = mapParams.mappedBufferFmt;
    picParams.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    picParams.pictureType = NV_ENC_PIC_TYPE_UNKNOWN;
    status = fn->nvEncEncodePicture(s_encoder, &picParams);
    fprintf(stderr, "[NVENC] nvEncEncodePicture(frame=%llu buf[%d]): %s (%u) flags=0x%08X\n",
            (unsigned long long)s_frameIndex, bufIdx, nvencStatusStr(status), status, picParams.encodePicFlags);
    fn->nvEncUnmapInputResource(s_encoder, mapParams.mappedResource);

    s_sendIdx++;
    s_frameIndex++;

    if (status == NV_ENC_SUCCESS) {
        // Output is ready for one or more pending frames — drain them all
        return drainPending(outFile, s_sendIdx);
    } else if (status == NV_ENC_ERR_NEED_MORE_INPUT) {
        // Frame queued internally for B-frame reordering, no output yet
        return true;
    } else {
        s_lastError = "nvEncEncodePicture failed: " + std::to_string(status);
        return false;
    }
}

bool flush(FILE* outFile) {
    fprintf(stderr, "[NVENC] flush() ENTER enc=%p numBuffers=%d sendIdx=%d readIdx=%d frameIndex=%u\n",
            s_encoder, s_numBuffers, s_sendIdx, s_readIdx, (unsigned)s_frameIndex);

    if (!s_encoder) return true;

    auto* fn = getNvencFunctions();
    if (!fn) {
        s_lastError = "NVENC function list is null";
        return false;
    }
    if (s_numBuffers == 0) {
        s_lastError = "No bitstream buffers for flush";
        return false;
    }

    // Send EOS signal — no output buffer needed, this just tells NVENC
    // to finish encoding all buffered frames.
    NV_ENC_PIC_PARAMS eosParams = {};
    eosParams.version = NV_ENC_PIC_PARAMS_VER;
    eosParams.encodePicFlags = NV_ENC_PIC_FLAG_EOS;

    NVENCSTATUS encodeStatus = fn->nvEncEncodePicture(s_encoder, &eosParams);
    fprintf(stderr, "[NVENC] nvEncEncodePicture(EOS): %s (%u)\n",
            nvencStatusStr(encodeStatus), encodeStatus);
    if (encodeStatus != NV_ENC_SUCCESS && encodeStatus != NV_ENC_ERR_NEED_MORE_INPUT) {
        s_lastError = "nvEncEncodePicture(EOS) failed: " + std::to_string(encodeStatus);
        return false;
    }

    // After EOS, all pending frames (s_readIdx..s_sendIdx) have their encoded
    // data ready in their respective bitstream buffers. Drain them all.
    fprintf(stderr, "[NVENC] flush: draining %d pending frames\n", s_sendIdx - s_readIdx);
    return drainPending(outFile, s_sendIdx);
}

void closeSession() {
    if (!s_encoder) {
        s_inputTexture = nullptr;
        for (int i = 0; i < MAX_OUTPUT_BUFFERS; i++) s_bitstreamBuffers[i] = nullptr;
        s_numBuffers = 0;
        s_sendIdx = 0;
        s_readIdx = 0;
        s_registeredResource = nullptr;
        s_initialized = false;
        s_frameIndex = 0;
        return;
    }

    auto* fn = getNvencFunctions();
    if (!fn) {
        s_encoder = nullptr;
        s_inputTexture = nullptr;
        for (int i = 0; i < MAX_OUTPUT_BUFFERS; i++) s_bitstreamBuffers[i] = nullptr;
        s_numBuffers = 0;
        s_sendIdx = 0;
        s_readIdx = 0;
        s_registeredResource = nullptr;
        s_initialized = false;
        s_frameIndex = 0;
        return;
    }

    // Unregister resource
    if (s_registeredResource) {
        fn->nvEncUnregisterResource(s_encoder, s_registeredResource);
        s_registeredResource = nullptr;
    }

    // Destroy all bitstream buffers
    for (int i = 0; i < s_numBuffers; i++) {
        if (s_bitstreamBuffers[i]) {
            fn->nvEncDestroyBitstreamBuffer(s_encoder, s_bitstreamBuffers[i]);
            s_bitstreamBuffers[i] = nullptr;
        }
    }
    s_numBuffers = 0;
    s_sendIdx = 0;
    s_readIdx = 0;

    // Destroy encoder
    fn->nvEncDestroyEncoder(s_encoder);
    s_encoder = nullptr;
    s_inputTexture = nullptr;
    s_initialized = false;
    s_frameIndex = 0;
}

bool isSessionOpen() {
    return s_encoder != nullptr;
}

std::string getLastError() {
    return s_lastError;
}

} // namespace nativeexporter
