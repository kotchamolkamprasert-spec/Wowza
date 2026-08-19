#pragma once

#include <deque>
#include <string>

#include "event.hpp"

// Tunables — all the game feel lives here.
inline constexpr double kRoundSeconds   = 30.0;
inline constexpr double kCountdownSecs  = 3.0;
inline constexpr double kComboWindow    = 0.45;   // s between clicks to keep a combo alive
inline constexpr double kCpsWindow      = 1.0;    // s of history used for the clicks/sec readout
inline constexpr double kMaxMultiplier  = 3.0;
inline constexpr double kMultPerCombo   = 0.05;   // combo 40 -> 3.0x
inline constexpr long   kBasePoints     = 10;

enum class Phase { Lobby, Countdown, Playing, Results };

struct PlayerState {
    std::string name;
    bool   connected  = false;
    long   score      = 0;
    int    clicks     = 0;
    int    combo      = 0;
    int    bestCombo  = 0;
    double cps        = 0.0;
    double multiplier = 1.0;
    double flash      = 0.0;   // 1.0 on click, decays — pure visual feedback
    long   dropped    = 0;     // gaps in the firmware sequence number

    std::deque<TimePoint> window;      // click times inside kCpsWindow
    TimePoint             lastClick{};
    bool                  hasClicked = false;
    unsigned long         nextSeq    = 0;
};

class Game {
public:
    Game();

    void onEvent(const InputEvent& e);
    void update(double dt, TimePoint now);

    Phase  phase()          const { return phase_; }
    double phaseRemaining() const { return phaseTime_; }
    bool   allConnected()   const;
    int    winner()         const;   // player index, or -1 for a tie

    const PlayerState& player(int i) const { return players_[i]; }

private:
    void registerClick(int p, TimePoint now);
    void startRound();

    Phase       phase_     = Phase::Lobby;
    double      phaseTime_ = 0.0;
    PlayerState players_[kNumPlayers];
};
