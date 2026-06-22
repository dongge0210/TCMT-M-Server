#include "ws.h"
#include "json.hpp"
#include <thread>
#include <chrono>

using json = nlohmann::json;

void WsHandler::Register(HttpServer& server, DeviceManager& devices) {
    // Register the WS upgrade endpoint
    // (server.cpp AcceptLoop will intercept GET /ws with Upgrade: websocket
    //  and perform the handshake before calling this route handler.)
    server.GET("/ws", [](const std::string&, const std::string&, const std::string&) -> std::string {
        // This is a fallback for non-WebSocket HTTP GET /ws
        json r = {
            {"ws",   "WebSocket endpoint"},
            {"note", "Use a WebSocket client to connect (ws://127.0.0.1:PORT/ws)"},
        };
        return r.dump();
    });

    // Start a background broadcast thread
    std::thread([&server, &devices]() {
        while (server.IsRunning()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));

            json msg;
            msg["type"] = "devices";
            json arr = json::array();
            for (auto& d : devices.List()) {
                arr.push_back({
                    {"id", d.id},
                    {"name", d.name},
                    {"online", d.online}
                });
            }
            msg["data"] = arr;
            server.WsBroadcast(msg.dump());
        }
    }).detach();
}
