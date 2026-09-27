#define NOMINMAX
#include <Windows.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include "../src/DSUtil/AAAVSAudio.h"
#include <cassert>
#include <iostream>
int main() {
    AAAVS::AudioTap tap;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2;
    format.nSamplesPerSec = 48000; format.wBitsPerSample = 16; format.nBlockAlign = 4;
    std::array<short, 1152> data{};
    for (size_t i = 0; i < 576; ++i) { data[i*2] = 16384; data[i*2+1] = -8192; }
    tap.Push(reinterpret_cast<BYTE*>(data.data()), sizeof(data), &format, 10000000);
    auto frame = tap.Read(10000000);
    assert(frame.pcm[0] == .5f && frame.pcm[575] == .5f);
    assert(frame.pcm[576] == -.25f && frame.pcm[1151] == -.25f);
    assert(tap.Read(20000000).pcm[0] == 0);
    tap.Reset(); assert(tap.Read(10000000).pcm[0] == 0);
    assert(tap.Read(10000000).epoch == 1);
    format.nChannels = 1; format.nBlockAlign = 1; format.wBitsPerSample = 8;
    BYTE mono[] = {0, 128, 255};
    tap.Push(mono, 3, &format, 0); frame = tap.Read(0);
    assert(frame.pcm[0] == -1 && frame.pcm[576] == -1);
    assert(frame.pcm[1] == 0 && frame.pcm[2] == 127/128.0f);
    format.nChannels = 2; format.nBlockAlign = 8; format.wBitsPerSample = 32; format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    float fp[] = {NAN, INFINITY, 2, -2};
    tap.Reset(); tap.Push(reinterpret_cast<BYTE*>(fp), sizeof(fp), &format, 0); frame = tap.Read(0);
    assert(frame.pcm[0] == 0 && frame.pcm[576] == 0 && frame.pcm[1] == 1 && frame.pcm[577] == -1);
    std::cout << "AAAVS PCM: stereo planar layout, mono, float sanitation, stale silence, seek reset PASS\n";
}
