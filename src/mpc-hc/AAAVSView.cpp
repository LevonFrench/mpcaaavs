#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <afxwin.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include "AAAVSView.h"
#include "AAAVSLibrary.h"
#include "../DSUtil/AAAVSAudio.h"
#include "resource.h"
#include "AAAVSTransitionNames.h"
#include <WebView2.h>
#include <wrl.h>
#include <sstream>
#include <locale>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;
// Legacy 'beats' <-> 'fadeTiming' projection; the tables in src/mpc-contract.ts are authoritative.
static int FadeFromBeats(int b) { return b == 1 ? 2 : b == 2 ? 3 : b == 4 ? 4 : 0; }
static int BeatsFromFade(int f) { return f == 2 ? 1 : f == 3 ? 2 : f == 4 ? 4 : 0; }
static constexpr UINT kTransitionMenuBase = 100;
static constexpr wchar_t kHostClass[] = L"AAAVSInteractiveHost";
static_assert(kTransitionMenuBase == 100 && kTransitionCount <= 100, "transition menu IDs 100-199 (contract 2.5.4)");
static std::wstring ProgramFolder() {
    wchar_t path[32768]{};
    const DWORD length = GetModuleFileNameW(nullptr, path, _countof(path));
    if (!length || length == _countof(path)) return L"";
    std::wstring result(path, length);
    return result.substr(0, result.find_last_of(L"\\/") + 1);
}
struct AAAVSView::State {
    int panel = 0;
    void Library(const wchar_t* text) {
        std::string operation;
        try {
            const auto request = AAAVSLibrary::Utf8(text);
            if (request.size() > 4 * 1024 * 1024) throw std::runtime_error("Library request is too large");
            if (!AAAVSLibrary::DepthOk(request)) throw std::runtime_error("Invalid library request");
            rapidjson::Document d; d.Parse<rapidjson::kParseIterativeFlag>(request.c_str());
            if (d.HasParseError() || !d.IsObject() || !d.HasMember("op") || !d["op"].IsString()) throw std::runtime_error("Invalid library request");
            const std::string op = d["op"].GetString();
            operation = op;
            const auto root = std::filesystem::path(ProgramFolder()) / L"visualizer/avs presets";
            std::string response;
            if (op == "rate" && d.HasMember("hash") && d["hash"].IsString() && d.HasMember("rating") && d["rating"].IsInt()) {
                response = "{\"type\":\"rating-saved\",\"entry\":" + AAAVSLibrary::Rate(root, d["hash"].GetString(), d["rating"].GetInt()) + "}";
            } else if (op == "set-not-working" && d.HasMember("hash") && d["hash"].IsString() && d.HasMember("notWorking") && d["notWorking"].IsBool()) {
                response = "{\"type\":\"not-working-saved\",\"entry\":" + AAAVSLibrary::SetNotWorking(root, d["hash"].GetString(), d["notWorking"].GetBool()) + "}";
            } else if (op == "load-setups") {
                const auto path = root / L"setups.json"; AAAVSLibrary::NoLinks(path);
                response = "{\"type\":\"setups-loaded\",\"setups\":" + (std::filesystem::exists(path) ? AAAVSLibrary::Read(path) : "[]") + "}";
            } else if (op == "save-setups" && d.HasMember("setups") && d["setups"].IsArray() && d["setups"].Size() <= 100) {
                AAAVSLibrary::AtomicWrite(root / L"setups.json", AAAVSLibrary::Json(d["setups"]));
                response = "{\"type\":\"setups-saved\"}";
            } else if (op == "load-state" || op == "save-state") {
                if (!d.HasMember("name") || !d["name"].IsString()) throw std::runtime_error("Invalid state request");
                const std::string name = d["name"].GetString();
                if (op == "load-state") response = AAAVSLibrary::LoadState(root, name);
                else if (d.HasMember("data")) response = AAAVSLibrary::SaveState(root, name, d["data"]);
                else throw std::runtime_error("Invalid state request");
            } else if (op == "configure" && d.HasMember("settings") && d["settings"].IsObject()) {
                const auto& v = d["settings"];
                auto integer = [&](const char* key, int fallback) { return v.HasMember(key) && v[key].IsInt() ? v[key].GetInt() : fallback; };
                auto boolean = [&](const char* key, bool fallback) { return v.HasMember(key) && v[key].IsBool() ? v[key].GetBool() : fallback; };
                bars = integer("bars",0); if (bars != 2 && bars != 4 && bars != 8 && bars != 12) bars = 0;
                transition = std::clamp(integer("transition",1),0,kTransitionCount - 1);
                // Fade fields (contract 2.5.2): the request wins, then the legacy 'beats' projection, then the current member.
                // Display preferences never travel through configure.
                auto member = [&](const char* key, int low, int high, int current) { return v.HasMember(key) && v[key].IsInt() && v[key].GetInt() >= low && v[key].GetInt() <= high ? v[key].GetInt() : current; };
                if (v.HasMember("fadeTiming") && v["fadeTiming"].IsInt() && v["fadeTiming"].GetInt() >= 0 && v["fadeTiming"].GetInt() <= 6) fadeTiming = v["fadeTiming"].GetInt();
                else if (v.HasMember("beats") && v["beats"].IsInt()) fadeTiming = FadeFromBeats(v["beats"].GetInt());
                fadeRandomSet = member("fadeRandomSet", 1, 31, fadeRandomSet); fadeAnchor = member("fadeAnchor", 0, 2, fadeAnchor); queueQuantize = member("queueQuantize", 0, 3, queueQuantize);
                beats = BeatsFromFade(fadeTiming);
                durationMs = std::clamp(integer("durationMs",2000),250,8000);
                minimumRating = std::clamp(integer("minimumRating",0),0,5);
                automatic=boolean("enabled",true); shuffle=boolean("shuffle",false); keepOld=boolean("keepOld",true);
                manualFade=boolean("manualFade",true); autoFade=boolean("autoFade",true); Settings(); return;
            } else throw std::runtime_error("Unknown library request");
            web->PostWebMessageAsJson(AAAVSLibrary::Wide(response).c_str());
        } catch (const std::exception& error) {
            rapidjson::Document result; result.SetObject(); auto& a=result.GetAllocator();
            result.AddMember("type", "library-error", a); result.AddMember("message", rapidjson::Value(error.what(),a),a);
            result.AddMember("operation", rapidjson::Value(operation.c_str(),a),a);
            web->PostWebMessageAsJson(AAAVSLibrary::Wide(AAAVSLibrary::Json(result)).c_str());
        }
    }
    HWND parent = nullptr;
    HWND host = nullptr;
    bool started = false, closed = false, visible = false, ready = false, failed = false, shuffle = false, pending = false;
    bool automatic = true, keepOld = true, manualFade = true, autoFade = true, preferencesLoaded = false;
    int bars = 0, transition = 1, beats = 0, durationMs = 2000, minimumRating = 0;
    int fadeTiming = -1, fadeRandomSet = 31, fadeAnchor = 0, queueQuantize = 0;   // fadeTiming -1: derive from Beats on first load
    int showFps = 1, timingOverlay = 0, quality = 0, avsResolution = 0, pixelArt = 0;   // device-local display preferences
    ULONGLONG retryAt = 0;
    void Preferences(bool save) {
        auto app = AfxGetApp(); if (!app) return;
        if (save) { if (fadeTiming < 0 || fadeTiming > 6) fadeTiming = FadeFromBeats(beats); beats = BeatsFromFade(fadeTiming); }
        auto value = [&](LPCWSTR key, int current) { if (save) { app->WriteProfileInt(L"AAAVS", key, current); return current; } return int(app->GetProfileInt(L"AAAVS", key, current)); };
        automatic = value(L"Auto", automatic) != 0; shuffle = value(L"Shuffle", shuffle) != 0;
        minimumRating = std::clamp(value(L"MinimumRating", minimumRating), 0, 5);
        keepOld = value(L"KeepOld", keepOld) != 0; manualFade = value(L"ManualFade", manualFade) != 0; autoFade = value(L"AutoFade", autoFade) != 0;
        bars = value(L"Bars", bars); if (bars != 2 && bars != 4 && bars != 8 && bars != 12) bars = 0;
        transition = value(L"Transition", transition); if (transition < 0 || transition > kTransitionCount - 1) transition = 1;
        beats = value(L"Beats", beats); if (beats != 1 && beats != 2 && beats != 4) beats = 0;
        durationMs = value(L"DurationMs", durationMs); if (durationMs < 250 || durationMs > 8000) durationMs = 2000;
        fadeTiming = value(L"FadeTiming", fadeTiming); if (!save && (fadeTiming < 0 || fadeTiming > 6)) fadeTiming = FadeFromBeats(beats);
        fadeRandomSet = std::clamp(value(L"FadeRandomSet", fadeRandomSet), 1, 31);
        fadeAnchor = std::clamp(value(L"FadeAnchor", fadeAnchor), 0, 2);
        queueQuantize = std::clamp(value(L"QueueQuantize", queueQuantize), 0, 3);
        showFps = std::clamp(value(L"ShowFps", showFps), 0, 2);
        timingOverlay = std::clamp(value(L"TimingOverlay", timingOverlay), 0, 1);
        quality = std::clamp(value(L"Quality", quality), 0, 4);
        avsResolution = std::clamp(value(L"AvsResolution", avsResolution), 0, 2);
        pixelArt = std::clamp(value(L"PixelArt", pixelArt), 0, 2);
        beats = BeatsFromFade(fadeTiming);   // legacy projection, always written back
        preferencesLoaded = true;
    }
    void InitializationFailed() {
        ready = false; started = false; failed = true; pending = false; retryAt = GetTickCount64() + 5000;
        if (controller) controller->Close(); web.Reset(); controller.Reset();
        if (host) ShowWindow(host, SW_HIDE);
        OutputDebugString(L"mpc-hc-aaavs: initialization failed; retrying in five seconds.\n");
    }
    void Settings() {
        Preferences(true);
        if (!web) return;
        std::wostringstream json;
        json.imbue(std::locale::classic());
        json << L"{\"type\":\"settings\",\"enabled\":" << (automatic ? L"true" : L"false")
             << L",\"bars\":" << bars << L",\"transition\":" << transition << L",\"beats\":" << beats
             << L",\"shuffle\":" << (shuffle ? L"true" : L"false")
             << L",\"minimumRating\":" << minimumRating
             << L",\"manualFade\":" << (manualFade ? L"true" : L"false") << L",\"autoFade\":" << (autoFade ? L"true" : L"false")
             << L",\"durationMs\":" << durationMs
             << L",\"keepOld\":" << (keepOld ? L"true" : L"false")
             << L",\"fadeTiming\":" << fadeTiming << L",\"fadeRandomSet\":" << fadeRandomSet << L",\"fadeAnchor\":" << fadeAnchor << L",\"queueQuantize\":" << queueQuantize
             << L",\"showFps\":" << showFps << L",\"timingOverlay\":" << timingOverlay
             << L",\"quality\":" << quality << L",\"avsResolution\":" << avsResolution << L",\"pixelArt\":" << pixelArt << L"}";
        web->PostWebMessageAsJson(json.str().c_str());
    }
    // Page-to-native 'display:{...}' string: clamp each present key, persist, and re-send the snapshot.
    void Display(const wchar_t* text) {
        try {
            if (!text || wcslen(text) > 512) return;
            const auto request = AAAVSLibrary::Utf8(text);
            rapidjson::Document d; d.Parse<rapidjson::kParseIterativeFlag>(request.c_str());
            if (d.HasParseError() || !d.IsObject()) return;
            auto apply = [&](const char* key, int& target, int high) { if (d.HasMember(key) && d[key].IsInt()) target = std::clamp(d[key].GetInt(), 0, high); };
            apply("quality", quality, 4); apply("avsResolution", avsResolution, 2); apply("pixelArt", pixelArt, 2);
            apply("showFps", showFps, 2); apply("timingOverlay", timingOverlay, 1);
            Settings();
        } catch (...) {}
    }
    ULONGLONG sent = 0;
    unsigned long long audioSequence = 0;
    unsigned audioDrops = 0;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> web;
};
AAAVSView::AAAVSView() : state(std::make_shared<State>()) {}
AAAVSView::~AAAVSView() { Close(); }
bool AAAVSView::Ready() const { return state->ready && state->visible; }
bool AAAVSView::PanelOpen() const { return state->panel != 0; }
bool AAAVSView::IsHostWindow(HWND window) {
    wchar_t name[64]{};
    return GetClassNameW(window, name, _countof(name)) && wcscmp(name, kHostClass) == 0;
}
bool AAAVSView::Shuffle() const { return state->shuffle; }
bool AAAVSView::Automatic() const { return state->automatic; }
void AAAVSView::Close() {
    state->closed = true;
    state->ready = false;
    if (state->controller) state->controller->Close();
    state->web.Reset();
    state->controller.Reset();
    if (state->host) { DestroyWindow(state->host); state->host = nullptr; }
}
void AAAVSView::Resize() {
    // The wrapper exists before the WebView controller does; resize it independently so its clipping bounds
    // follow the artwork area while creation is pending. The controller completion resynchronizes both.
    if (!IsWindow(state->parent)) return;
    RECT bounds; GetClientRect(state->parent, &bounds);
    if (state->host) MoveWindow(state->host, 0, 0, bounds.right, bounds.bottom, TRUE);
    if (state->controller) state->controller->put_Bounds(bounds);
}
void AAAVSView::Command(UINT command) {
    if (command == ID_AAAVS_MANAGER || command == ID_AAAVS_SETUPS) {
        const int panel = command == ID_AAAVS_MANAGER ? 1 : 2;
        state->panel = state->panel == panel ? 0 : panel;
        if (state->panel) state->failed = false;
        if (state->web && state->ready) {
            const auto json = L"{\"type\":\"panel\",\"panel\":" + std::to_wstring(state->panel) + L"}";
            state->web->PostWebMessageAsJson(json.c_str());
        }
        return;
    }
    if (!Ready()) return;
    if (command == ID_AAAVS_RATE_DOWN || command == ID_AAAVS_RATE_UP) {
        state->web->PostWebMessageAsJson(command == ID_AAAVS_RATE_UP ? L"{\"type\":\"rate\",\"delta\":1}" : L"{\"type\":\"rate\",\"delta\":-1}"); return;
    }
    if (command == ID_AAAVS_NOT_WORKING) {
        state->web->PostWebMessageAsJson(L"{\"type\":\"not-working\"}"); return;
    }
    if (command == ID_AAAVS_PLAY_FOLDER) { state->web->PostWebMessageAsJson(L"{\"type\":\"play-folder\"}"); return; }
    if (command == ID_AAAVS_OPTIONS) { Options(); return; }
    if (command == ID_AAAVS_AUTO) { state->automatic = !state->automatic; state->Settings(); return; }
    if (command == ID_AAAVS_SHUFFLE) {
        state->shuffle = !state->shuffle;
        state->Settings();
    } else if (command == ID_AAAVS_PREVIOUS || command == ID_AAAVS_NEXT) {
        state->web->PostWebMessageAsJson(command == ID_AAAVS_PREVIOUS ? L"{\"type\":\"previous\"}" : L"{\"type\":\"next\"}");
    }
}
void AAAVSView::Tick(HWND parent, bool visible, bool playing, LONGLONG position, LONGLONG duration) {
    auto s = state;
    visible = visible || s->panel != 0;
    if (s->closed) return;
    s->parent = parent;
    s->visible = visible;
    if (!s->preferencesLoaded) s->Preferences(false);
    if (!s->started && visible && GetTickCount64() >= s->retryAt) {
        s->started = true;
        const auto base = ProgramFolder();
        if (base.empty()) { s->InitializationFailed(); return; }
        const auto folder = base + L"visualizer";
        const auto page = folder + L"\\mpc.html";
        if (GetFileAttributesW(page.c_str()) == INVALID_FILE_ATTRIBUTES) { s->InitializationFailed(); return; }
        const auto profile = base + L"AAAVS.WebView2";
        // MPC disables renderer children during graph setup. Keep the interactive
        // WebView in a distinct child so that setup can leave its input enabled.
        if (!s->host) {
            WNDCLASSW wc{}; wc.lpfnWndProc = DefWindowProcW;
            wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = kHostClass;
            wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
            if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) { s->InitializationFailed(); return; }
            RECT bounds; GetClientRect(parent, &bounds);
            s->host = CreateWindowExW(0, kHostClass, L"", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0, 0, bounds.right, bounds.bottom, parent, nullptr, wc.hInstance, nullptr);
            if (!s->host) { s->InitializationFailed(); return; }
        }
        HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, profile.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([s, folder](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (s->closed) return S_OK;
                if (FAILED(result) || !env) { s->InitializationFailed(); return S_OK; }
                const HRESULT creation = env->CreateCoreWebView2Controller(s->host,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([s, folder](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                        if (s->closed || FAILED(result) || !controller) { if (controller) controller->Close(); if (!s->closed) s->InitializationFailed(); return S_OK; }
                        s->controller = controller;
                        controller->get_CoreWebView2(&s->web);
                        ComPtr<ICoreWebView2_3> local;
                        if (!s->web || FAILED(s->web.As(&local)) || FAILED(local->SetVirtualHostNameToFolderMapping(L"aaavs.invalid", folder.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS))) {
                            s->InitializationFailed(); return S_OK;
                        }
                        ComPtr<ICoreWebView2Settings> settings;
                        if (FAILED(s->web->get_Settings(&settings)) || !settings) { s->InitializationFailed(); return S_OK; }
                        settings->put_AreDefaultContextMenusEnabled(FALSE);
                        settings->put_AreDevToolsEnabled(FALSE);
                        settings->put_IsStatusBarEnabled(FALSE);
                        EventRegistrationToken token;
                        s->web->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                            LPWSTR uri = nullptr; args->get_Uri(&uri);
                            if (!uri || wcscmp(uri, L"https://aaavs.invalid/mpc.html") != 0) args->put_Cancel(TRUE);
                            CoTaskMemFree(uri); return S_OK;
                        }).Get(), &token);
                        s->web->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT { args->put_Handled(TRUE); return S_OK; }).Get(), &token);
                        std::weak_ptr<State> weak = s;
                        s->web->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>([weak](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
                            auto s = weak.lock(); if (s && !s->closed) s->InitializationFailed(); return S_OK;
                        }).Get(), &token);
                        s->web->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([weak](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                            BOOL success = FALSE; args->get_IsSuccess(&success);
                            auto s = weak.lock(); if (!success && s && !s->closed) s->InitializationFailed(); return S_OK;
                        }).Get(), &token);
                        s->web->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([weak](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                            auto s = weak.lock(); if (!s || s->closed) return S_OK;
                            LPWSTR source = nullptr; args->get_Source(&source);
                            const bool trusted = source && wcscmp(source, L"https://aaavs.invalid/mpc.html") == 0;
                            CoTaskMemFree(source); if (!trusted) return S_OK;
                            LPWSTR message = nullptr;
                            if (SUCCEEDED(args->TryGetWebMessageAsString(&message)) && message) {
                                if (wcscmp(message, L"bootstrap-error") == 0) { s->ready = false; s->failed = false; s->controller->put_IsVisible(s->visible); }
                                if (wcscmp(message, L"ready") == 0) { s->ready = true; s->failed = false; s->controller->put_IsVisible(s->visible); }
                                if (wcscmp(message, L"host-ready") == 0) { s->ready = true; s->pending = false; s->Settings(); if (s->panel) { const auto json=L"{\"type\":\"panel\",\"panel\":"+std::to_wstring(s->panel)+L"}";s->web->PostWebMessageAsJson(json.c_str()); } }
                                if (wcsncmp(message, L"library:", 8) == 0) s->Library(message + 8);
                                if (wcscmp(message, L"panel-close") == 0) s->panel = 0;
                                if (wcscmp(message, L"panel-state:0") == 0) s->panel = 0;
                                if (wcscmp(message, L"panel-state:1") == 0) s->panel = 1;
                                if (wcscmp(message, L"panel-state:2") == 0) s->panel = 2;
                                if (wcscmp(message, L"show-manager") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_MANAGER, 0);
                                if (wcscmp(message, L"show-setups") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_SETUPS, 0);
                                if (wcscmp(message, L"rate-up") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_RATE_UP, 0);
                                if (wcscmp(message, L"rate-down") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_RATE_DOWN, 0);
                                if (wcscmp(message, L"mark-not-working") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_NOT_WORKING, 0);
                                if (wcscmp(message, L"options") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_OPTIONS, 0);
                                if (wcscmp(message, L"play-folder") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_AAAVS_PLAY_FOLDER, 0);
                                if (wcsncmp(message, L"display:", 8) == 0) s->Display(message + 8);
                                if (wcscmp(message, L"ack") == 0) s->pending = false;
                                if (wcscmp(message, L"play-pause") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_PLAY_PLAYPAUSE, 0);
                                if (wcscmp(message, L"fullscreen") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_VIEW_FULLSCREEN, 0);
                                if (wcscmp(message, L"error") == 0) {
                                    // A preset failure must not dismiss the manager used to recover from it.
                                    s->failed = s->panel == 0;
                                    s->controller->put_IsVisible(s->visible && !s->failed);
                                }
                            }
                            CoTaskMemFree(message); return S_OK;
                        }).Get(), &token);
                        // Resynchronize the wrapper and the controller to the current artwork area: resizes
                        // during creation moved only the wrapper, and the parent may have changed since.
                        RECT bounds; GetClientRect(s->parent, &bounds);
                        if (s->host) MoveWindow(s->host, 0, 0, bounds.right, bounds.bottom, TRUE);
                        controller->put_Bounds(bounds);
                        controller->put_IsVisible(FALSE);
                        const HRESULT navigation = s->web->Navigate(L"https://aaavs.invalid/mpc.html");
                        if (FAILED(navigation)) s->InitializationFailed();
                        return S_OK;
                    }).Get());
                if (FAILED(creation)) s->InitializationFailed();
                return S_OK;
            }).Get());
        if (FAILED(hr)) s->InitializationFailed();
    }
    if (!s->controller) return;
    ShowWindow(s->host, visible && !s->failed ? SW_SHOWNOACTIVATE : SW_HIDE);
    s->controller->put_IsVisible(visible && !s->failed);
    if (!s->ready) return;
    if (s->pending && GetTickCount64() - s->sent < 1000) return;
    auto batch = AAAVS::Tap().ReadBatch(position, s->audioSequence, s->audioDrops);
    const auto& frame = batch.sample;
    std::wostringstream json;
    json.imbue(std::locale::classic());
    json.precision(10);
    json << L"{\"type\":\"audio\",\"playing\":" << (visible && playing ? L"true" : L"false")
         << L",\"visible\":" << (visible ? L"true" : L"false")
         << L",\"position\":" << position / 10000000.0;
    // Track length in seconds; omitted when unknown (contract 2.2.4, AUDIO_DURATION_MAX = 86400).
    if (duration > 0 && duration / 10000000.0 <= 86400.0) json << L",\"duration\":" << duration / 10000000.0;
    json << L",\"epoch\":" << frame.epoch << L",\"pcm\":[";
    for (size_t i = 0; i < frame.pcm.size(); ++i) { if (i) json << L','; json << (visible && playing ? frame.pcm[i] : 0); }
    json << L"],\"discontinuity\":" << (batch.discontinuity ? L"true" : L"false") << L",\"frames\":[";
    if (visible && playing) for (size_t n = 0; n < batch.count; ++n) {
        if (n) json << L',';
        json << L"{\"time\":" << batch.frames[n].time / 10000000.0 << L",\"sampleRate\":" << batch.frames[n].sampleRate
             << L",\"samples\":" << batch.frames[n].samples << L",\"pcm\":[";
        for (size_t i = 0; i < batch.frames[n].pcm.size(); ++i) { if (i) json << L','; json << batch.frames[n].pcm[i]; }
        json << L"]}";
    }
    json << L"]}";
    s->pending = SUCCEEDED(s->web->PostWebMessageAsJson(json.str().c_str()));
    if (s->pending) s->audioDrops = batch.drops;
    if (s->pending && batch.count) s->audioSequence = batch.frames[batch.count - 1].sequence;
    s->sent = GetTickCount64();
}

