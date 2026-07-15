import type { McpTools } from "../core/ports.ts";

/** Compose independent edge tool sources without teaching core about any adapter. */
class CompositeMcpTools implements McpTools {
  constructor(private readonly sources: McpTools[]) {}

  toolSchemas(): any[] { return this.sources.flatMap((source) => source.toolSchemas()); }
  has(name: string): boolean { return this.sources.some((source) => source.has(name)); }
  permission(name: string): "safe" | "gated" {
    const source = this.sources.find((candidate) => candidate.has(name));
    return source?.permission?.(name) ?? "gated";
  }
  temporal(name: string): boolean {
    const source = this.sources.find((candidate) => candidate.has(name));
    return source?.temporal?.(name) ?? false;
  }
  call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const source = this.sources.find((candidate) => candidate.has(name));
    if (!source) return Promise.resolve(`Error: unknown external tool ${name}`);
    return source.call(name, args, signal);
  }
  indexBlock(): string { return this.sources.map((source) => source.indexBlock?.() ?? "").filter(Boolean).join("\n"); }
  loadTools(names: string[]): string {
    return this.sources.map((source) => source.loadTools?.(names) ?? "").filter(Boolean).join("\n");
  }
}

export function composeMcpTools(...sources: (McpTools | undefined)[]): McpTools | undefined {
  const present = sources.filter((source): source is McpTools => !!source);
  if (!present.length) return undefined;
  return present.length === 1 ? present[0] : new CompositeMcpTools(present);
}
