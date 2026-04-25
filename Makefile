PREFIX ?= /usr/local
SWIFT_TARGET ?= arm64-apple-macos14.0

all: tunr tunr-ax-text tunr-send tunr-embed tunr-audio-capture

tunr: src/cli.ts src/mcp-server.ts src/daemon.tsx
	bun build --compile src/cli.ts --outfile tunr
	codesign -s - tunr 2>/dev/null || true

tunr-ax-text: swift/ax_text.swift
	swiftc swift/ax_text.swift -o tunr-ax-text -O -target $(SWIFT_TARGET)

tunr-send: swift/send.swift
	swiftc swift/send.swift -o tunr-send -O -target $(SWIFT_TARGET)

tunr-embed: swift/embed.swift
	swiftc swift/embed.swift -o tunr-embed -O -target $(SWIFT_TARGET)

tunr-audio-capture: swift/audio_capture.swift
	swiftc swift/audio_capture.swift -o tunr-audio-capture -O -target $(SWIFT_TARGET) -framework AVFoundation -framework CoreAudio

install: all
	install -d $(PREFIX)/bin
	install -m 755 tunr $(PREFIX)/bin/tunr
	install -m 755 tunr-ax-text $(PREFIX)/bin/tunr-ax-text
	install -m 755 tunr-send $(PREFIX)/bin/tunr-send
	install -m 755 tunr-embed $(PREFIX)/bin/tunr-embed
	install -m 755 tunr-audio-capture $(PREFIX)/bin/tunr-audio-capture

uninstall:
	rm -f $(PREFIX)/bin/tunr
	rm -f $(PREFIX)/bin/tunr-ax-text
	rm -f $(PREFIX)/bin/tunr-send
	rm -f $(PREFIX)/bin/tunr-embed
	rm -f $(PREFIX)/bin/tunr-audio-capture

clean:
	rm -f tunr tunr-ax-text tunr-send tunr-embed tunr-audio-capture

.PHONY: all install uninstall clean
