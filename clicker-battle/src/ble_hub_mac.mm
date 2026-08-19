// macOS BLE backend, straight onto CoreBluetooth. No third-party libraries:
// CoreBluetooth.framework ships with the OS.
//
// This file is Objective-C++ (.mm) -- Objective-C and C++ in one translation
// unit. It is the only file that knows CoreBluetooth exists.

#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>

#include <cstdio>
#include <string>

#include "ble_hub.hpp"

// Debug trace of every BLE device seen, so a board that is not advertising
// can be told apart from a board that is advertising under the wrong name.
// Written from the BLE queue, which is serial, so no locking needed.
static void trace(NSString* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    NSString* line = [[NSString alloc] initWithFormat:fmt arguments:args];
    va_end(args);
    if (FILE* f = fopen("/tmp/clicker-scan.log", "a")) {
        fprintf(f, "%s\n", line.UTF8String);
        fclose(f);
    }
}

// Must match the firmware.
static NSString* const kServiceUUID = @"6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
static NSString* const kTxUUID      = @"6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

static InputEvent parsePayload(int player, NSData* data) {
    const std::string msg((const char*)data.bytes, data.length);

    InputEvent e;
    e.player = player;
    e.at     = Clock::now();

    if (msg.rfind("press", 0) == 0) {
        e.type = InputEvent::Type::Press;
        if (auto sp = msg.find(' '); sp != std::string::npos) {
            try { e.seq = std::stoul(msg.substr(sp + 1)); } catch (...) {}
        }
    } else {
        e.type = InputEvent::Type::Release;
    }
    return e;
}

// ---------------------------------------------------------------- delegate

@interface ClickerBle : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
- (instancetype)initWithQueue:(BlockingQueue<InputEvent>*)queue;
- (void)want:(int)player name:(NSString*)name;
- (NSString*)statusText;
- (void)shutdown;
@end

@implementation ClickerBle {
    BlockingQueue<InputEvent>*                    _queue;
    CBCentralManager*                             _central;
    dispatch_queue_t                              _bleQueue;
    dispatch_semaphore_t                          _ready;
    BOOL                                          _signalled;
    BOOL                                          _scanning;
    NSMutableDictionary<NSString*, NSNumber*>*    _wanted;   // device name -> player
    NSMutableDictionary<NSNumber*, CBPeripheral*>* _live;    // player -> peripheral
}

- (instancetype)initWithQueue:(BlockingQueue<InputEvent>*)queue {
    if (!(self = [super init])) return nil;

    _queue  = queue;
    _wanted = [NSMutableDictionary new];
    _live   = [NSMutableDictionary new];
    _ready  = dispatch_semaphore_create(0);

    // A dedicated serial queue, NOT nil. Passing nil delivers callbacks on the
    // main queue, which requires a running NSRunLoop -- our game loop is a
    // plain while(), so they would never fire and nothing would ever connect.
    _bleQueue = dispatch_queue_create("clicker.ble", DISPATCH_QUEUE_SERIAL);
    _central  = [[CBCentralManager alloc] initWithDelegate:self queue:_bleQueue];
    return self;
}

- (void)want:(int)player name:(NSString*)name {
    // dispatch_sync onto the BLE queue: _wanted is read from delegate
    // callbacks on that queue, so it must not be mutated from main.
    dispatch_sync(_bleQueue, ^{
        self->_wanted[name] = @(player);
        [self updateScan];
    });
}

// Safe to poll from the main thread every frame: CBCentralManager.state is
// documented as thread-safe to read.
- (NSString*)statusText {
    switch (_central.state) {
        case CBManagerStatePoweredOn:
            return @"bluetooth on \u2014 searching for controllers";
        case CBManagerStatePoweredOff:
            return @"bluetooth is off \u2014 keyboard only";
        case CBManagerStateUnauthorized:
            return @"bluetooth denied \u2014 System Settings \u203a Privacy & Security \u203a Bluetooth";
        case CBManagerStateUnsupported:
            return @"no BLE support on this Mac \u2014 keyboard only";
        default:
            return @"starting bluetooth\u2026";
    }
}

- (void)shutdown {
    dispatch_sync(_bleQueue, ^{
        if (self->_scanning) { [self->_central stopScan]; self->_scanning = NO; }
        for (NSNumber* key in self->_live) {
            [self->_central cancelPeripheralConnection:self->_live[key]];
        }
    });
}

// Scan only while something is still missing.
- (void)updateScan {
    BOOL need = NO;
    for (NSString* name in _wanted) {
        if (!_live[_wanted[name]]) { need = YES; break; }
    }

    if (need && !_scanning && _central.state == CBManagerStatePoweredOn) {
        // nil services == report everything, then match on name. Filtering by
        // service UUID is tidier but silently fails if the 128-bit UUID gets
        // squeezed out of the 31-byte advertising packet.
        [_central scanForPeripheralsWithServices:nil options:nil];
        _scanning = YES;
    } else if (!need && _scanning) {
        [_central stopScan];
        _scanning = NO;
    }
}

- (int)playerFor:(CBPeripheral*)peripheral {
    for (NSNumber* key in _live) {
        if ([_live[key].identifier isEqual:peripheral.identifier]) return key.intValue;
    }
    return -1;
}

// ------------------------------------------------------- CBCentralManager

- (void)centralManagerDidUpdateState:(CBCentralManager*)central {
    trace(@"radio state = %ld  (5 == PoweredOn)", (long)central.state);
    if (!_signalled) { _signalled = YES; dispatch_semaphore_signal(_ready); }
    if (central.state == CBManagerStatePoweredOn) [self updateScan];
}

