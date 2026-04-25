#!/usr/bin/env swift
/// Send current screen context via uitocc channel
import Cocoa
import ApplicationServices
import Foundation

func axValue(_ el: AXUIElement, _ attr: String) -> AnyObject? {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    return v
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    axValue(el, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func axRole(_ el: AXUIElement) -> String {
    axValue(el, kAXRoleAttribute) as? String ?? ""
}

func collectTexts(
    _ el: AXUIElement,
    depth: Int = 0,
    maxDepth: Int = 5,
    results: inout [String],
    limit: Int = 30
) {
    guard depth < maxDepth, results.count < limit else { return }

    if let v = axValue(el, kAXValueAttribute) as? String,
       !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
       v.count < 3000 {
        results.append(v.trimmingCharacters(in: .whitespacesAndNewlines))
    } else if let t = axValue(el, kAXTitleAttribute) as? String,
              !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              t.count < 3000 {
        let role = axRole(el)
        if role != "AXGroup" && role != "AXWindow" {
            results.append(t.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    } else if let d = axValue(el, kAXDescriptionAttribute) as? String,
              !d.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              d.count < 1000 {
        results.append(d.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    for child in axChildren(el) {
        collectTexts(child, depth: depth + 1, maxDepth: maxDepth, results: &results, limit: limit)
    }
}

/// Find AXWebArea elements (browser page content) by DFS
func findWebAreas(_ el: AXUIElement, depth: Int = 0, maxDepth: Int = 15, results: inout [AXUIElement]) {
    guard depth < maxDepth else { return }
    if axRole(el) == "AXWebArea" {
        results.append(el)
        return // don't recurse further into web areas here
    }
    for child in axChildren(el) {
        findWebAreas(child, depth: depth + 1, maxDepth: maxDepth, results: &results)
    }
}

func windowTitle(_ appEl: AXUIElement) -> String {
    if let w = axValue(appEl, kAXFocusedWindowAttribute) as! AXUIElement? {
        return axValue(w, kAXTitleAttribute) as? String ?? ""
    }
    if let w = axValue(appEl, kAXMainWindowAttribute) as! AXUIElement? {
        return axValue(w, kAXTitleAttribute) as? String ?? ""
    }
    for child in axChildren(appEl) {
        if axRole(child) == "AXWindow" {
            return axValue(child, kAXTitleAttribute) as? String ?? ""
        }
    }
    return ""
}

guard let frontApp = NSWorkspace.shared.frontmostApplication,
      let appName = frontApp.localizedName else {
    fputs("No frontmost app\n", stderr)
    exit(1)
}

let pid = frontApp.processIdentifier
let appEl = AXUIElementCreateApplication(pid)
let wTitle = windowTitle(appEl)

// Collect text from focused window only (skip menu bar)
var contextTexts: [String] = []
if let focusedWindow = axValue(appEl, kAXFocusedWindowAttribute) as! AXUIElement? {
    collectTexts(focusedWindow, depth: 0, maxDepth: 30, results: &contextTexts, limit: 500)
} else {
    collectTexts(appEl, depth: 0, maxDepth: 30, results: &contextTexts, limit: 500)
}

// Get text at cursor position
var cursorText: String? = nil
let mouseLocation = NSEvent.mouseLocation
let screenHeight = NSScreen.screens.first?.frame.height ?? 0
let quartzY = screenHeight - mouseLocation.y

var element: AXUIElement?
let result = AXUIElementCopyElementAtPosition(appEl, Float(mouseLocation.x), Float(quartzY), &element)
if result == .success, let el = element {
    if let v = axValue(el, kAXValueAttribute) as? String,
       !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        cursorText = v.trimmingCharacters(in: .whitespacesAndNewlines)
    } else if let t = axValue(el, kAXTitleAttribute) as? String,
              !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        cursorText = t.trimmingCharacters(in: .whitespacesAndNewlines)
    } else if let d = axValue(el, kAXDescriptionAttribute) as? String,
              !d.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        cursorText = d.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// Build event JSON
struct ChannelEvent: Codable {
    let timestamp: String
    let app: String
    let windowTitle: String
    let cursorText: String?
    let contextTexts: [String]
}

let isoFormatter = ISO8601DateFormatter()
isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

let event = ChannelEvent(
    timestamp: isoFormatter.string(from: Date()),
    app: appName,
    windowTitle: wTitle,
    cursorText: cursorText,
    contextTexts: contextTexts
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
guard let data = try? encoder.encode(event) else {
    fputs("Failed to encode JSON\n", stderr)
    exit(1)
}

let dataDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/uitocc")
let eventPath = dataDir.appendingPathComponent("channel_event.json")

try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

do {
    try data.write(to: eventPath, options: .atomic)
    let summary = cursorText.map { String($0.prefix(80)) } ?? "(no text)"
    fputs("Sent: \(summary)\n", stderr)
} catch {
    fputs("Failed to write: \(error)\n", stderr)
    exit(1)
}
