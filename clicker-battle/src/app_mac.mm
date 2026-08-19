// Native macOS window. AppKit ships with the OS, so this costs nothing to
// build -- same deal as CoreBluetooth. Objective-C++ again: the window and
// drawing are Objective-C, the game state underneath is plain C++.

#import <Cocoa/Cocoa.h>

#include <string>

#include "ble_hub.hpp"
#include "event.hpp"
#include "game.hpp"
#include "queue.hpp"

// ------------------------------------------------------------------ theme

static NSColor* rgb(int hex) {
    return [NSColor colorWithSRGBRed:((hex >> 16) & 0xFF) / 255.0
                               green:((hex >>  8) & 0xFF) / 255.0
                                blue:((hex >>  0) & 0xFF) / 255.0
                               alpha:1.0];
}

#define C_BG     rgb(0x12141A)
#define C_TRACK  rgb(0x232834)
#define C_TEXT   rgb(0xE8ECF4)
#define C_DIM    rgb(0x76829A)
#define C_P1     rgb(0x35D6FF)
#define C_P2     rgb(0xFF6FD8)
#define C_GOLD   rgb(0xFFC857)
#define C_GREEN  rgb(0x4ADE80)
#define C_RED    rgb(0xFF6B6B)

// ---------------------------------------------------------------- helpers

static std::string commas(long v) {
    std::string s = std::to_string(v);
    for (int i = (int)s.size() - 3; i > 0; i -= 3) s.insert(i, ",");
    return s;
}

static NSString* fmt(const char* f, double v) {
    return [NSString stringWithFormat:@(f), v];
}

static void drawText(NSString* s, NSRect r, NSFont* font, NSColor* color, NSTextAlignment align) {
    NSMutableParagraphStyle* ps = [NSMutableParagraphStyle new];
    ps.alignment = align;
    [s drawInRect:r withAttributes:@{
        NSFontAttributeName            : font,
        NSForegroundColorAttributeName : color,
        NSParagraphStyleAttributeName  : ps,
    }];
}

static void drawBar(NSRect r, double frac, NSColor* color) {
    const CGFloat radius = r.size.height / 2.0;

    NSBezierPath* track = [NSBezierPath bezierPathWithRoundedRect:r xRadius:radius yRadius:radius];
    [C_TRACK setFill];
    [track fill];

    const CGFloat w = r.size.width * MAX(0.0, MIN(1.0, frac));
    if (w < r.size.height) return;   // too short to render as a rounded pill

    NSRect fill = NSMakeRect(r.origin.x, r.origin.y, w, r.size.height);
    NSBezierPath* bar = [NSBezierPath bezierPathWithRoundedRect:fill xRadius:radius yRadius:radius];
    [color setFill];
    [bar fill];
}

// ------------------------------------------------------------------- view

@interface GameView : NSView
- (instancetype)initWithFrame:(NSRect)frame
                         game:(Game*)game
                        queue:(BlockingQueue<InputEvent>*)queue
                          hub:(BleHub*)hub;
@end

@implementation GameView {
    Game*                      _game;
    BlockingQueue<InputEvent>* _queue;
    BleHub*                    _hub;
    TimePoint                  _prev;
    double                     _accum;
    unsigned long              _seq[kNumPlayers];
    NSTimer*                   _timer;
}

