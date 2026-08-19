#include "keyboard_input.hpp"

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

namespace {
termios g_orig{};
bool    g_raw = false;
}  // namespace

void keyboard::begin(BlockingQueue<InputEvent>& q) {
    if (isatty(STDIN_FILENO)) {
        tcgetattr(STDIN_FILENO, &g_orig);
        termios raw = g_orig;
        // ICANON off: deliver keys immediately instead of buffering to Enter.
        // ECHO off: don't print the keys over the scoreboard.
        raw.c_lflag &= ~(unsigned long)(ICANON | ECHO);
        raw.c_cc[VMIN]  = 0;
        raw.c_cc[VTIME] = 0;
        tcsetattr(STDIN_FILENO, TCSANOW, &raw);
        g_raw = true;
    }
    // Non-blocking so poll() never stalls a frame waiting for a keypress.
    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);

    q.push(InputEvent{0, InputEvent::Type::Connected, 0, Clock::now()});
    q.push(InputEvent{1, InputEvent::Type::Connected, 0, Clock::now()});
}

void keyboard::end() {
    if (g_raw) tcsetattr(STDIN_FILENO, TCSANOW, &g_orig);
}

bool keyboard::poll(BlockingQueue<InputEvent>& q) {
    static unsigned long seq[kNumPlayers] = {0, 0};

    char    buf[64];
    ssize_t n;
    while ((n = read(STDIN_FILENO, buf, sizeof(buf))) > 0) {
        for (ssize_t i = 0; i < n; i++) {
            const char c = buf[i];
            if (c == 'q' || c == 'Q' || c == 3) return false;

            int p = -1;
            if (c == 'a' || c == 'A') p = 0;
            if (c == 'l' || c == 'L') p = 1;
            if (p < 0) continue;

            // A key has no separate up-event here, so synthesise both edges.
            const auto now = Clock::now();
            q.push(InputEvent{p, InputEvent::Type::Press, ++seq[p], now});
            q.push(InputEvent{p, InputEvent::Type::Release, 0, now});
        }
    }
    return true;
}
