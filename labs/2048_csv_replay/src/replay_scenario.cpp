// Small deterministic diagnostic demo. The types are intentionally local to
// this lab so a fresh clone does not depend on a downloaded third-party tree.

#include "gameboard.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <tuple>
#include <vector>

namespace {

using Game::GameBoard;
using Game::tile_t;

void set_board(GameBoard& board, const std::vector<unsigned long long>& values) {
  auto& tiles = std::get<1>(board.gbda);
  for (size_t index = 0; index < tiles.size(); ++index) {
    tiles[index].value = values.at(index);
    tiles[index].blocked = false;
  }
}

void write_header(std::ofstream& output, const GameBoard& board) {
  output << "timestamp,move_index,direction,score,largest_tile,moved";
  const auto& tiles = std::get<1>(board.gbda);
  for (size_t index = 0; index < tiles.size(); ++index) {
    output << ",TILE_" << index << "_VALUE,TILE_" << index << "_BLOCKED";
  }
  output << '\n';
  output.flush();
}

void write_snapshot(std::ofstream& output, const GameBoard& board, int move_index,
                    char direction, std::chrono::system_clock::time_point time) {
  const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
      time.time_since_epoch()).count();
  output << milliseconds << ',' << move_index << ',' << direction << ',' << board.score
         << ',' << board.largestTile << ',' << board.moved;

  const auto& tiles = std::get<1>(board.gbda);
  for (size_t index = 0; index < tiles.size(); ++index) {
    // These accesses are the first diagnostic target: tiles[index].value and
    // tiles[index].blocked map to TILE_<index>_VALUE/BLOCKED in the CSV.
    output << ',' << tiles[index].value << ',' << tiles[index].blocked;
  }
  output << '\n';
}

void apply_move(GameBoard& board, char direction) {
  if (direction != 'L') return;

  constexpr size_t board_size = 4;
  auto& tiles = std::get<1>(board.gbda);
  board.moved = false;
  for (size_t row = 0; row < board_size; ++row) {
    for (size_t column = 1; column < board_size; ++column) {
      const size_t current_index = row * board_size + column;
      const size_t target_index = current_index - 1;
      tile_t& current = tiles[current_index];
      tile_t& target = tiles[target_index];

      if (current.value != 0 && current.value == target.value &&
          !current.blocked && !target.blocked) {
        target.value *= 2;
        target.blocked = true;
        current.value = 0;
        board.score += target.value;
        if (target.value > board.largestTile) board.largestTile = target.value;
        board.moved = true;
      }
    }
  }
  board.moveCount += 1;
}

}  // namespace

int main(int argc, char* argv[]) {
  const std::string output_path = argc > 1 ? argv[1] : "2048_replay.csv";
  std::ofstream output(output_path, std::ios::trunc);
  if (!output) {
    std::cerr << "Cannot write CSV: " << output_path << '\n';
    return EXIT_FAILURE;
  }

  GameBoard board;
  board.gbda = {4, std::vector<tile_t>(16)};
  const auto start = std::chrono::system_clock::time_point{std::chrono::milliseconds{1785484800000}};
  write_header(output, board);

  // Four controlled board states, each captured before and after a left move,
  // provide eight visibly different time points for replay diagnostics.
  const std::vector<std::vector<unsigned long long>> scenarios{
    {2, 2, 0, 0, 4, 4, 0, 0, 8, 8, 0, 0, 0, 0, 0, 0},
    {4, 4, 8, 8, 16, 0, 16, 0, 2, 2, 4, 4, 0, 0, 0, 0},
    {2, 2, 2, 2, 32, 32, 0, 0, 64, 0, 64, 0, 4, 4, 8, 8},
    {1024, 1024, 2, 2, 128, 128, 256, 256, 16, 16, 32, 32, 4, 0, 4, 0},
  };
  size_t snapshot_index = 0;
  for (size_t scenario_index = 0; scenario_index < scenarios.size(); ++scenario_index) {
    set_board(board, scenarios[scenario_index]);
    board.score = static_cast<unsigned int>(scenario_index * 100);
    board.largestTile = *std::max_element(scenarios[scenario_index].begin(), scenarios[scenario_index].end());
    board.moved = false;
    write_snapshot(output, board, static_cast<int>(snapshot_index), 'S',
                   start + std::chrono::seconds{static_cast<long long>(snapshot_index)});
    snapshot_index += 1;

    apply_move(board, 'L');
    write_snapshot(output, board, static_cast<int>(snapshot_index), 'L',
                   start + std::chrono::seconds{static_cast<long long>(snapshot_index)});
    snapshot_index += 1;
  }

  std::cout << "Wrote deterministic replay CSV: " << output_path << '\n';
  return EXIT_SUCCESS;
}
