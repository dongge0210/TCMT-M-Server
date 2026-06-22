#pragma once
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <vector>

class HttpServer {
public:
    using Handler = std::function<std::string(const std::string& method, const std::string& path, const std::string& body)>;

    bool Start(int port);
    void Stop();
    void GET(const std::string& path, Handler handler);
    void POST(const std::string& path, Handler handler);
    void WS(const std::string& path); // placeholder — not yet implemented

private:
    struct Route {
        std::string method;
        std::string prefix;
        Handler handler;
    };

    void AcceptLoop();
    static std::string BuildHttpResponse(int status, const std::string& body, const std::string& contentType);
    static bool ParseRequestLine(const std::string& line, std::string& method, std::string& path);
    Route* MatchRoute(const std::string& method, const std::string& path);

    std::vector<Route> routes_;
    int fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread thread_;
};
