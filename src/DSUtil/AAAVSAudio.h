// MPC-AAAVS: bounded, process-local PCM tap. Never blocks the audio thread.
#pragma once
#include <array>
#include <mutex>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <cstdlib>

namespace AAAVS {
constexpr size_t Samples = 576;
struct AudioFrame {
    std::array<float, Samples * 2> pcm{};
    long long time = 0;
    unsigned epoch = 0;
};
class AudioTap {
    std::mutex mutex;
    std::array<AudioFrame, 128> frames{};
    size_t next = 0, count = 0;
    unsigned epoch = 0;
public:
    void Reset() {
        std::lock_guard<std::mutex> lock(mutex);
        count = next = 0;
        ++epoch;
    }
    void Push(const BYTE* bytes, size_t length, const WAVEFORMATEX* format, long long time) {
        if (!bytes || !format || !format->nBlockAlign || !format->nChannels || !format->nSamplesPerSec) return;
        bool fp = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        bool pcm = format->wFormatTag == WAVE_FORMAT_PCM;
        if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && format->cbSize >= 22) {
            const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
            fp = ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            pcm = ext->SubFormat == KSDATAFORMAT_SUBTYPE_PCM;
        }
        const unsigned bits = format->wBitsPerSample, stride = bits / 8;
        if (!(fp && (bits == 32 || bits == 64)) && !(pcm && (bits == 8 || bits == 16 || bits == 24 || bits == 32))) return;
        if (format->nBlockAlign < stride * format->nChannels) return;
        std::unique_lock<std::mutex> lock(mutex, std::try_to_lock);
        if (!lock.owns_lock()) return;
        const size_t total = length / format->nBlockAlign;
        // Fixed 576-source-sample windows, timestamped in media time.
        for (size_t offset = 0; offset < total; offset += Samples) {
            AudioFrame& frame = frames[next];
            frame = {};
            frame.epoch = epoch;
            frame.time = time + static_cast<long long>(offset) * 10000000 / format->nSamplesPerSec;
            for (size_t i = 0; i < Samples && offset + i < total; ++i) {
                for (size_t ch = 0; ch < 2; ++ch) {
                    const BYTE* p = bytes + (offset + i) * format->nBlockAlign + (format->nChannels == 1 ? 0 : ch) * stride;
                    double value = 0;
                    if (fp && bits == 32) { float v; memcpy(&v, p, 4); value = v; }
                    else if (fp) { double v; memcpy(&v, p, 8); value = v; }
                    else if (bits == 8) value = (int(*p) - 128) / 128.0;
                    else if (bits == 16) { short v; memcpy(&v, p, 2); value = v / 32768.0; }
                    else if (bits == 24) { int v = p[0] | (p[1] << 8) | (p[2] << 16); if (v & 0x800000) v -= 0x1000000; value = v / 8388608.0; }
                    else { int v; memcpy(&v, p, 4); value = v / 2147483648.0; }
                    frame.pcm[ch * Samples + i] = std::isfinite(value) ? static_cast<float>((std::max)(-1.0, (std::min)(1.0, value))) : 0;
                }
            }
            next = (next + 1) % frames.size();
            count = (std::min)(count + 1, frames.size());
        }
    }
    AudioFrame Read(long long position) {
        std::lock_guard<std::mutex> lock(mutex);
        AudioFrame result{};
        result.epoch = epoch;
        long long best = 2500000; // Never reuse PCM more than 250 ms away.
        for (size_t i = 0; i < count; ++i) {
            const auto& frame = frames[(next + frames.size() - 1 - i) % frames.size()];
            const auto distance = std::llabs(frame.time - position);
            if (distance < best) { best = distance; result = frame; }
        }
        return result;
    }
};
inline AudioTap& Tap() { static AudioTap tap; return tap; }
}
