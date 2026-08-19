#include <atomic>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>

#include "event.hpp"
#include "game.hpp"
#include "queue.hpp"
#include "render.hpp"

#ifdef CLICKER_NO_BLE
  #include "keyboard_input.hpp"
#else
  #include "ble_hub.hpp"
#endif

namespace {
std::atomic<bool> g_running{true};

// Fixed simulation step. Input is drained every frame regardless, so a click
// is never delayed by more than one frame even though physics ticks at 60Hz.
constexpr double kTick = 1.0 / 60.0;
}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGINT,  [](int) { g_running = false; });
    std::signal(SIGTERM, [](int) { g_running = false; });

    BlockingQueue<InputEvent> queue;
    Game                      game;

#ifdef CLICKER_NO_BLE
    (void)argc; (void)argv;
    keyboard::begin(queue);
#else
    const std::string p1Name = (argc > 1) ? argv[1] : "ESP32-P1";
    const std::string p2Name = (argc > 2) ? argv[2] : "ESP32-P2";

    BleHub hub(queue);
    hub.addPlayer(0, p1Name);
    hub.addPlayer(1, p2Name);

    std::cout << "connecting to " << p1Name << " and " << p2Name << "...\n";
    if (!hub.start()) return 1;
#endif

    render::begin();

    auto   prev        = Clock::now();
    double accumulator = 0.0;

    while (g_running) {
        const auto now   = Clock::now();
        double     frame = std::chrono::duration<double>(now - prev).count();
        prev = now;

        // Clamp: after a stall (breakpoint, laptop sleep) a huge dt would run
        // hundreds of catch-up ticks and burn the whole round in one frame.
        if (frame > 0.25) frame = 0.25;
        accumulator += frame;

#ifdef CLICKER_NO_BLE
        if (!keyboard::poll(queue)) g_running = false;
#endif

        // Drain everything queued since the last frame -- while, not if.
        InputEvent e;
        while (queue.try_pop(e)) game.onEvent(e);

        while (accumulator >= kTick) {
            game.update(kTick, now);
            accumulator -= kTick;
        }

        render::draw(game);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }

    render::end();
#ifdef CLICKER_NO_BLE
    keyboard::end();
#else
    hub.stop();
#endif
    queue.close();

    std::cout << "final  " << game.player(0).name << " " << game.player(0).score
              << "   |   " << game.player(1).name << " " << game.player(1).score << "\n";
    return 0;
}
