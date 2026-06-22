#pragma once
#include "server.h"
#include "device.h"
#include "storage.h"

class ApiRouter {
public:
    static void Register(HttpServer& server, DeviceManager& devices, Storage& storage);
};
