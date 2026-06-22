#include "api.h"
#include "json.hpp"
#include <sstream>
#include <chrono>
#include <ctime>

using json = nlohmann::json;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/// Extract a path segment after the route prefix.
/// Example: param("/api/devices/", "/api/devices/dev_abc/latest") -> "dev_abc"
static std::string pathParam(const std::string& prefix, const std::string& path) {
    if (path.size() > prefix.size())
        return path.substr(prefix.size());
    return {};
}

/// Current time as unix milliseconds.
static int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

/// Find a device by auth token. Returns nullptr on failure.
static Device* findByToken(DeviceManager& devices, const std::string& token) {
    for (auto& d : devices.List()) {
        if (d.token == token) {
            // List returns a copy — we need Get() for the pointer.
            return devices.Get(d.id);
        }
    }
    return nullptr;
}

// -----------------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------------

void ApiRouter::Register(HttpServer& server, DeviceManager& devices, Storage& storage) {
    // ── Health / Ping ────────────────────────────────────────────────────────
    server.GET("/ping", [&](const std::string&, const std::string&, const std::string&) -> std::string {
        json r = {{"status","ok"},{"time",nowMs()}};
        return r.dump();
    });

    // ── Device Registration ──────────────────────────────────────────────────
    server.POST("/api/register", [&](const std::string&, const std::string&, const std::string& body) -> std::string {
        json req = json::parse(body);
        std::string name  = req.value("name",  "Unknown");
        std::string os    = req.value("os",    "Unknown");
        std::string model = req.value("model", "Unknown");
        std::string token = devices.Register(name, os, model);

        // Find the freshly-registered device so we can echo back its id.
        std::string id;
        for (auto& d : devices.List()) {
            if (d.token == token) { id = d.id; break; }
        }

        json resp = {{"id",id},{"token",token},{"name",name}};
        return resp.dump();
    });

    // ── Device List ──────────────────────────────────────────────────────────
    server.GET("/api/devices", [&](const std::string&, const std::string&, const std::string&) -> std::string {
        json arr = json::array();
        for (const auto& d : devices.List()) {
            arr.push_back({
                {"id",       d.id},
                {"name",     d.name},
                {"os",       d.os},
                {"model",    d.model},
                {"online",   d.online},
                {"lastSeen", d.lastSeen}
            });
        }
        return arr.dump();
    });

    // ── Single Device + Sub-resources (MUST be before list route) ───────
    // Registered FIRST so MatchRoute picks exact match before wider prefixes.
    server.GET("/api/devices/", [&](const std::string&, const std::string& path, const std::string&) -> std::string {
        // path looks like /api/devices/dev_XXXX[/subresource]
        std::string rest = pathParam("/api/devices/", path);
        if (rest.empty())
            return json{{"error","missing device id"}}.dump();

        // Split into deviceId / sub-resource
        auto slash = rest.find('/');
        std::string id  = (slash == std::string::npos) ? rest : rest.substr(0, slash);
        std::string sub = (slash == std::string::npos) ? ""    : rest.substr(slash + 1);

        Device* d = devices.Get(id);
        if (!d)
            return json{{"error","device not found"}}.dump();

        // No sub-resource -> full device info
        if (sub.empty()) {
            return json{
                {"id",     d->id},
                {"name",   d->name},
                {"os",     d->os},
                {"model",  d->model},
                {"online", d->online},
                {"lastSeen", d->lastSeen}
            }.dump();
        }

        // ── Latest full snapshot ─────────────────────────────────────────
        if (sub == "latest") {
            return d->latestData.dump();
        }

        // ── Sub-resource delegates (cpu / memory / temperatures / etc.) ──
        if (sub == "cpu") {
            return json{
                {"name",  d->latestData.value("cpu_name","")},
                {"usage", d->latestData.value("cpu_usage",0.0)}
            }.dump();
        }
        if (sub == "memory") {
            return json{
                {"total", d->latestData.value("total_memory",0ULL)},
                {"used",  d->latestData.value("used_memory",0ULL)}
            }.dump();
        }
        if (sub == "temperatures") {
            return d->latestData.value("temperatures", json::array()).dump();
        }

        // ── Generic field passthrough ────────────────────────────────────
        if (d->latestData.contains(sub)) {
            return d->latestData[sub].dump();
        }

        return json{{"error","unknown sub-resource"}}.dump();
    });

    // ── Data Ingestion ───────────────────────────────────────────────────────
    server.POST("/api/ingest", [&](const std::string&, const std::string&, const std::string& body) -> std::string {
        json data = json::parse(body);
        std::string token = data.value("token", "");

        if (token.empty() || !devices.Auth(token))
            return json{{"error","unauthorized"}}.dump();

        devices.UpdateData(token, data);
        devices.SetOnline(token, true);

        // Persist snapshot to storage.
        Device* dev = findByToken(devices, token);
        if (dev) {
            storage.InsertSnapshot(dev->id, data, nowMs());
        }

        return json{{"status","ok"}}.dump();
    });

    // ── History ──────────────────────────────────────────────────────────────
    server.GET("/api/devices/", [&](const std::string&, const std::string& path, const std::string&) -> std::string {
        // path: /api/devices/dev_XXXX/history?field=cpu.usage&from=-3600000&to=now
        // NOTE: The HttpServer strips query strings *before* routing (see server.cpp Line 164),
        // so query params are not available here. This is a placeholder that returns
        // the latest snapshot instead. Full time-series query support requires query-string
        // preservation in the server core.
        std::string rest = pathParam("/api/devices/", path);
        if (rest.empty())
            return json{{"error","missing device id"}}.dump();

        auto slash = rest.find('/');
        std::string id    = (slash == std::string::npos) ? rest : rest.substr(0, slash);
        std::string sub   = (slash == std::string::npos) ? ""    : rest.substr(slash + 1);

        // Only handle "history" sub-resource
        if (sub.empty() || sub.find("history") != 0)
            return json{{"error","unknown sub-resource"}}.dump();

        auto* d = devices.Get(id);
        if (!d)
            return json{{"error","device not found"}}.dump();

        // Return the latest snapshot as a one-element history array.
        // TODO: when the server core preserves query strings, replace with real
        // storage.QueryHistory() call.
        json arr = json::array();
        arr.push_back(d->latestData);
        return json{{"deviceId",id},{"history",arr}}.dump();
    });
}
