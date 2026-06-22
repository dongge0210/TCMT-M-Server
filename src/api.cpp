#include "api.h"
#include "json.hpp"
#include <sstream>
#include <chrono>
#include <ctime>
#include <cstdlib>
#include <unordered_map>

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

/// Strip query string from a path segment. Returns the part before '?'.
static std::string stripQuery(const std::string& s) {
    auto q = s.find('?');
    return (q == std::string::npos) ? s : s.substr(0, q);
}

/// Parse query string into key-value map.
static std::unordered_map<std::string, std::string> parseQuery(const std::string& path) {
    std::unordered_map<std::string, std::string> params;
    auto q = path.find('?');
    if (q == std::string::npos) return params;

    std::string qs = path.substr(q + 1);
    size_t pos = 0;
    while (pos < qs.size()) {
        auto eq = qs.find('=', pos);
        auto amp = qs.find('&', pos);
        if (amp == std::string::npos) amp = qs.size();
        if (eq != std::string::npos && eq < amp) {
            std::string key = qs.substr(pos, eq - pos);
            std::string val = qs.substr(eq + 1, amp - eq - 1);
            params[key] = val;
        }
        pos = amp + 1;
    }
    return params;
}

/// Current time as unix milliseconds.
static int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

/// Parse a time value: absolute unix ms, or relative like "-1h", "-30m", "-7d".
static int64_t parseTime(const std::string& val, int64_t fallback) {
    if (val.empty()) return fallback;
    if (val[0] == '-') {
        // Relative time: "-1h", "-30m", "-7d"
        int64_t num = -std::atoll(val.c_str() + 1); // skip '-', negate
        char unit = val.back();
        int64_t ms = 0;
        switch (unit) {
            case 's': ms = num * 1000LL; break;
            case 'm': ms = num * 60LL * 1000LL; break;
            case 'h': ms = num * 3600LL * 1000LL; break;
            case 'd': ms = num * 86400LL * 1000LL; break;
            default:  ms = num * 1000LL; break; // treat bare number as seconds
        }
        return nowMs() + ms;
    }
    // Absolute timestamp
    return std::atoll(val.c_str());
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
        // path looks like /api/devices/dev_XXXX[/subresource][?query]
        std::string rest = pathParam("/api/devices/", path);
        if (rest.empty())
            return json{{"error","missing device id"}}.dump();

        // Split into deviceId / sub-resource (strip query from both)
        auto slash = rest.find('/');
        std::string id  = (slash == std::string::npos) ? stripQuery(rest) : rest.substr(0, slash);
        std::string subRaw = (slash == std::string::npos) ? "" : rest.substr(slash + 1);
        std::string sub = stripQuery(subRaw);

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

        // ── History (time-series query) ─────────────────────────────────
        if (sub == "history") {
            auto params = parseQuery(path);
            std::string field = params.count("field") ? params["field"] : "";
            if (field.empty())
                return json{{"error","missing 'field' query parameter"}}.dump();

            int64_t now = nowMs();
            int64_t from = parseTime(params.count("from") ? params["from"] : "-1h", now - 3600000);
            int64_t to   = parseTime(params.count("to")   ? params["to"]   : "", now);
            int limit    = params.count("limit") ? std::atoi(params["limit"].c_str()) : 1000;

            auto points = storage.QueryHistory(id, field, from, to, limit);

            json arr = json::array();
            for (const auto& p : points) {
                arr.push_back({{"ts", p.timestamp}, {"value", p.value}});
            }
            return json{
                {"deviceId", id},
                {"field",    field},
                {"from",     from},
                {"to",       to},
                {"count",    arr.size()},
                {"history",  arr}
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
}
