#pragma once

#include <condition_variable>
#include <mutex>
#include <queue>
#include <utility>

// Producer/consumer handoff between the BLE threads and the game loop.
template <typename T>
class BlockingQueue {
public:
    void push(T item) {
        {
            std::lock_guard<std::mutex> lock(mu_);
            q_.push(std::move(item));
        }
        cv_.notify_one();
    }

    // Non-blocking. This is what a game loop uses: never stall a frame
    // waiting on input that may not come.
    bool try_pop(T& out) {
        std::lock_guard<std::mutex> lock(mu_);
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop();
        return true;
    }

    // Blocking. Returns false once closed and drained.
    bool pop(T& out) {
        std::unique_lock<std::mutex> lock(mu_);
        cv_.wait(lock, [this] { return !q_.empty() || closed_; });
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop();
        return true;
    }

    void close() {
        {
            std::lock_guard<std::mutex> lock(mu_);
            closed_ = true;
        }
        cv_.notify_all();
    }

private:
    mutable std::mutex      mu_;
    std::condition_variable cv_;
    std::queue<T>           q_;
    bool                    closed_ = false;
};
