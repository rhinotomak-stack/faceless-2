#pragma once

#include "nvEncodeAPI.h"

namespace nativeexporter {

bool loadNvenc();
NV_ENCODE_API_FUNCTION_LIST* getNvencFunctions();
uint32_t getNvencMaxSupportedApiVersion();
void unloadNvenc();
bool isNvencLoaded();

} // namespace nativeexporter
