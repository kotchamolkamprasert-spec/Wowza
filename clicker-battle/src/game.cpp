#include "game.hpp"

#include <algorithm>
#include <cmath>

Game::Game() {
    players_[0].name = "PLAYER 1";
    players_[1].name = "PLAYER 2";
}

bool Game::allConnected() const {
    for (const auto& p : players_)
        if (!p.connected) return false;
    return true;
}

int Game::winner() const {
    if (players_[0].score > players_[1].score) return 0;
    if (players_[1].score > players_[0].score) return 1;
    return -1;
}

void Game::startRound() {
    for (auto& p : players_) {
        p.score      = 0;
        p.clicks     = 0;
        p.combo      = 0;
        p.bestCombo  = 0;
        p.cps        = 0.0;
        p.multiplier = 1.0;
        p.dropped    = 0;
        p.hasClicked = false;
        p.window.clear();
    }
    phase_     = Phase::Playing;
    phaseTime_ = kRoundSeconds;
}

void Game::onEvent(const InputEvent& e) {
    if (e.player < 0 || e.player >= kNumPlayers) return;
    PlayerState& p = players_[e.player];

    switch (e.type) {
        case InputEvent::Type::Connected:
            p.connected = true;
            return;

        case InputEvent::Type::Disconnected:
            p.connected = false;
            p.combo     = 0;
            return;

        case InputEvent::Type::Release:
            return;   // clicker only scores on the down edge

        case InputEvent::Type::Press:
            break;
    }

    // Notifications are unacknowledged, so they can be lost. The firmware's
    // counter is the only way to notice.
    if (p.nextSeq != 0 && e.seq > p.nextSeq) p.dropped += (long)(e.seq - p.nextSeq);
    if (e.seq != 0) p.nextSeq = e.seq + 1;

    switch (phase_) {
        case Phase::Lobby:
            // Any press starts a round. Controllers are optional: the keyboard
            // always works, so gating on allConnected() made the game
            // unplayable whenever a board was missing or misbehaving. The
            // connection dots still report real BLE state.
            phase_     = Phase::Countdown;
            phaseTime_ = kCountdownSecs;
            break;

        case Phase::Countdown:
            break;   // early clicks are ignored, not penalised

        case Phase::Playing:
            registerClick(e.player, e.at);
            break;

        case Phase::Results:
            phase_     = Phase::Lobby;
            phaseTime_ = 0.0;
            break;
    }
}

void Game::registerClick(int idx, TimePoint now) {
    PlayerState& p = players_[idx];

    const double since = p.hasClicked
        ? std::chrono::duration<double>(now - p.lastClick).count()
        : 1e9;

    p.combo      = (since <= kComboWindow) ? p.combo + 1 : 1;
    p.bestCombo  = std::max(p.bestCombo, p.combo);
    p.multiplier = std::min(kMaxMultiplier, 1.0 + p.combo * kMultPerCombo);

    p.score += std::llround(kBasePoints * p.multiplier);
    p.clicks += 1;

    p.lastClick  = now;
    p.hasClicked = true;
    p.flash      = 1.0;
    p.window.push_back(now);
}

void Game::update(double dt, TimePoint now) {
    for (auto& p : players_) {
        // Sliding window: drop click times older than kCpsWindow, then the
        // count IS the rate, because the window is exactly one second wide.
        while (!p.window.empty() &&
               std::chrono::duration<double>(now - p.window.front()).count() > kCpsWindow) {
            p.window.pop_front();
        }
        p.cps = p.window.size() / kCpsWindow;

        if (p.hasClicked &&
            std::chrono::duration<double>(now - p.lastClick).count() > kComboWindow) {
            p.combo      = 0;
            p.multiplier = 1.0;
        }

        p.flash = std::max(0.0, p.flash - dt * 4.0);
    }

    switch (phase_) {
        case Phase::Lobby:
            break;

        case Phase::Countdown:
            phaseTime_ -= dt;
            if (phaseTime_ <= 0.0) startRound();
            break;

        case Phase::Playing:
            phaseTime_ -= dt;
            if (phaseTime_ <= 0.0) {
                phaseTime_ = 0.0;
                phase_     = Phase::Results;
            }
            break;

        case Phase::Results:
            break;
    }
}
