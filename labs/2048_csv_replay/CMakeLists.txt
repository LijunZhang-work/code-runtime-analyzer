cmake_minimum_required(VERSION 3.20)

# Must be set before project() so CMake produces compile_commands.json for
# the VS Code diagnostic extension.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(2048_csv_replay LANGUAGES CXX)

add_executable(2048_csv_replay
  src/replay_scenario.cpp
)

target_include_directories(2048_csv_replay PRIVATE
  "${CMAKE_CURRENT_LIST_DIR}/include"
)
target_compile_features(2048_csv_replay PRIVATE cxx_std_17)

# The bundled llvm-mingw compiler links a few runtime DLLs dynamically. Keep
# them beside the executable so the deterministic CSV generator runs directly.
if(WIN32)
  get_filename_component(LLVM_MINGW_BIN "${CMAKE_CXX_COMPILER}" DIRECTORY)
  foreach(RUNTIME_DLL libc++.dll libunwind.dll libwinpthread-1.dll)
    if(EXISTS "${LLVM_MINGW_BIN}/${RUNTIME_DLL}")
      add_custom_command(TARGET 2048_csv_replay POST_BUILD
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
          "${LLVM_MINGW_BIN}/${RUNTIME_DLL}"
          "$<TARGET_FILE_DIR:2048_csv_replay>"
      )
    endif()
  endforeach()
endif()
