#pragma once
#include <memory>

// Owned by the existing artwork/video child window, on the UI thread.
class AAAVSView {
    struct State;
    std::shared_ptr<State> state;
public:
    AAAVSView();
    ~AAAVSView();
    void Tick(HWND parent, bool visible, bool playing, LONGLONG position, LONGLONG duration = 0);
    void Resize();
    void Close();
    void Command(UINT command);
    bool Ready() const;
    bool PanelOpen() const;
    static bool IsHostWindow(HWND window);
    bool Shuffle() const;
    bool Automatic() const;
    void Options();
};
