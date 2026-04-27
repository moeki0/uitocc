export interface IngestArgs {
  source: string;
  channel: string | null;
  meta: Record<string, string>;
}

export function parseIngestArgs(args: string[]): IngestArgs {
  let source = "";
  let channel: string | null = null;
  const meta: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--source":
        source = args[++i] || "";
        break;
      case "--channel":
        channel = args[++i] || null;
        break;
      case "--meta": {
        const kv = args[++i] || "";
        const eq = kv.indexOf("=");
        if (eq > 0) {
          meta[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        break;
      }
    }
  }

  return { source, channel, meta };
}