- (void)centralManager:(CBCentralManager*)central
 didDiscoverPeripheral:(CBPeripheral*)peripheral
     advertisementData:(NSDictionary<NSString*, id>*)advertisementData
                  RSSI:(NSNumber*)RSSI {
    NSString* name = advertisementData[CBAdvertisementDataLocalNameKey] ?: peripheral.name;
    // Log advertised service UUIDs too: a board whose name was squeezed out of
    // the 31-byte advertising packet is still identifiable by its service.
    // Log each device once, not once per advertisement -- a busy room emits
    // ~50/sec and a file open per packet would stall the BLE queue.
    static NSMutableSet* logged = nil;
    if (!logged) logged = [NSMutableSet new];
    const BOOL isNew = ![logged containsObject:peripheral.identifier];
    if (isNew) [logged addObject:peripheral.identifier];

    NSArray* svcs = advertisementData[CBAdvertisementDataServiceUUIDsKey];
    NSArray* over = advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey];
    if (isNew) {
        trace(@"seen  name=%@  rssi=%@  svc=%@  overflow=%@  uuid=%@",
              name ?: @"(none)", RSSI,
              svcs ? [svcs componentsJoinedByString:@","] : @"-",
              over ? [over componentsJoinedByString:@","] : @"-",
              peripheral.identifier.UUIDString);
    }
    if (!name) return;

    NSNumber* player = _wanted[name];
    if (!player || _live[player]) return;

    // Retain it here. A CBPeripheral you do not hold is deallocated mid-connect
    // and the connection silently never completes -- the classic CoreBluetooth trap.
    trace(@"MATCH  %@ -> player %d, connecting", name, player.intValue);
    _live[player]       = peripheral;
    peripheral.delegate = self;

    [central connectPeripheral:peripheral options:nil];
    [self updateScan];
}

- (void)centralManager:(CBCentralManager*)central
  didConnectPeripheral:(CBPeripheral*)peripheral {
    trace(@"CONNECTED  %@  -> discovering services", peripheral.name ?: @"(unnamed)");
    [peripheral discoverServices:@[[CBUUID UUIDWithString:kServiceUUID]]];
}

- (void)centralManager:(CBCentralManager*)central
didFailToConnectPeripheral:(CBPeripheral*)peripheral
                 error:(NSError*)error {
    trace(@"CONNECT FAILED  %@  err=%@", peripheral.name ?: @"(unnamed)", error.localizedDescription);
    [central connectPeripheral:peripheral options:nil];
}

- (void)centralManager:(CBCentralManager*)central
didDisconnectPeripheral:(CBPeripheral*)peripheral
                 error:(NSError*)error {
    const int p = [self playerFor:peripheral];
    trace(@"DISCONNECTED  player %d  err=%@", p, error.localizedDescription ?: @"(clean)");
    if (p >= 0) _queue->push(InputEvent{p, InputEvent::Type::Disconnected, 0, Clock::now()});

    // A pending connect request in CoreBluetooth never times out -- it simply
    // completes whenever the board reappears. Free auto-reconnect, no rescan.
    [central connectPeripheral:peripheral options:nil];
}

// ----------------------------------------------------------- CBPeripheral

- (void)peripheral:(CBPeripheral*)peripheral didDiscoverServices:(NSError*)error {
    trace(@"services: %lu found  err=%@", (unsigned long)peripheral.services.count,
          error.localizedDescription ?: @"none");
    if (error) return;
    for (CBService* service in peripheral.services) {
        [peripheral discoverCharacteristics:@[[CBUUID UUIDWithString:kTxUUID]]
                                 forService:service];
    }
}

- (void)peripheral:(CBPeripheral*)peripheral
didDiscoverCharacteristicsForService:(CBService*)service
             error:(NSError*)error {
    trace(@"chars in %@: %lu  err=%@", service.UUID, (unsigned long)service.characteristics.count,
          error.localizedDescription ?: @"none");
    if (error) return;
    for (CBCharacteristic* c in service.characteristics) {
        if (![c.UUID isEqual:[CBUUID UUIDWithString:kTxUUID]]) continue;

        // This is the subscribe. Under the hood it writes 0x0001 to the
        // characteristic's CCCD on the ESP32 -- the flag notify() checks.
        [peripheral setNotifyValue:YES forCharacteristic:c];

        const int p = [self playerFor:peripheral];
        trace(@"SUBSCRIBED  player %d  -- link is live", p);
        if (p >= 0) _queue->push(InputEvent{p, InputEvent::Type::Connected, 0, Clock::now()});
    }
}

- (void)peripheral:(CBPeripheral*)peripheral
didUpdateValueForCharacteristic:(CBCharacteristic*)characteristic
             error:(NSError*)error {
    if (error || !characteristic.value) return;

    const int p = [self playerFor:peripheral];
    if (p < 0) return;

    _queue->push(parsePayload(p, characteristic.value));   // runs on _bleQueue
}

@end

// --------------------------------------------------------------- BleHub

struct BleHub::Impl {
    ClickerBle* delegate = nil;
};

BleHub::BleHub(BlockingQueue<InputEvent>& queue) : impl_(new Impl) {
    impl_->delegate = [[ClickerBle alloc] initWithQueue:&queue];
}

BleHub::~BleHub() { stop(); }

void BleHub::addPlayer(int player, std::string deviceName) {
    [impl_->delegate want:player name:@(deviceName.c_str())];
}

void BleHub::start() {
    // Nothing to do: the CBCentralManager began powering up in the delegate's
    // init, and scanning starts from centralManagerDidUpdateState:.
}

std::string BleHub::status() const {
    NSString* s = [impl_->delegate statusText];
    return s ? std::string(s.UTF8String) : std::string();
}

void BleHub::stop() {
    if (impl_ && impl_->delegate) [impl_->delegate shutdown];
}
