#include "ws.h"
#include "json.hpp"

using json = nlohmann::json;

void WsHandler::Register(HttpServer& server, DeviceManager& devices) {
    server.GET("/ws", [&devices](const std::string&, const std::string&, const std::string&) -> std::string {
        json r = {
            {"ws",   "WebSocket endpoint"},
            {"note", "Full WebSocket upgrade (101 Switching Protocols) not yet implemented"},
            {"online", static_cast<int>(devices.List().size())}
        };
        return r.dump();
    });
}
