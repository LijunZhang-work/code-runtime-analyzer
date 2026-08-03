cmake_minimum_required(VERSION 3.20)
project(code_structure_workbench_demo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(code_structure_workbench_demo STATIC
  src/energy_dispatch_demo.cpp
)
