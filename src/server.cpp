#include "server.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <cstring>
#include <iostream>
#include <sstream>
#include <algorithm>

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

void HttpServer::GET(const std::string& path, Handler handler) {
    routes_.push_back({"GET", path, std::move(handler)});
}

void HttpServer::POST(const std::string& path, Handler handler) {
    routes_.push_back({"POST", path, std::move(handler)});
}

void HttpServer::WS(const std::string& /*path*/) {
    // placeholder — WebSocket upgrade not yet implemented
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

bool HttpServer::Start(int port) {
    fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) {
        std::perror("socket");
        return false;
    }

    int opt = 1;
    setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // 127.0.0.1 only
    addr.sin_port = htons(static_cast<uint16_t>(port));

    if (bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::perror("bind");
        close(fd_);
        fd_ = -1;
        return false;
    }

    if (listen(fd_, 128) < 0) {
        std::perror("listen");
        close(fd_);
        fd_ = -1;
        return false;
    }

    running_.store(true);
    thread_ = std::thread(&HttpServer::AcceptLoop, this);
    return true;
}

void HttpServer::Stop() {
    running_.store(false);
    // close the listening fd to unblock accept()
    if (fd_ >= 0) {
        close(fd_);
        fd_ = -1;
    }
    if (thread_.joinable())
        thread_.join();
}

// ---------------------------------------------------------------------------
// Accept loop
// ---------------------------------------------------------------------------

void HttpServer::AcceptLoop() {
    while (running_.load()) {
        sockaddr_in client{};
        socklen_t len = sizeof(client);
        int cfd = accept(fd_, reinterpret_cast<sockaddr*>(&client), &len);
        if (cfd < 0) {
            if (running_.load()) {
                std::perror("accept");
            }
            break;
        }

        // Read request
        char buf[8192];
        ssize_t n = read(cfd, buf, sizeof(buf) - 1);
        if (n <= 0) {
            close(cfd);
            continue;
        }
        buf[n] = '\0';

        // Parse first line: "METHOD /path HTTP/1.x"
        std::string request(buf);
        auto lineEnd = request.find("\r\n");
        if (lineEnd == std::string::npos) {
            close(cfd);
            continue;
        }
        std::string requestLine = request.substr(0, lineEnd);

        std::string method, path;
        if (!ParseRequestLine(requestLine, method, path)) {
            std::string resp = BuildHttpResponse(400, "Bad Request", "text/plain");
            write(cfd, resp.data(), resp.size());
            close(cfd);
            continue;
        }

        // Extract body (after \r\n\r\n)
        auto bodyStart = request.find("\r\n\r\n");
        std::string body;
        if (bodyStart != std::string::npos && bodyStart + 4 < request.size()) {
            body = request.substr(bodyStart + 4);
        }

        // Match route
        Route* route = MatchRoute(method, path);
        std::string responseBody;
        int status;
        if (route) {
            try {
                responseBody = route->handler(method, path, body);
                status = 200;
            } catch (const std::exception& e) {
                responseBody = "{\"error\":\"" + std::string(e.what()) + "\"}";
                status = 500;
            }
        } else {
            responseBody = "{\"error\":\"Not Found\"}";
            status = 404;
        }

        std::string resp = BuildHttpResponse(status, responseBody,
            (responseBody.size() >= 1 && responseBody[0] == '{') ? "application/json" : "text/plain");

        write(cfd, resp.data(), resp.size());
        close(cfd);
    }
}

// ---------------------------------------------------------------------------
// Parsing & routing helpers
// ---------------------------------------------------------------------------

bool HttpServer::ParseRequestLine(const std::string& line, std::string& method, std::string& path) {
    auto s = line.find(' ');
    if (s == std::string::npos) return false;
    auto e = line.rfind(' ');
    if (e == std::string::npos || e <= s) return false;

    method = line.substr(0, s);
    path = line.substr(s + 1, e - s - 1);

    // Remove query string if present
    auto q = path.find('?');
    if (q != std::string::npos)
        path = path.substr(0, q);

    return true;
}

HttpServer::Route* HttpServer::MatchRoute(const std::string& method, const std::string& path) {
    for (auto& rt : routes_) {
        if (rt.method != method)
            continue;

        // Exact match first
        if (rt.prefix == path)
            return &rt;

        // Prefix match: only if route ends with '/' (sub-resource).
        // Routes without trailing slash like "/api/devices" match EXACT only.
        if (rt.prefix.back() == '/' &&
            path.size() > rt.prefix.size() &&
            path.compare(0, rt.prefix.size(), rt.prefix) == 0) {
            return &rt;
        }
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

std::string HttpServer::BuildHttpResponse(int status, const std::string& body, const std::string& contentType) {
    static const char* reason = nullptr;
    switch (status) {
        case 200: reason = "OK"; break;
        case 400: reason = "Bad Request"; break;
        case 404: reason = "Not Found"; break;
        case 500: reason = "Internal Server Error"; break;
        default:  reason = "Unknown"; break;
    }

    std::ostringstream oss;
    oss << "HTTP/1.1 " << status << " " << reason << "\r\n"
        << "Content-Type: " << contentType << "\r\n"
        << "Content-Length: " << body.size() << "\r\n"
        << "Access-Control-Allow-Origin: *\r\n"
        << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        << "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
        << "Connection: close\r\n"
        << "\r\n"
        << body;
    return oss.str();
}
