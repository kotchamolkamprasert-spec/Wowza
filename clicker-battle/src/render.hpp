#pragma once

#include "game.hpp"

namespace render {
void begin();                  // hide cursor, clear screen
void end();                    // restore cursor
void draw(const Game& game);
}  // namespace render
