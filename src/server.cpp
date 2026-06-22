#include "server.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <cstring>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <openssl/sha.h>   // SHA1
#include <arpa/inet.h>      // ntohs etc.

// ---------------------------------------------------------------------------
// Base64 encoding (RFC 4648)
// ---------------------------------------------------------------------------
static std::string Base64Encode(const unsigned char* data, size_t len) {
    static const char enc[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        unsigned int b = (static_cast<unsigned int>(data[i]) << 16) |
                         (i + 1 < len ? static_cast<unsigned int>(data[i + 1]) << 8 : 0) |
                         (i + 2 < len ? static_cast<unsigned int>(data[i + 2]) : 0);
        out += enc[(b >> 18) & 0x3F];
        out += enc[(b >> 12) & 0x3F];
        out += (i + 1 < len) ? enc[(b >> 6) & 0x3F] : '=';
        out += (i + 2 < len) ? enc[b & 0x3F] : '=';
    }
    return out;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

void HttpServer::GET(const std::string& path, Handler handler) {
    routes_.push_back({"GET", path, std::move(handler)});
}

void HttpServer::POST(const std::string& path, Handler handler) {
    routes_.push_back({"POST", path, std::move(handler)});
}

void HttpServer::WS(const std::string& path) {
    // Store a WS marker route (the handshake is handled inline in AcceptLoop)
    routes_.push_back({"GET", path, [](const std::string&, const std::string&, const std::string&) -> std::string {
        return ""; // never called — handshake is done inline
    }});
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

// ---------------------------------------------------------------------------
// Helper: check if request has "Upgrade: websocket" and extract Sec-WebSocket-Key
// ---------------------------------------------------------------------------
static bool IsWebSocketUpgrade(const std::string& request, std::string& secKey) {
    // Check for the upgrade header
    auto upPos = request.find("Upgrade:");
    if (upPos == std::string::npos)
        return false;
    // Verify it says "websocket" (case-insensitive)
    auto valStart = request.find_first_not_of(" \t", upPos + 8);
    if (valStart == std::string::npos)
        return false;
    auto valEnd = request.find("\r\n", valStart);
    std::string upgradeVal = request.substr(valStart, valEnd - valStart);
    // Trim trailing whitespace
    while (!upgradeVal.empty() && (upgradeVal.back() == ' ' || upgradeVal.back() == '\t' || upgradeVal.back() == '\r'))
        upgradeVal.pop_back();
    if (upgradeVal != "websocket")
        return false;

    // Extract Sec-WebSocket-Key
    auto keyPos = request.find("Sec-WebSocket-Key:");
    if (keyPos == std::string::npos)
        return false;
    auto keyStart = request.find_first_not_of(" \t", keyPos + 18);
    if (keyStart == std::string::npos)
        return false;
    auto keyEnd = request.find("\r\n", keyStart);
    secKey = request.substr(keyStart, keyEnd - keyStart);
    // Trim trailing whitespace
    while (!secKey.empty() && (secKey.back() == ' ' || secKey.back() == '\t' || secKey.back() == '\r'))
        secKey.pop_back();
    return !secKey.empty();
}

// ---------------------------------------------------------------------------
// WS handshake response (RFC 6455)
// ---------------------------------------------------------------------------
std::string HttpServer::WsHandshakeResponse(const std::string& secKey) {
    // 1. Append the magic GUID
    std::string concat = secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    // 2. SHA-1 hash
    unsigned char hash[SHA_DIGEST_LENGTH];
    SHA1(reinterpret_cast<const unsigned char*>(concat.data()), concat.size(), hash);

    // 3. Base64 encode
    std::string accept = Base64Encode(hash, SHA_DIGEST_LENGTH);

    // 4. Build 101 response
    std::ostringstream oss;
    oss << "HTTP/1.1 101 Switching Protocols\r\n"
        << "Upgrade: websocket\r\n"
        << "Connection: Upgrade\r\n"
        << "Sec-WebSocket-Accept: " << accept << "\r\n"
        << "\r\n";
    return oss.str();
}

// ---------------------------------------------------------------------------
// Build a single WebSocket text frame (FIN=1, opcode=0x1)
// ---------------------------------------------------------------------------
std::string HttpServer::WsFrame(const std::string& payload) {
    std::string frame;
    frame.reserve(payload.size() + 10);

    // First byte: FIN (0x80) | text opcode (0x1) = 0x81
    frame += static_cast<char>(0x81);

    // Encode length
    size_t len = payload.size();
    if (len < 126) {
        frame += static_cast<char>(len);
    } else if (len <= 0xFFFF) {
        frame += static_cast<char>(126);
        frame += static_cast<char>((len >> 8) & 0xFF);
        frame += static_cast<char>(len & 0xFF);
    } else {
        frame += static_cast<char>(127);
        for (int i = 7; i >= 0; --i)
            frame += static_cast<char>((len >> (i * 8)) & 0xFF);
    }

    frame += payload;
    return frame;
}

// ---------------------------------------------------------------------------
// Broadcast a text message to all connected WS clients
// ---------------------------------------------------------------------------
void HttpServer::WsBroadcast(const std::string& message) {
    std::string frame = WsFrame(message);
    std::lock_guard<std::mutex> lock(wsMutex_);
    for (auto it = wsClients_.begin(); it != wsClients_.end(); ) {
        ssize_t sent = write(*it, frame.data(), frame.size());
        if (sent <= 0) {
            close(*it);
            it = wsClients_.erase(it);
        } else {
            ++it;
        }
    }
}

// ---------------------------------------------------------------------------
// Accept loop (HTTP/1.1 + WebSocket upgrade)
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

        // ── WebSocket upgrade check ────────────────────────────────────────
        std::string secKey;
        if (method == "GET" && IsWebSocketUpgrade(request, secKey)) {
            // Verify the path is a registered WS endpoint
            Route* route = MatchRoute(method, path);
            if (route) {
                std::string handshake = WsHandshakeResponse(secKey);
                write(cfd, handshake.data(), handshake.size());

                // Add to WS client list
                {
                    std::lock_guard<std::mutex> lock(wsMutex_);
                    wsClients_.push_back(cfd);
                }
                std::cout << "[ws] Client connected: " << path << " (total: "
                          << wsClients_.size() << ")" << std::endl;
            } else {
                // WS route not registered — reject
                std::string resp = BuildHttpResponse(404, "Not Found", "text/plain");
                write(cfd, resp.data(), resp.size());
                close(cfd);
            }
            // Keep the socket open (don't close)
            continue;
        }

        // ── Normal HTTP handling ───────────────────────────────────────────
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
