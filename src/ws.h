#pragma once
#include "server.h"
#include "device.h"

class WsHandler {
public:
    static void Register(HttpServer& server, DeviceManager& devices);
};
