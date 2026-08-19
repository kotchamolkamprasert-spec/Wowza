#pragma once

#include "event.hpp"
#include "queue.hpp"

// Stand-in for the ESP32s so the game is playable without hardware.
// 'a' = player 1, 'l' = player 2, 'q' = quit.
namespace keyboard {
void begin(BlockingQueue<InputEvent>& q);
void end();
bool poll(BlockingQueue<InputEvent>& q);   // false == user asked to quit
}  // namespace keyboard
