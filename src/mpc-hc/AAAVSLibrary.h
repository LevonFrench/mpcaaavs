#pragma once
#include <Windows.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <stdexcept>
#include <regex>
#include "../thirdparty/rapidjson/include/rapidjson/document.h"
#include "../thirdparty/rapidjson/include/rapidjson/writer.h"
#include "../thirdparty/rapidjson/include/rapidjson/stringbuffer.h"

// All writes are restricted to the installed local collection. Preset bytes and
// content identity stay unchanged; catalog replacement is atomic, with rollback.
namespace AAAVSLibrary {
namespace fs = std::filesystem;
inline std::string Utf8(const std::wstring& w) {
    const int size = WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(size, 0); WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), s.data(), size, nullptr, nullptr); return s;
}
inline std::wstring Wide(const std::string& s) {
    int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), int(s.size()), nullptr, 0);
    if (!size) throw std::runtime_error("Invalid UTF-8 path");
    std::wstring w(size, 0); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), int(s.size()), w.data(), size); return w;
}
inline std::string Read(const fs::path& path) {
    if (fs::file_size(path) > 16 * 1024 * 1024) throw std::runtime_error("Library data is too large");
    std::ifstream f(path, std::ios::binary); if (!f) throw std::runtime_error("Cannot read library data");
    return std::string(std::istreambuf_iterator<char>(f), {});
}
inline std::string Json(const rapidjson::Value& value) {
    rapidjson::StringBuffer out; rapidjson::Writer<rapidjson::StringBuffer> writer(out); value.Accept(writer); return out.GetString();
}
inline void NoLinks(const fs::path& path) {
    fs::path current;
    for (const auto& part : fs::absolute(path)) {
        current /= part;
        const DWORD attr = GetFileAttributesW(current.c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Linked library paths are not writable");
    }
}
class CatalogLock {
    HANDLE handle;
public:
    explicit CatalogLock(const fs::path& root) {
        const auto path=root/L"catalog/ratings.lock";NoLinks(path);
        handle=CreateFileW(path.c_str(),GENERIC_WRITE,0,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(handle==INVALID_HANDLE_VALUE)throw std::runtime_error("Another preset rating is being saved; try again");
    }
    ~CatalogLock(){CloseHandle(handle);}
};
inline fs::path PresetPath(const fs::path& root, const std::string& relative) {
    if (relative.rfind("presets/", 0) != 0 || relative.find('\\') != std::string::npos || relative.find(':') != std::string::npos || relative.find('\0') != std::string::npos) throw std::runtime_error("Invalid preset path");
    fs::path p(Wide(relative));
    for (const auto& part : p) if (part == L".." || part == L"." || part.empty()) throw std::runtime_error("Invalid preset path");
    if (p.extension() != L".avs" && p.extension() != L".nerv") throw std::runtime_error("Not a supported preset file");
    const auto result = root / p; NoLinks(result); return result;
}
inline void AtomicWrite(const fs::path& path, const std::string& data) {
    NoLinks(path); auto temp = path; temp += L".writing"; NoLinks(temp);
    HANDLE file = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create library transaction; check permissions or an unfinished .writing file");
    DWORD written = 0; bool ok = WriteFile(file, data.data(), DWORD(data.size()), &written, nullptr) && written == data.size() && FlushFileBuffers(file);
    CloseHandle(file);
    if (ok) ok = MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    if (!ok) { DeleteFileW(temp.c_str()); throw std::runtime_error("Cannot save library data"); }
}
inline std::string Rate(const fs::path& root, const std::string& hash, int rating) {
    if (!std::regex_match(hash, std::regex("[0-9a-f]{64}")) || rating < 1 || rating > 5) throw std::runtime_error("Invalid rating request");
    NoLinks(root); const auto catalog = root / L"catalog/presets.json"; NoLinks(catalog);
    CatalogLock lock(root);
    rapidjson::Document doc; doc.Parse(Read(catalog).c_str());
    if (doc.HasParseError() || !doc.IsObject() || !doc.HasMember("presets") || !doc["presets"].IsArray()) throw std::runtime_error("Invalid preset catalog");
    for (auto& entry : doc["presets"].GetArray()) {
        if (!entry.IsObject() || !entry.HasMember("sha256") || !entry["sha256"].IsString() || hash != entry["sha256"].GetString()) continue;
        if (!entry.HasMember("canonical_path") || !entry["canonical_path"].IsString()) throw std::runtime_error("Missing preset path");
        const std::string oldRelative = entry["canonical_path"].GetString();
        const auto source = PresetPath(root, oldRelative);
        if (!fs::is_regular_file(source)) throw std::runtime_error("Preset file is missing");
        const auto stem = std::regex_replace(source.stem().u8string(), std::regex(" \\[[1-5] stars\\]$"), "");
        const auto relative = fs::path(Wide(oldRelative)).parent_path() / Wide(stem + " [" + std::to_string(rating) + " stars]" + source.extension().u8string());
        const auto target = PresetPath(root, relative.generic_u8string());
        if (source != target && fs::exists(target)) throw std::runtime_error("Rated filename already exists");
        const auto oldTime = fs::last_write_time(source);
        if (source != target) fs::rename(source, target);
        try {
            fs::last_write_time(target, fs::file_time_type::clock::now());
            auto& a = doc.GetAllocator(); const auto name = relative.generic_u8string();
            entry["canonical_path"].SetString(name.c_str(), rapidjson::SizeType(name.size()), a);
            if (entry.HasMember("rating")) entry["rating"].SetInt(rating); else entry.AddMember("rating", rating, a);
            AtomicWrite(catalog, Json(doc));
        } catch (...) {
            std::error_code ec; fs::last_write_time(target, oldTime, ec);
            if (source != target) fs::rename(target, source, ec);
            if (ec) throw std::runtime_error("Save failed and rollback needs attention; rated file remains on disk");
            throw;
        }
        return Json(entry);
    }
    throw std::runtime_error("Unknown preset");
}
}
