#include "render.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

namespace {

constexpr int kBarWidth = 34;

const char* kReset  = "\033[0m";
const char* kDim    = "\033[2m";
const char* kBold   = "\033[1m";
const char* kP1     = "\033[38;5;51m";    // cyan
const char* kP2     = "\033[38;5;213m";   // magenta
const char* kGold   = "\033[38;5;220m";
const char* kRed    = "\033[38;5;203m";

std::string commas(long v) {
    std::string s = std::to_string(v);
    for (int i = (int)s.size() - 3; i > 0; i -= 3) s.insert(i, ",");
    return s;
}

std::string bar(long value, long peak, int width) {
    if (peak <= 0) peak = 1;
    int filled = (int)((double)value / (double)peak * width);
    filled = std::clamp(filled, 0, width);

    std::string s;
    for (int i = 0; i < filled; i++) s += "█";
    for (int i = filled; i < width; i++) s += "░";
    return s;
}

std::string fixed(double v, int places) {
    std::ostringstream os;
    os << std::fixed << std::setprecision(places) << v;
    return os.str();
}

// "\033[K" clears to end of line. Overwriting in place instead of clearing the
// whole screen every frame is what stops the display from flickering.
void line(const std::string& s = "") {
    std::cout << s << "\033[K\n";
}

void drawPlayer(const Game& g, int idx, long peak) {
    const PlayerState& p     = g.player(idx);
    const char*        color = (idx == 0) ? kP1 : kP2;

    std::string dot = p.connected ? "\033[38;5;46m●\033[0m"
                                  : "\033[38;5;240m○\033[0m";

    std::string nameCell = p.name;
    nameCell.resize(9, ' ');

    // The flash makes the bar bold for a few frames after each click, so you
    // can see input landing even when the score barely moves.
    const char* emphasis = (p.flash > 0.15) ? kBold : "";

    std::ostringstream row;
    row << "  " << dot << " " << color << nameCell << kReset
        << emphasis << color << bar(p.score, peak, kBarWidth) << kReset
        << "  " << kBold << std::setw(8) << commas(p.score) << kReset;
    line(row.str());

    std::ostringstream stats;
    stats << "     " << kDim << "        "
          << std::setw(4) << p.clicks << " clicks   "
          << std::setw(5) << fixed(p.cps, 1) << " cps   "
          << "x" << fixed(p.multiplier, 2);
    if (p.combo >= 5) stats << "   combo " << p.combo;
    if (p.dropped > 0) stats << kRed << "   " << p.dropped << " dropped" << kDim;
    if (!p.connected)  stats << kRed << "   disconnected" << kDim;
    stats << kReset;
    line(stats.str());
}

std::string statusLine(const Game& g) {
    switch (g.phase()) {
        case Phase::Lobby:
            return g.allConnected()
                ? std::string(kGold) + "  both connected — press any button to start" + kReset
                : std::string(kDim)  + "  waiting for controllers..." + kReset;

        case Phase::Countdown: {
            int n = (int)std::ceil(g.phaseRemaining());
            return std::string(kGold) + kBold + "  get ready... " + std::to_string(n) + kReset;
        }

        case Phase::Playing:
            return std::string(kBold) + "  CLICK!" + kReset + kDim +
                   "                              " + fixed(g.phaseRemaining(), 1) + "s left" + kReset;

        case Phase::Results: {
            int w = g.winner();
            std::string s = std::string(kGold) + kBold + "  ";
            s += (w < 0) ? "DRAW!" : g.player(w).name + " WINS!";
            s += kReset;
            s += std::string(kDim) + "   press any button for a rematch" + kReset;
            return s;
        }
    }
    return "";
}

}  // namespace

void render::begin() {
    std::cout << "\033[?25l" << "\033[2J";   // hide cursor, clear screen
}

void render::end() {
    std::cout << "\033[?25h" << "\n";        // show cursor
    std::cout.flush();
}

void render::draw(const Game& g) {
    long peak = std::max({g.player(0).score, g.player(1).score, 1L});

    std::cout << "\033[H";   // cursor home; every line then overwrites in place

    line();
    line(std::string(kBold) + "   C L I C K   B A T T L E" + kReset);
    line(std::string(kDim)  + "   ─────────────────────────────────────────────────────" + kReset);
    line();
    drawPlayer(g, 0, peak);
    line();
    drawPlayer(g, 1, peak);
    line();
    line(statusLine(g));
    line();
    line(std::string(kDim) + "   ctrl-c to quit" + kReset);

    std::cout.flush();
}