void AAAVSView::Options() {
    if (!Ready()) return;
    auto& st = *state;
    HMENU menu = CreatePopupMenu(), phrases = CreatePopupMenu(), styles = CreatePopupMenu(), classic = CreatePopupMenu(), scenes = CreatePopupMenu(), timings = CreatePopupMenu(), includes = CreatePopupMenu();
    HMENU anchors = CreatePopupMenu(), queues = CreatePopupMenu(), durations = CreatePopupMenu(), ratings = CreatePopupMenu(), qualities = CreatePopupMenu(), resolutions = CreatePopupMenu(), pixels = CreatePopupMenu();
    const int bars[] = {0, 2, 4, 8, 12};
    const wchar_t* phraseNames[] = {L"Adaptive (2-12 bars)", L"2 bars", L"4 bars", L"8 bars", L"12 bars"};
    for (int i = 0; i < 5; ++i) AppendMenuW(phrases, MF_STRING | (st.bars == bars[i] ? MF_CHECKED : 0), 1 + i, phraseNames[i]);
    // Styles come from the generated table: special selectors first, then the two grouped submenus (IDs 100-132).
    for (int i = 0; i < kTransitionCount; ++i) {
        const HMENU target = kTransitionGroup[i] == 0 ? classic : kTransitionGroup[i] == 1 ? scenes : styles;
        AppendMenuW(target, MF_STRING | (st.transition == i ? MF_CHECKED : 0), kTransitionMenuBase + i, kTransitionNames[i]);
    }
    AppendMenuW(styles, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(styles, MF_POPUP, (UINT_PTR)classic, L"Classic AVS styles");
    AppendMenuW(styles, MF_POPUP, (UINT_PTR)scenes, L"NERV and HUD styles");
    const wchar_t* timingNames[] = {L"Seconds (uses Fixed duration)", L"Instant", L"1 beat", L"2 beats", L"1 bar", L"2 bars", L"Random"};
    for (int i = 0; i < 7; ++i) AppendMenuW(timings, MF_STRING | (st.fadeTiming == i ? MF_CHECKED : 0), 80 + i, timingNames[i]);
    const wchar_t* includeNames[] = {L"Instant", L"1 beat", L"2 beats", L"1 bar", L"2 bars"};
    for (int i = 0; i < 5; ++i) AppendMenuW(includes, MF_STRING | ((st.fadeRandomSet >> i) & 1 ? MF_CHECKED : 0), 90 + i, includeNames[i]);
    const wchar_t* anchorNames[] = {L"Scene boundary starts it", L"Scene boundary ends it", L"Scene boundary is the peak"};
    // The shared host currently starts transitions at the boundary. Preserve stored choices until end/peak scheduling is implemented.
    for (int i = 0; i < 3; ++i) AppendMenuW(anchors, MF_STRING | (i > 0 ? MF_GRAYED : 0) | (st.fadeAnchor == i ? MF_CHECKED : 0), 95 + i, anchorNames[i]);
    const wchar_t* queueNames[] = {L"Immediately", L"Next beat", L"Next bar", L"Next phrase"};
    // Quantized manual changes are deferred; only Immediately is supported by the shared host.
    for (int i = 0; i < 4; ++i) AppendMenuW(queues, MF_STRING | (i > 0 ? MF_GRAYED : 0) | (st.queueQuantize == i ? MF_CHECKED : 0), 56 + i, queueNames[i]);
    const int milliseconds[] = {250, 500, 1000, 2000, 4000, 8000};
    const wchar_t* fixedNames[] = {L"0.25 seconds", L"0.5 seconds", L"1 second", L"2 seconds", L"4 seconds", L"8 seconds"};
    for (int i = 0; i < 6; ++i) AppendMenuW(durations, MF_STRING | (st.fadeTiming == 0 && st.durationMs == milliseconds[i] ? MF_CHECKED : 0), 60 + i, fixedNames[i]);
    const wchar_t* ratingNames[] = {L"All ratings (including unrated)", L"1 star or higher", L"2 stars or higher", L"3 stars or higher", L"4 stars or higher", L"5 stars"};
    for (int i = 0; i < 6; ++i) AppendMenuW(ratings, MF_STRING | (st.minimumRating == i ? MF_CHECKED : 0), 70 + i, ratingNames[i]);
    const wchar_t* qualityNames[] = {L"Auto", L"Performance", L"Balanced", L"High", L"Native (up to 4K)"};
    for (int i = 0; i < 5; ++i) AppendMenuW(qualities, MF_STRING | (st.quality == i ? MF_CHECKED : 0), 200 + i, qualityNames[i]);
    const wchar_t* resolutionNames[] = {L"Classic", L"Crisp", L"High (experimental)"};
    for (int i = 0; i < 3; ++i) AppendMenuW(resolutions, MF_STRING | (st.avsResolution == i ? MF_CHECKED : 0), 210 + i, resolutionNames[i]);
    const wchar_t* pixelNames[] = {L"Auto", L"Integer", L"Smooth"};
    for (int i = 0; i < 3; ++i) AppendMenuW(pixels, MF_STRING | (st.pixelArt == i ? MF_CHECKED : 0), 220 + i, pixelNames[i]);
    const wchar_t* fpsNames[] = {L"Show frame rate: off", L"Show frame rate: FPS", L"Show frame rate: FPS and detail"};
    AppendMenuW(menu, MF_STRING | (st.automatic ? MF_CHECKED : 0), 50, L"Automatic preset switching");
    AppendMenuW(menu, MF_STRING | (st.showFps ? MF_CHECKED : 0), 54, fpsNames[st.showFps]);
    AppendMenuW(menu, MF_STRING | (st.timingOverlay ? MF_CHECKED : 0), 55, L"Timing overlay always visible");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)ratings, L"Shuffle minimum rating");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)phrases, L"Phrase length");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)styles, L"Transition style");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)timings, L"Transition timing");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)includes, L"Random timing includes");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)anchors, L"Transition lands");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)durations, L"Fixed duration");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)queues, L"Manual preset changes take effect");
    AppendMenuW(menu, MF_STRING | (st.manualFade ? MF_CHECKED : 0), 52, L"Transitions on manual preset changes");
    AppendMenuW(menu, MF_STRING | (st.autoFade ? MF_CHECKED : 0), 53, L"Transitions on automatic preset changes");
    AppendMenuW(menu, MF_STRING | (st.keepOld ? MF_CHECKED : 0), 51, L"Keep outgoing preset animating");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)qualities, L"Render quality");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)resolutions, L"AVS resolution");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)pixels, L"Pixel-art scaling");
    POINT point; GetCursorPos(&point);
    const UINT choice = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0, GetParent(st.parent), nullptr);
    DestroyMenu(menu);   // also destroys the attached submenus
    if (choice >= 1 && choice <= 5) st.bars = bars[choice - 1];
    if (choice >= 100 && choice < 100 + kTransitionCount) st.transition = int(choice) - 100;
    if (choice >= 80 && choice <= 86) { st.fadeTiming = int(choice) - 80; st.beats = BeatsFromFade(st.fadeTiming); }
    if (choice >= 90 && choice <= 94) { const int next = st.fadeRandomSet ^ (1 << (choice - 90)); if (next & 31) st.fadeRandomSet = next; }   // never clear the last bit
    if (choice >= 95 && choice <= 97) st.fadeAnchor = int(choice) - 95;
    if (choice >= 56 && choice <= 59) st.queueQuantize = int(choice) - 56;
    if (choice >= 60 && choice <= 65) { st.fadeTiming = 0; st.beats = 0; st.durationMs = milliseconds[choice - 60]; }
    if (choice >= 70 && choice <= 75) st.minimumRating = choice - 70;
    if (choice >= 200 && choice <= 204) st.quality = int(choice) - 200;
    if (choice >= 210 && choice <= 212) st.avsResolution = int(choice) - 210;
    if (choice >= 220 && choice <= 222) st.pixelArt = int(choice) - 220;
    if (choice == 54) st.showFps = (st.showFps + 1) % 3;
    if (choice == 55) st.timingOverlay = st.timingOverlay ? 0 : 1;
    if (choice == 52) st.manualFade = !st.manualFade;
    if (choice == 53) st.autoFade = !st.autoFade;
    if (choice == 50) st.automatic = !st.automatic;
    if (choice == 51) st.keepOld = !st.keepOld;
    if (choice) st.Settings();
}
