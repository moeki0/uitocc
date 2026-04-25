#!/usr/bin/env swift
/// Monitor scroll and key events via CGEventTap
/// Outputs JSON lines to stdout: {"type":"scroll"} or {"type":"key"}
/// Debounces events to avoid flooding (max 1 event per 2 seconds)
import Cocoa

var lastEventTime: Date = .distantPast
let debounceInterval: TimeInterval = 2.0

func emitEvent(_ type: String) {
    let now = Date()
    guard now.timeIntervalSince(lastEventTime) >= debounceInterval else { return }
    lastEventTime = now
    print("{\"type\":\"\(type)\"}")
    fflush(stdout)
}

let eventMask: CGEventMask = (1 << CGEventType.scrollWheel.rawValue)
    | (1 << CGEventType.keyDown.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: eventMask,
    callback: { _, type, event, _ in
        switch type {
        case .scrollWheel:
            emitEvent("scroll")
        case .keyDown:
            emitEvent("key")
        default:
            break
        }
        return Unmanaged.passRetained(event)
    },
    userInfo: nil
) else {
    fputs("Failed to create event tap. Accessibility permission required.\n", stderr)
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

CFRunLoopRun()
