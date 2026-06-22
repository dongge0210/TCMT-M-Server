#pragma once
#include <string>
#include <vector>
#include <sqlite3.h>
#include "json.hpp"

struct TimePoint {
    int64_t timestamp;      // unix ms
    std::string deviceId;
    std::string field;      // e.g. "cpu.usage"
    double value;
};

class Storage {
public:
    bool Open(const std::string& dbPath);
    void Close();

    // Write
    void InsertSnapshot(const std::string& deviceId, const nlohmann::json& data, int64_t ts);

    // Read
    std::vector<TimePoint> QueryHistory(
        const std::string& deviceId,
        const std::string& field,
        int64_t from, int64_t to,
        int limit = 1000);

    nlohmann::json GetLatest(const std::string& deviceId);

private:
    sqlite3* db_ = nullptr;
    void EnsureTables();
    void InsertField(const std::string& deviceId, const std::string& field, double value, int64_t ts);
};
