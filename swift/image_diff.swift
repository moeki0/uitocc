#!/usr/bin/env swift
/// Compare two PNG images and output the percentage of pixels that differ.
/// Usage: image_diff <path1> <path2>
/// Output: a single float (0.0 = identical, 1.0 = completely different)
/// Exit code 0 = success, 1 = error (e.g. file not found)
import Foundation
import CoreGraphics
import ImageIO

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: image_diff <path1> <path2>\n", stderr)
    exit(1)
}

let path1 = CommandLine.arguments[1]
let path2 = CommandLine.arguments[2]

func loadPixels(_ path: String) -> (Data, Int, Int)? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    let w = img.width, h = img.height
    let bytesPerRow = w * 4
    var data = Data(count: h * bytesPerRow)
    data.withUnsafeMutableBytes { ptr in
        guard let ctx = CGContext(
            data: ptr.baseAddress, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return (data, w, h)
}

guard let (d1, w1, h1) = loadPixels(path1),
      let (d2, w2, h2) = loadPixels(path2) else {
    fputs("Failed to load images\n", stderr)
    exit(1)
}

// Different dimensions = totally different
if w1 != w2 || h1 != h2 {
    print("1.0")
    exit(0)
}

let totalPixels = w1 * h1
var diffPixels = 0
let threshold: UInt8 = 10 // per-channel tolerance for anti-aliasing etc.

d1.withUnsafeBytes { p1 in
    d2.withUnsafeBytes { p2 in
        let b1 = p1.bindMemory(to: UInt8.self)
        let b2 = p2.bindMemory(to: UInt8.self)
        for i in stride(from: 0, to: totalPixels * 4, by: 4) {
            let dr = b1[i] > b2[i] ? b1[i] - b2[i] : b2[i] - b1[i]
            let dg = b1[i+1] > b2[i+1] ? b1[i+1] - b2[i+1] : b2[i+1] - b1[i+1]
            let db = b1[i+2] > b2[i+2] ? b1[i+2] - b2[i+2] : b2[i+2] - b1[i+2]
            if dr > threshold || dg > threshold || db > threshold {
                diffPixels += 1
            }
        }
    }
}

let ratio = Double(diffPixels) / Double(totalPixels)
print(String(format: "%.6f", ratio))
