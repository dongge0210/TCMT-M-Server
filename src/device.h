#pragma once
#include <string>
#include <vector>
#include <mutex>
#include <cstdint>
#include "json.hpp"

struct Device {
    std::string id;       // "dev_XXXX"
    std::string name;     // "MacBook M2"
    std::string token;    // auth token
    std::string os;       // "macOS 27.0"
    std::string model;    // "Mac14,2"
    int64_t lastSeen = 0; // unix timestamp
    bool online = false;
    nlohmann::json latestData; // last ingested snapshot
};

class DeviceManager {
public:
    std::string Register(const std::string& name, const std::string& os, const std::string& model);
    std::vector<Device> List();
    Device* Get(const std::string& id);
    bool Auth(const std::string& token);
    void UpdateData(const std::string& token, const nlohmann::json& data);
    void SetOnline(const std::string& token, bool online);
private:
    std::mutex mutex_;
    std::vector<Device> devices_;
    int counter_ = 0;
    std::string GenId();
    std::string GenToken();
};