- (instancetype)initWithFrame:(NSRect)frame
                         game:(Game*)game
                        queue:(BlockingQueue<InputEvent>*)queue
                          hub:(BleHub*)hub {
    if (!(self = [super initWithFrame:frame])) return nil;

    _game  = game;
    _queue = queue;
    _hub   = hub;
    _prev  = Clock::now();
    _accum = 0.0;

    _timer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 60.0
                                              target:self
                                            selector:@selector(tick:)
                                            userInfo:nil
                                             repeats:YES];
    // Common modes: without this the timer stalls while a menu is open or the
    // window is being resized, and the round clock would freeze with it.
    [[NSRunLoop currentRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
    return self;
}

// Top-left origin, so layout maths reads the way it looks on screen.
- (BOOL)isFlipped          { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }

- (void)tick:(NSTimer*)t {
    const auto now = Clock::now();
    double frame = std::chrono::duration<double>(now - _prev).count();
    _prev = now;
    if (frame > 0.25) frame = 0.25;
    _accum += frame;

    InputEvent e;
    while (_queue->try_pop(e)) _game->onEvent(e);

    const double kTick = 1.0 / 60.0;
    while (_accum >= kTick) { _game->update(kTick, now); _accum -= kTick; }

    [self setNeedsDisplay:YES];
}

// Keyboard works alongside the ESP32s -- handy for testing with one board,
// or none.
- (int)playerForEvent:(NSEvent*)event {
    NSString* chars = event.charactersIgnoringModifiers;
    if (chars.length == 0) return -1;
    switch ([chars characterAtIndex:0]) {
        case 'a': case 'A': return 0;
        case 'l': case 'L': return 1;
        default:            return -1;
    }
}

- (void)keyDown:(NSEvent*)event {
    // Ignore auto-repeat: holding the key down would otherwise be a free
    // autoclicker, which rather defeats the point.
    if (event.isARepeat) return;
    const int p = [self playerForEvent:event];
    if (p < 0) return;
    _queue->push(InputEvent{p, InputEvent::Type::Press, ++_seq[p], Clock::now()});
}

- (void)keyUp:(NSEvent*)event {
    const int p = [self playerForEvent:event];
    if (p < 0) return;
    _queue->push(InputEvent{p, InputEvent::Type::Release, 0, Clock::now()});
}

- (void)drawPlayer:(int)idx atY:(CGFloat)y color:(NSColor*)color peak:(long)peak {
    const PlayerState& p = _game->player(idx);
    const CGFloat W = self.bounds.size.width;

    NSFont* nameFont  = [NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
    NSFont* scoreFont = [NSFont monospacedDigitSystemFontOfSize:30 weight:NSFontWeightBold];
    NSFont* statFont  = [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightRegular];

    // Connection dot
    NSRect dot = NSMakeRect(40, y + 6, 10, 10);
    [(p.connected ? C_GREEN : rgb(0x3A4152)) setFill];
    [[NSBezierPath bezierPathWithOvalInRect:dot] fill];

    drawText(@(p.name.c_str()), NSMakeRect(62, y, 120, 22), nameFont, C_TEXT, NSTextAlignmentLeft);

    // Flash blends the bar toward white for a few frames after each click, so
    // input is visible even when the score barely moves.
    NSColor* barColor = [color blendedColorWithFraction:p.flash * 0.65 ofColor:[NSColor whiteColor]];
    const double frac = peak > 0 ? (double)p.score / (double)peak : 0.0;
    drawBar(NSMakeRect(190, y - 1, W - 190 - 190, 26), frac, barColor);

    drawText(@(commas(p.score).c_str()), NSMakeRect(W - 180, y - 6, 140, 40),
             scoreFont, C_TEXT, NSTextAlignmentRight);

    NSMutableString* stats = [NSMutableString stringWithFormat:@"%d clicks   %@ cps   x%@",
                              p.clicks, fmt("%.1f", p.cps), fmt("%.2f", p.multiplier)];
    if (p.combo >= 5) [stats appendFormat:@"   combo %d", p.combo];
    drawText(stats, NSMakeRect(190, y + 30, 420, 18), statFont, C_DIM, NSTextAlignmentLeft);

    if (p.dropped > 0) {
        drawText([NSString stringWithFormat:@"%ld dropped", p.dropped],
                 NSMakeRect(W - 340, y + 30, 160, 18), statFont, C_RED, NSTextAlignmentRight);
    }
}

- (void)drawRect:(NSRect)dirty {
    [C_BG setFill];
    NSRectFill(self.bounds);

    const CGFloat W = self.bounds.size.width;
    const long peak = MAX(MAX(_game->player(0).score, _game->player(1).score), 1L);

    drawText(@"CLICK BATTLE", NSMakeRect(40, 28, 400, 30),
             [NSFont systemFontOfSize:22 weight:NSFontWeightHeavy], C_TEXT, NSTextAlignmentLeft);

    if (_game->phase() == Phase::Playing) {
        drawText(fmt("%.1fs", _game->phaseRemaining()), NSMakeRect(W - 240, 30, 200, 30),
                 [NSFont monospacedDigitSystemFontOfSize:22 weight:NSFontWeightBold],
                 C_GOLD, NSTextAlignmentRight);
    }

    [self drawPlayer:0 atY:120 color:C_P1 peak:peak];
    [self drawPlayer:1 atY:210 color:C_P2 peak:peak];

    // Centre status
    NSString* big = nil;
    NSColor*  bigColor = C_GOLD;
    switch (_game->phase()) {
        case Phase::Lobby:
            big = _game->allConnected() ? @"press any button to start"
                                        : @"press  a  or  l  to start";
            bigColor = C_GOLD;
            break;
        case Phase::Countdown:
            big = [NSString stringWithFormat:@"%d", (int)ceil(_game->phaseRemaining())];
            break;
        case Phase::Playing:
            big = @"CLICK!";
            bigColor = C_TEXT;
            break;
        case Phase::Results: {
            const int w = _game->winner();
            big = (w < 0) ? @"DRAW"
                          : [NSString stringWithFormat:@"%s WINS", _game->player(w).name.c_str()];
            break;
        }
    }
    const CGFloat bigSize = (_game->phase() == Phase::Countdown) ? 64 : 26;
    drawText(big, NSMakeRect(0, 300, W, 90),
             [NSFont systemFontOfSize:bigSize weight:NSFontWeightBold], bigColor, NSTextAlignmentCenter);

    NSString* footer = [NSString stringWithFormat:@"%s      keys:  a = player 1     l = player 2",
                                                  _hub->status().c_str()];
    drawText(footer, NSMakeRect(0, self.bounds.size.height - 44, W, 20),
             [NSFont systemFontOfSize:12], C_DIM, NSTextAlignmentCenter);
}
@end

// -------------------------------------------------------------- delegate

@interface AppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation AppDelegate
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender { return YES; }
@end

// ------------------------------------------------------------------ main

int main(int argc, const char* argv[]) {
    @autoreleasepool {
        static Game                      game;
        static BlockingQueue<InputEvent> queue;
        static BleHub                    hub(queue);

        const std::string p1 = (argc > 1) ? argv[1] : "ESP32-P1";
        const std::string p2 = (argc > 2) ? argv[2] : "ESP32-P2";
        hub.addPlayer(0, p1);
        hub.addPlayer(1, p2);

        hub.start();   // non-blocking; the window comes up immediately

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

        // Minimal menu so Cmd-Q works.
        NSMenu*     bar  = [NSMenu new];
        NSMenuItem* item = [NSMenuItem new];
        [bar addItem:item];
        NSMenu* appMenu = [NSMenu new];
        [appMenu addItemWithTitle:@"Quit Clicker Battle" action:@selector(terminate:) keyEquivalent:@"q"];
        [item setSubmenu:appMenu];
        [NSApp setMainMenu:bar];

        NSRect frame = NSMakeRect(0, 0, 900, 470);
        NSWindow* win = [[NSWindow alloc]
            initWithContentRect:frame
                      styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                 NSWindowStyleMaskMiniaturizable)
                        backing:NSBackingStoreBuffered
                          defer:NO];
        win.title = @"Clicker Battle";
        [win center];

        GameView* view = [[GameView alloc] initWithFrame:frame
                                                    game:&game
                                                   queue:&queue
                                                     hub:&hub];
        win.contentView = view;
        [win makeFirstResponder:view];
        [win makeKeyAndOrderFront:nil];

        AppDelegate* delegate = [AppDelegate new];
        [NSApp setDelegate:delegate];
        [NSApp activateIgnoringOtherApps:YES];
        [NSApp run];
    }
    return 0;
}
