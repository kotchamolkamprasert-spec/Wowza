#pragma once

#include <memory>
#include <string>

#include "event.hpp"
#include "queue.hpp"

// Backend-agnostic front end. The header stays pure C++ so the rest of the
// program never sees Objective-C; the macOS implementation is ble_hub_mac.mm.
class BleHub {
public:
    explicit BleHub(BlockingQueue<InputEvent>& queue);
    ~BleHub();

    BleHub(const BleHub&)            = delete;
    BleHub& operator=(const BleHub&) = delete;

    void addPlayer(int player, std::string deviceName);

    // Non-blocking. The radio comes up asynchronously; poll status() for a
    // human-readable state. Blocking here would freeze the window for the
    // whole time the OS permission dialog is on screen.
    void        start();
    std::string status() const;
    void        stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
