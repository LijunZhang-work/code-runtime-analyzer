#pragma once

#include "tile.hpp"

#include <cstddef>
#include <tuple>
#include <vector>

namespace Game {

struct GameBoard {
  using tile_data_array_t = std::vector<tile_t>;
  using gameboard_data_array_t = std::tuple<std::size_t, tile_data_array_t>;

  gameboard_data_array_t gbda;
  bool moved{true};
  unsigned long long score{};
  unsigned long long largestTile{2};
  long long moveCount{-1};
};

}  // namespace Game
