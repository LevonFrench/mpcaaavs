#define NOMINMAX
#include <Windows.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include "../src/DSUtil/AAAVSAudio.h"
#include <cassert>
#include <iostream>
#include <memory>
int main() {
    auto storage = std::make_unique<AAAVS::AudioTap>();
    auto& tap = *storage;
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
    assert(frame.samples == 3 && frame.sampleRate == 48000);
    format.nChannels = 2; format.nBlockAlign = 8; format.wBitsPerSample = 32; format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    float fp[] = {NAN, INFINITY, 2, -2};
    tap.Reset(); tap.Push(reinterpret_cast<BYTE*>(fp), sizeof(fp), &format, 0); frame = tap.Read(0);
    assert(frame.pcm[0] == 0 && frame.pcm[576] == 0 && frame.pcm[1] == 1 && frame.pcm[577] == -1);
    // 5 ms transient between 33 ms UI polls remains in the ordered batch.
    tap.Reset(); format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 1;
    format.nBlockAlign = 2; format.wBitsPerSample = 16;
    std::array<short, 576 * 6> pulses{};
    for (size_t i = 864; i < 1104; ++i) pulses[i] = 16384;
    tap.Push(reinterpret_cast<BYTE*>(pulses.data()), sizeof(pulses), &format, 0);
    auto first = tap.ReadBatch(0, 0); assert(first.count == 1);
    auto batch = tap.ReadBatch(330000, first.frames[0].sequence);
    assert(batch.count == 2 && !batch.discontinuity);
    assert(batch.frames[0].time == 120000 && batch.frames[1].time == 240000);
    assert(batch.frames[0].pcm[288] == .5f);
    auto last = batch.frames[1].sequence;
    assert(tap.ReadBatch(330000, last).count == 0);
    assert(tap.Read(-1).sequence == 0); // Never use future PCM.
    assert(tap.ReadBatch(4000000, last).count == 0); // Expired windows.
    tap.Reset();
    for (int i = 0; i < 140; ++i) tap.Push(reinterpret_cast<BYTE*>(pulses.data()), 1152, &format, i * 120000LL);
    batch = tap.ReadBatch(139 * 120000LL, last);
    assert(batch.count > 0 && batch.discontinuity);
    for (size_t i = 1; i < batch.count; ++i) assert(batch.frames[i].sequence == batch.frames[i-1].sequence + 1);
    // High-rate input must fit ordinary 33 ms bridge polling without false discontinuities.
    for (unsigned rate : {44100u, 48000u, 96000u, 192000u, 384000u}) {
        tap.Reset(); format.nSamplesPerSec = rate;
        const size_t windows = (rate * 33 / 1000 + 575) / 576;
        for (size_t i = 0; i < windows; ++i) tap.Push(reinterpret_cast<BYTE*>(pulses.data()), 1152, &format, i * 576LL * 10000000 / rate);
        auto high = tap.ReadBatch(330000, 0);
        assert(high.count == windows && !high.discontinuity && high.sample.sampleRate == rate);
    }
    std::cout << "AAAVS PCM: stereo planar layout, mono, float sanitation, stale silence, seek reset, timestamped short-transient batches, deduplication, overflow PASS\n";
}
