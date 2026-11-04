import Foundation
import IOKit.hid

/// MacBook の蓋の角度センサー。
/// Apple の非公式な HID デバイス (VID 0x05AC / PID 0x8104, Sensor ページの Orientation) の
/// Feature レポート ID 1 から、整数の角度 (度) を読む。
/// 非公式なので、機種や macOS のバージョンによっては見つからないことがある。
final class LidAngleSensor {
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?

    init() {
        let m = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matching: [String: Any] = [
            kIOHIDVendorIDKey: 0x05AC,
            kIOHIDProductIDKey: 0x8104,
            kIOHIDPrimaryUsagePageKey: 0x0020, // Sensor
            kIOHIDPrimaryUsageKey: 0x008A, // Orientation
        ]
        IOHIDManagerSetDeviceMatching(m, matching as CFDictionary)
        guard IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeNone)) == kIOReturnSuccess,
              let devices = IOHIDManagerCopyDevices(m) as? Set<IOHIDDevice>
        else { return }

        // 実際にレポートが読めるデバイスを選ぶ
        for d in devices where IOHIDDeviceOpen(d, IOOptionBits(kIOHIDOptionsTypeNone)) == kIOReturnSuccess {
            if Self.readReport(d) != nil {
                device = d
                break
            }
            IOHIDDeviceClose(d, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        manager = m
    }

    deinit {
        if let device { IOHIDDeviceClose(device, IOOptionBits(kIOHIDOptionsTypeNone)) }
        if let manager { IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone)) }
    }

    var isAvailable: Bool { device != nil }

    /// 現在の開き角 (度)。読めなければ nil。
    func read() -> Double? {
        guard let device else { return nil }
        return Self.readReport(device)
    }

    private static func readReport(_ d: IOHIDDevice) -> Double? {
        var buf = [UInt8](repeating: 0, count: 8)
        var len = buf.count
        let r = IOHIDDeviceGetReport(d, kIOHIDReportTypeFeature, 1, &buf, &len)
        guard r == kIOReturnSuccess, len >= 3 else { return nil }
        let raw = UInt16(buf[2]) << 8 | UInt16(buf[1])
        let deg = Double(raw)
        return (0...360).contains(deg) ? deg : nil
    }
}
