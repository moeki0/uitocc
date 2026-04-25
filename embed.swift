#!/usr/bin/env swift
/// Generate sentence embeddings using Apple's NaturalLanguage framework
/// Usage:
///   echo "text" | tunr-embed          — single text, output JSON array of floats
///   echo "text1\ntext2" | tunr-embed --batch  — one vector per line, output JSON array of arrays
import Foundation
import NaturalLanguage

guard let embedding = NLEmbedding.sentenceEmbedding(for: .english) else {
    fputs("Failed to load sentence embedding model\n", stderr)
    exit(1)
}

// Also try Japanese model
let jaEmbedding = NLEmbedding.sentenceEmbedding(for: .japanese)

func embed(_ text: String) -> [Double]? {
    // Try Japanese first if available, fall back to English
    if let ja = jaEmbedding, let vec = ja.vector(for: text) {
        return vec
    }
    return embedding.vector(for: text)
}

let isBatch = CommandLine.arguments.contains("--batch")
let input = readLine(strippingNewline: false) ?? ""
let fullInput: String

if input.isEmpty {
    // Read all of stdin
    var data = Data()
    while let chunk = readLine(strippingNewline: false) {
        data.append(contentsOf: chunk.utf8)
    }
    fullInput = (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
} else {
    // Already got first line, read the rest
    var lines = input
    while let line = readLine(strippingNewline: false) {
        lines += line
    }
    fullInput = lines.trimmingCharacters(in: .whitespacesAndNewlines)
}

if fullInput.isEmpty {
    fputs("No input text\n", stderr)
    exit(1)
}

if isBatch {
    let lines = fullInput.components(separatedBy: "\n").filter { !$0.isEmpty }
    var results: [[Double]] = []
    for line in lines {
        if let vec = embed(line) {
            results.append(vec)
        } else {
            results.append([])
        }
    }
    if let data = try? JSONSerialization.data(withJSONObject: results),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
} else {
    if let vec = embed(fullInput) {
        if let data = try? JSONSerialization.data(withJSONObject: vec),
           let json = String(data: data, encoding: .utf8) {
            print(json)
        }
    } else {
        fputs("Failed to generate embedding\n", stderr)
        exit(1)
    }
}
