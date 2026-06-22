cmake_minimum_required(VERSION 3.16)
project(tcmt-server VERSION 0.1.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# nlohmann/json from TCMT submodule
include_directories(
    ${CMAKE_SOURCE_DIR}/../TCMT-Windows-client/src/CPP-parsers/extern/json/single_include
)

# SQLite from TCMT submodule
set(SQLITE_DIR ${CMAKE_SOURCE_DIR}/../TCMT-Windows-client/src/third_party/sqlite)

# Stage sqlite3.h to build dir to avoid the 'version' file in source dir
# shadowing C++ standard header <version>.
set(SQLITE_STAGED ${CMAKE_BINARY_DIR}/sqlite3-staged)
file(COPY ${SQLITE_DIR}/sqlite3.h DESTINATION ${SQLITE_STAGED})

add_library(sqlite3 STATIC ${SQLITE_DIR}/sqlite3.c)
target_include_directories(sqlite3 PUBLIC ${SQLITE_STAGED})
target_compile_options(sqlite3 PRIVATE -w)  # silence sqlite amalgamation warnings

add_executable(tcmt-server
    src/main.cpp
    src/server.cpp
    src/device.cpp
    src/storage.cpp
    src/api.cpp
    src/ws.cpp
)

target_include_directories(tcmt-server PRIVATE include)

find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
target_link_libraries(tcmt-server PRIVATE sqlite3 Threads::Threads OpenSSL::SSL OpenSSL::Crypto)
