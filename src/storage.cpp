#include "storage.h"
#include <cstring>
#include <sstream>

bool Storage::Open(const std::string& dbPath) {
    int rc = sqlite3_open(dbPath.c_str(), &db_);
    if (rc != SQLITE_OK) {
        db_ = nullptr;
        return false;
    }
    EnsureTables();
    return true;
}

void Storage::Close() {
    if (db_) {
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

void Storage::EnsureTables() {
    const char* snapshotsSQL =
        "CREATE TABLE IF NOT EXISTS snapshots ("
        "  device_id TEXT NOT NULL,"
        "  timestamp  INTEGER NOT NULL,"
        "  data       TEXT NOT NULL"
        ");";

    const char* tsSQL =
        "CREATE TABLE IF NOT EXISTS timeseries ("
        "  device_id TEXT NOT NULL,"
        "  ts        INTEGER NOT NULL,"
        "  field     TEXT NOT NULL,"
        "  value     REAL NOT NULL"
        ");";

    const char* idxSQL =
        "CREATE INDEX IF NOT EXISTS idx_timeseries_lookup "
        "ON timeseries(device_id, field, ts);";

    auto exec = [&](const char* sql) {
        char* err = nullptr;
        sqlite3_exec(db_, sql, nullptr, nullptr, &err);
        if (err) {
            sqlite3_free(err);
        }
    };

    exec(snapshotsSQL);
    exec(tsSQL);
    exec(idxSQL);
}

void Storage::InsertSnapshot(const std::string& deviceId, const nlohmann::json& data, int64_t ts) {
    // Store full JSON in snapshots table
    std::string jsonStr = data.dump();
    {
        sqlite3_stmt* stmt = nullptr;
        const char* sql = "INSERT INTO snapshots (device_id, timestamp, data) VALUES (?, ?, ?);";
        if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
            sqlite3_bind_text(stmt, 1, deviceId.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_bind_int64(stmt, 2, ts);
            sqlite3_bind_text(stmt, 3, jsonStr.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_step(stmt);
        }
        sqlite3_finalize(stmt);
    }

    // Recursively extract numeric fields into timeseries table
    auto extract = [&](const std::string& prefix, const nlohmann::json& obj, auto& recurse) -> void {
        for (auto it = obj.begin(); it != obj.end(); ++it) {
            std::string key = prefix.empty() ? it.key() : prefix + "." + it.key();
            if (it.value().is_number()) {
                InsertField(deviceId, key, it.value().get<double>(), ts);
            } else if (it.value().is_object()) {
                recurse(key, it.value(), recurse);
            } else if (it.value().is_array()) {
                for (size_t i = 0; i < it.value().size(); ++i) {
                    std::string arrKey = key + "[" + std::to_string(i) + "]";
                    if (it.value()[i].is_number()) {
                        InsertField(deviceId, arrKey, it.value()[i].get<double>(), ts);
                    } else if (it.value()[i].is_object()) {
                        recurse(arrKey, it.value()[i], recurse);
                    }
                }
            }
        }
    };
    extract("", data, extract);
}

void Storage::InsertField(const std::string& deviceId, const std::string& field, double value, int64_t ts) {
    sqlite3_stmt* stmt = nullptr;
    const char* sql = "INSERT INTO timeseries (device_id, ts, field, value) VALUES (?, ?, ?, ?);";
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, deviceId.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt, 2, ts);
        sqlite3_bind_text(stmt, 3, field.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_double(stmt, 4, value);
        sqlite3_step(stmt);
    }
    sqlite3_finalize(stmt);
}

std::vector<TimePoint> Storage::QueryHistory(
    const std::string& deviceId,
    const std::string& field,
    int64_t from, int64_t to,
    int limit)
{
    std::vector<TimePoint> results;
    sqlite3_stmt* stmt = nullptr;
    const char* sql =
        "SELECT ts, value FROM timeseries "
        "WHERE device_id=? AND field=? AND ts BETWEEN ? AND ? "
        "ORDER BY ts LIMIT ?;";

    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, deviceId.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 2, field.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt, 3, from);
        sqlite3_bind_int64(stmt, 4, to);
        sqlite3_bind_int(stmt, 5, limit);

        while (sqlite3_step(stmt) == SQLITE_ROW) {
            TimePoint tp;
            tp.timestamp = sqlite3_column_int64(stmt, 0);
            tp.deviceId = deviceId;
            tp.field = field;
            tp.value = sqlite3_column_double(stmt, 1);
            results.push_back(tp);
        }
    }
    sqlite3_finalize(stmt);
    return results;
}

nlohmann::json Storage::GetLatest(const std::string& deviceId) {
    nlohmann::json result = nlohmann::json::object();
    sqlite3_stmt* stmt = nullptr;
    const char* sql =
        "SELECT data FROM snapshots "
        "WHERE device_id=? ORDER BY timestamp DESC LIMIT 1;";

    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, deviceId.c_str(), -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            const char* text = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
            if (text) {
                try {
                    result = nlohmann::json::parse(text);
                } catch (...) {
                }
            }
        }
    }
    sqlite3_finalize(stmt);
    return result;
}
