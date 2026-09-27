#pragma once
#include <memory>

// Owned by the existing artwork/video child window, on the UI thread.
class AAAVSView {
    struct State;
    std::shared_ptr<State> state;
public:
    AAAVSView();
    ~AAAVSView();
    void Tick(HWND parent, bool visible, bool playing, LONGLONG position);
    void Resize();
    void Close();
    void Command(UINT command);
    bool Ready() const;
    bool Shuffle() const;
    bool Automatic() const;
    void Options();
};
