#include "device.h"
#include <random>
#include <sstream>
#include <iomanip>
#include <ctime>

static std::string RandomHex(int len) {
    static const char hex[] = "0123456789ABCDEF";
    static thread_local std::mt19937 rng(std::random_device{}());
    std::uniform_int_distribution<int> dist(0, 15);
    std::string s;
    s.reserve(len);
    for (int i = 0; i < len; ++i)
        s += hex[dist(rng)];
    return s;
}

std::string DeviceManager::GenId() {
    return "dev_" + RandomHex(6);
}

std::string DeviceManager::GenToken() {
    return "tcmt_" + RandomHex(7);
}

std::string DeviceManager::Register(const std::string& name, const std::string& os, const std::string& model) {
    std::lock_guard<std::mutex> lock(mutex_);
    Device dev;
    dev.id = GenId();
    dev.token = GenToken();
    dev.name = name;
    dev.os = os;
    dev.model = model;
    dev.lastSeen = std::time(nullptr);
    dev.online = true;
    devices_.push_back(std::move(dev));
    return devices_.back().token;
}

std::vector<Device> DeviceManager::List() {
    std::lock_guard<std::mutex> lock(mutex_);
    return devices_;
}

Device* DeviceManager::Get(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& d : devices_) {
        if (d.id == id)
            return &d;
    }
    return nullptr;
}

bool DeviceManager::Auth(const std::string& token) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& d : devices_) {
        if (d.token == token)
            return true;
    }
    return false;
}

void DeviceManager::UpdateData(const std::string& token, const nlohmann::json& data) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& d : devices_) {
        if (d.token == token) {
            d.latestData = data;
            d.lastSeen = std::time(nullptr);
            return;
        }
    }
}

void DeviceManager::SetOnline(const std::string& token, bool online) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& d : devices_) {
        if (d.token == token) {
            d.online = online;
            if (online)
                d.lastSeen = std::time(nullptr);
            return;
        }
    }
}
