#define NOMINMAX
#include <Windows.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include "AAAVSView.h"
#include "../DSUtil/AAAVSAudio.h"
#include "resource.h"
#include <WebView2.h>
#include <wrl.h>
#include <sstream>
#include <locale>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;
static std::wstring ProgramFolder() {
    wchar_t path[32768]{};
    const DWORD length = GetModuleFileNameW(nullptr, path, _countof(path));
    if (!length || length == _countof(path)) return L"";
    std::wstring result(path, length);
    return result.substr(0, result.find_last_of(L"\\/") + 1);
}
struct AAAVSView::State {
    HWND parent = nullptr;
    bool started = false, closed = false, visible = false, ready = false, failed = false, shuffle = false, pending = false;
    bool automatic = true, keepOld = true;
    int bars = 0, transition = 1, beats = 0;
    void Settings() {
        if (!web) return;
        std::wostringstream json;
        json << L"{\"type\":\"settings\",\"enabled\":" << (automatic ? L"true" : L"false")
             << L",\"bars\":" << bars << L",\"transition\":" << transition << L",\"beats\":" << beats
             << L",\"keepOld\":" << (keepOld ? L"true" : L"false") << L"}";
        web->PostWebMessageAsJson(json.str().c_str());
    }
    ULONGLONG sent = 0;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> web;
};
AAAVSView::AAAVSView() : state(std::make_shared<State>()) {}
AAAVSView::~AAAVSView() { Close(); }
bool AAAVSView::Ready() const { return state->ready && state->visible; }
bool AAAVSView::Shuffle() const { return state->shuffle; }
bool AAAVSView::Automatic() const { return state->automatic; }
void AAAVSView::Close() {
    state->closed = true;
    state->ready = false;
    if (state->controller) state->controller->Close();
    state->web.Reset();
    state->controller.Reset();
}
void AAAVSView::Resize() {
    if (state->controller && IsWindow(state->parent)) {
        RECT bounds; GetClientRect(state->parent, &bounds);
        state->controller->put_Bounds(bounds);
    }
}
void AAAVSView::Command(UINT command) {
    if (!Ready()) return;
    if (command == ID_AAAVS_OPTIONS) { Options(); return; }
    if (command == ID_AAAVS_AUTO) { state->automatic = !state->automatic; state->Settings(); return; }
    if (command == ID_AAAVS_SHUFFLE) {
        state->shuffle = !state->shuffle;
        state->web->PostWebMessageAsJson(state->shuffle ? L"{\"type\":\"shuffle\",\"enabled\":true}" : L"{\"type\":\"shuffle\",\"enabled\":false}");
    } else {
        state->web->PostWebMessageAsJson(command == ID_AAAVS_PREVIOUS ? L"{\"type\":\"previous\"}" : L"{\"type\":\"next\"}");
    }
}
void AAAVSView::Tick(HWND parent, bool visible, bool playing, LONGLONG position) {
    auto s = state;
    if (s->closed) return;
    s->parent = parent;
    s->visible = visible;
    if (!s->started && visible) {
        s->started = true;
        const auto base = ProgramFolder();
        if (base.empty()) return;
        const auto folder = base + L"visualizer";
        const auto page = folder + L"\\mpc.html";
        if (GetFileAttributesW(page.c_str()) == INVALID_FILE_ATTRIBUTES) return;
        const auto profile = base + L"AAAVS.WebView2";
        HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, profile.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([s, folder](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (s->closed || FAILED(result) || !env) return S_OK;
                return env->CreateCoreWebView2Controller(s->parent,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([s, folder](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                        if (s->closed || FAILED(result) || !controller) { if (controller) controller->Close(); return S_OK; }
                        s->controller = controller;
                        controller->get_CoreWebView2(&s->web);
                        ComPtr<ICoreWebView2_3> local;
                        if (!s->web || FAILED(s->web.As(&local)) || FAILED(local->SetVirtualHostNameToFolderMapping(L"aaavs.invalid", folder.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS))) {
                            controller->Close(); s->controller.Reset(); s->web.Reset(); return S_OK;
                        }
                        ComPtr<ICoreWebView2Settings> settings;
                        s->web->get_Settings(&settings);
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
                        s->web->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([weak](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                            auto s = weak.lock(); if (!s || s->closed) return S_OK;
                            LPWSTR source = nullptr; args->get_Source(&source);
                            const bool trusted = source && wcscmp(source, L"https://aaavs.invalid/mpc.html") == 0;
                            CoTaskMemFree(source); if (!trusted) return S_OK;
                            LPWSTR message = nullptr;
                            if (SUCCEEDED(args->TryGetWebMessageAsString(&message)) && message) {
                                if (wcscmp(message, L"ready") == 0) { s->ready = true; s->failed = false; s->controller->put_IsVisible(s->visible); }
                                if (wcscmp(message, L"host-ready") == 0) s->Settings();
                                if (wcscmp(message, L"ack") == 0) s->pending = false;
                                if (wcscmp(message, L"play-pause") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_PLAY_PLAYPAUSE, 0);
                                if (wcscmp(message, L"fullscreen") == 0) ::PostMessage(GetParent(s->parent), WM_COMMAND, ID_VIEW_FULLSCREEN, 0);
                                if (wcscmp(message, L"error") == 0) { s->ready = true; s->failed = true; s->controller->put_IsVisible(FALSE); }
                            }
                            CoTaskMemFree(message); return S_OK;
                        }).Get(), &token);
                        RECT bounds; GetClientRect(s->parent, &bounds); controller->put_Bounds(bounds);
                        controller->put_IsVisible(FALSE);
                        return s->web->Navigate(L"https://aaavs.invalid/mpc.html");
                    }).Get());
            }).Get());
        if (FAILED(hr)) OutputDebugString(L"MPC-AAAVS: WebView2 initialization failed; retaining artwork.\n");
    }
    if (!s->controller || !s->ready) return;
    s->controller->put_IsVisible(visible && !s->failed);
    if (s->pending && GetTickCount64() - s->sent < 1000) return;
    auto frame = AAAVS::Tap().Read(position);
    std::wostringstream json;
    json.imbue(std::locale::classic());
    json.precision(10);
    json << L"{\"type\":\"audio\",\"playing\":" << (visible && playing ? L"true" : L"false")
         << L",\"position\":" << position / 10000000.0 << L",\"epoch\":" << frame.epoch << L",\"pcm\":[";
    for (size_t i = 0; i < frame.pcm.size(); ++i) { if (i) json << L','; json << (visible && playing ? frame.pcm[i] : 0); }
    json << L"]}";
    s->pending = SUCCEEDED(s->web->PostWebMessageAsJson(json.str().c_str()));
    s->sent = GetTickCount64();
}

