#pragma once

#include <chrono>

using Clock     = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

inline constexpr int kNumPlayers = 2;

// A single thing that happened on one of the ESP32s.
// Timestamped at arrival, not at processing, so a slow frame
// never makes an old click look recent.
struct InputEvent {
    enum class Type { Press, Release, Connected, Disconnected };

    int           player = 0;                 // 0 or 1
    Type          type   = Type::Press;
    unsigned long seq    = 0;                 // firmware press counter; gaps == dropped packets
    TimePoint     at{};
};
