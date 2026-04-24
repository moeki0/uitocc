PREFIX ?= /usr/local

all: uitocc uitocc-ax-text uitocc-send uitocc-transcribe

uitocc: cli.ts mcp-server.ts audio-daemon.ts
	bun build --compile cli.ts --outfile uitocc

uitocc-ax-text: ax_text.swift
	swiftc ax_text.swift -o uitocc-ax-text -O

uitocc-send: send.swift
	swiftc send.swift -o uitocc-send -O

uitocc-transcribe: transcribe.swift
	swiftc transcribe.swift -o uitocc-transcribe -O -framework Speech

install: all
	install -d $(PREFIX)/bin
	install -m 755 uitocc $(PREFIX)/bin/uitocc
	install -m 755 uitocc-ax-text $(PREFIX)/bin/uitocc-ax-text
	install -m 755 uitocc-send $(PREFIX)/bin/uitocc-send
	install -m 755 uitocc-transcribe $(PREFIX)/bin/uitocc-transcribe

uninstall:
	rm -f $(PREFIX)/bin/uitocc
	rm -f $(PREFIX)/bin/uitocc-ax-text
	rm -f $(PREFIX)/bin/uitocc-send
	rm -f $(PREFIX)/bin/uitocc-transcribe

clean:
	rm -f uitocc uitocc-ax-text uitocc-send uitocc-transcribe

.PHONY: all install uninstall clean
