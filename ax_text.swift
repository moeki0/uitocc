#!/usr/bin/env swift
/// Get visible text from macOS windows using Accessibility API
/// Usage:
///   ax_text           — frontmost window only (legacy output)
///   ax_text --all     — all windows, JSON array output
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
    limit: Int = 100
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

func getWindowTitle(_ appEl: AXUIElement) -> String {
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

func getWindows(_ appEl: AXUIElement) -> [AXUIElement] {
    axValue(appEl, kAXWindowsAttribute) as? [AXUIElement] ?? []
}

// Chrome/Chromium don't expose web content via macOS AX API.
// Use AppleScript to execute JS and get page text for supported browsers.
let browserAppleScriptNames: [String: String] = [
    "com.google.Chrome": "Google Chrome",
    "com.google.Chrome.canary": "Google Chrome Canary",
    "com.microsoft.edgemac": "Microsoft Edge",
    "com.brave.Browser": "Brave Browser",
    "com.vivaldi.Vivaldi": "Vivaldi",
    "com.operasoftware.Opera": "Opera",
]

func getBrowserTabTexts(appScriptName: String) -> [[String: Any]] {
    // Get tab texts via AppleScript JS execution
    let script = """
    tell application "\(appScriptName)"
        set output to ""
        repeat with w from 1 to (count of windows)
            repeat with i from 1 to (count of tabs of window w)
                set t to title of tab i of window w
                set u to URL of tab i of window w
                try
                    tell tab i of window w
                        set txt to execute javascript "document.body.innerText.substring(0, 5000)"
                    end tell
                on error
                    set txt to ""
                end try
                set output to output & "|||WINDEX=" & w & "|||TINDEX=" & i & "|||TITLE=" & t & "|||URL=" & u & "|||TEXT=" & txt & "|||END"
            end repeat
        end repeat
        return output
    end tell
    """
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments = ["-e", script]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = Pipe()
    do {
        try proc.run()
        proc.waitUntilExit()
    } catch { return [] }
    guard proc.terminationStatus == 0 else { return [] }
    let raw = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

    var results: [[String: Any]] = []
    let chunks = raw.components(separatedBy: "|||END")
    for chunk in chunks {
        guard chunk.contains("|||TITLE=") else { continue }
        func extract(_ key: String) -> String {
            guard let range = chunk.range(of: "|||\(key)=") else { return "" }
            let after = chunk[range.upperBound...]
            if let end = after.range(of: "|||") {
                return String(after[..<end.lowerBound])
            }
            return String(after)
        }
        let wIdx = Int(extract("WINDEX")) ?? 0
        let tIdx = Int(extract("TINDEX")) ?? 0
        let title = extract("TITLE")
        let text = extract("TEXT").trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            results.append([
                "window_index": wIdx - 1,
                "tab_index": tIdx - 1,
                "title": title,
                "text": text,
            ])
        }
    }
    return results
}

// --all mode: enumerate all windows from all apps as JSON
if CommandLine.arguments.contains("--all") {
    var entries: [[String: Any]] = []
    let apps = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular
    }

    // Collect browser tab texts via AppleScript (keyed by app name + window index)
    var browserTexts: [String: [[String: Any]]] = [:]
    for app in apps {
        if let bid = app.bundleIdentifier, let asName = browserAppleScriptNames[bid] {
            browserTexts[app.localizedName ?? asName] = getBrowserTabTexts(appScriptName: asName)
        }
    }

    for app in apps {
        guard let appName = app.localizedName else { continue }
        let pid = app.processIdentifier
        let appEl = AXUIElementCreateApplication(pid)
        let windows = getWindows(appEl)

        // Get CGWindowIDs for this app
        let cgWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let appCGWindows = cgWindows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }

        // Check if this app has browser tab texts
        let tabTexts = browserTexts[appName]

        for (idx, win) in windows.enumerated() {
            let title = axValue(win, kAXTitleAttribute) as? String ?? ""
            var texts: [String] = []

            // For browsers, use AppleScript-sourced tab texts for matching window
            if let tabs = tabTexts {
                // Find tabs belonging to this window
                let windowTabs = tabs.filter { ($0["window_index"] as? Int) == idx }
                for tab in windowTabs {
                    if let text = tab["text"] as? String, !text.isEmpty {
                        let tabTitle = tab["title"] as? String ?? ""
                        if !tabTitle.isEmpty { texts.append("[\(tabTitle)]") }
                        texts.append(text)
                    }
                }
            }

            // Fall back to AX tree if no browser texts
            if texts.isEmpty {
                collectTexts(win, depth: 0, maxDepth: 30, results: &texts, limit: 500)
            }

            // Match CGWindowID by title or index
            var windowID: Int = 0
            if let matched = appCGWindows.first(where: { ($0[kCGWindowName as String] as? String) == title && !title.isEmpty }) {
                windowID = matched[kCGWindowNumber as String] as? Int ?? 0
            } else if idx < appCGWindows.count {
                windowID = appCGWindows[idx][kCGWindowNumber as String] as? Int ?? 0
            }
            entries.append([
                "pid": Int(pid),
                "window_index": idx,
                "app": appName,
                "title": title,
                "texts": texts,
                "window_id": windowID,
            ])
        }
    }

    if let data = try? JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("[]")
    }
    exit(0)
}

// Legacy mode: frontmost app only
guard let frontApp = NSWorkspace.shared.frontmostApplication,
      let appName = frontApp.localizedName else {
    fputs("No frontmost app\n", stderr)
    exit(1)
}

let pid = frontApp.processIdentifier
let appEl = AXUIElementCreateApplication(pid)
let windowTitle = getWindowTitle(appEl)
var texts: [String] = []

collectTexts(appEl, results: &texts)

let output = [
    "app:\(appName)",
    "window:\(windowTitle)",
] + texts.map { "text:\($0)" }

for line in output {
    print(line)
}
