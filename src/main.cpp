#include "server.h"
#include "device.h"
#include "storage.h"
#include "api.h"
#include "ws.h"
#include "json.hpp"
#include <iostream>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <atomic>
#include <unistd.h>
#include <sys/stat.h>

using json = nlohmann::json;

// -----------------------------------------------------------------------------
// Globals (accessed by signal handler)
// -----------------------------------------------------------------------------
static HttpServer    g_server;
static DeviceManager g_devices;
static Storage       g_storage;
static std::atomic<bool> g_running{true};

void HandleSignal(int /*sig*/) {
    if (!g_running.exchange(false))
        return; // already shutting down
    std::cout << "\nShutting down..." << std::endl;
    g_server.Stop();
    g_storage.Close();
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------
int main(int argc, char* argv[]) {
    int port = 8080;
    // Default DB: ~/.tcmt/server.db (auto-create directory)
    std::string home = getenv("HOME") ? getenv("HOME") : ".";
    std::string dbDir  = home + "/.tcmt";
    std::string dbPath = dbDir + "/server.db";
    mkdir(dbDir.c_str(), 0755);

    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        } else if (std::strcmp(argv[i], "--db") == 0 && i + 1 < argc) {
            dbPath = argv[++i];
        }
    }

    std::signal(SIGINT,  HandleSignal);
    std::signal(SIGTERM, HandleSignal);

    // ── Storage ──────────────────────────────────────────────────────────────
    if (!g_storage.Open(dbPath)) {
        std::cerr << "FATAL: Failed to open database: " << dbPath << std::endl;
        return 1;
    }
    std::cout << "Storage: " << dbPath << std::endl;

    // ── API routes ───────────────────────────────────────────────────────────
    ApiRouter::Register(g_server, g_devices, g_storage);
    WsHandler::Register(g_server, g_devices);

    // ── Start server ─────────────────────────────────────────────────────────
    if (!g_server.Start(port)) {
        std::cerr << "FATAL: Failed to start server on port " << port << std::endl;
        g_storage.Close();
        return 1;
    }

    std::cout << "tcmt-server v0.1.0 ready on http://127.0.0.1:" << port << std::endl;
    std::cout << "Press Ctrl+C to stop." << std::endl;

    // Block until signal
    pause();

    return 0;
}