void AAAVSView::Options() {
    if (!Ready()) return;
    HMENU menu = CreatePopupMenu(), phrases = CreatePopupMenu(), effects = CreatePopupMenu(), durations = CreatePopupMenu();
    const int bars[] = {0, 2, 4, 8, 12};
    const wchar_t* phraseNames[] = {L"Adaptive (2-12 bars)", L"2 bars", L"4 bars", L"8 bars", L"12 bars"};
    for (int i = 0; i < 5; ++i) AppendMenuW(phrases, MF_STRING | (state->bars == bars[i] ? MF_CHECKED : 0), 1 + i, phraseNames[i]);
    const wchar_t* names[] = {L"Random", L"Cross dissolve", L"L/R Push", L"R/L Push", L"T/B Push", L"B/T Push", L"9 Random Blocks", L"Split L/R Push", L"L/R to Center Push", L"L/R to Center Squeeze", L"L/R Wipe", L"R/L Wipe", L"T/B Wipe", L"B/T Wipe", L"Dot Dissolve", L"Cut"};
    for (int i = 0; i < 16; ++i) AppendMenuW(effects, MF_STRING | (state->transition == i ? MF_CHECKED : 0), 20 + i, names[i]);
    const int beats[] = {0, 1, 2, 4};
    const wchar_t* durationsText[] = {L"Classic (2 seconds)", L"1 beat", L"2 beats", L"4 beats"};
    for (int i = 0; i < 4; ++i) AppendMenuW(durations, MF_STRING | (state->beats == beats[i] ? MF_CHECKED : 0), 40 + i, durationsText[i]);
    AppendMenuW(menu, MF_STRING | (state->automatic ? MF_CHECKED : 0), 50, L"Automatic preset switching");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)phrases, L"Phrase length");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)effects, L"AVS transition");
    AppendMenuW(menu, MF_POPUP, (UINT_PTR)durations, L"Transition duration");
    AppendMenuW(menu, MF_STRING | (state->keepOld ? MF_CHECKED : 0), 51, L"Keep outgoing preset animating");
    POINT point; GetCursorPos(&point);
    const UINT choice = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0, GetParent(state->parent), nullptr);
    DestroyMenu(menu);
    if (choice >= 1 && choice <= 5) state->bars = bars[choice - 1];
    if (choice >= 20 && choice <= 35) state->transition = choice - 20;
    if (choice >= 40 && choice <= 43) state->beats = beats[choice - 40];
    if (choice == 50) state->automatic = !state->automatic;
    if (choice == 51) state->keepOld = !state->keepOld;
    if (choice) state->Settings();
}
