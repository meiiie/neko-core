import type { McpTools } from "../core/ports.ts";

/** Compose independent edge tool sources without teaching core about any adapter. */
class CompositeMcpTools implements McpTools {
  constructor(private readonly sources: McpTools[]) {}

  private sourceFor(name: string): McpTools | undefined {
    const matches = this.sources.filter((source) => source.has(name));
    return matches.length === 1 ? matches[0] : undefined;
  }

  toolSchemas(): any[] {
    const schemas = this.sources.flatMap((source) => source.toolSchemas());
    const seen = new Set<string>();
    for (const schema of schemas) {
      const name = String(schema?.function?.name ?? "");
      if (name && seen.has(name)) throw new Error(`duplicate external tool schema: ${name}`);
      if (name) seen.add(name);
    }
    return schemas;
  }
  has(name: string): boolean { return this.sources.some((source) => source.has(name)); }
  permission(name: string): "safe" | "gated" {
    const source = this.sourceFor(name);
    return source?.permission?.(name) ?? "gated";
  }
  temporal(name: string): boolean {
    const source = this.sourceFor(name);
    return source?.temporal?.(name) ?? false;
  }
  call(name: string, args: any, signal?: AbortSignal): Promise<string> {
    const matches = this.sources.filter((candidate) => candidate.has(name));
    if (matches.length > 1) return Promise.resolve(`Error: ambiguous external tool name ${name}`);
    const source = matches[0];
    if (!source) return Promise.resolve(`Error: unknown external tool ${name}`);
    return source.call(name, args, signal);
  }
  indexBlock(): string { return this.sources.map((source) => source.indexBlock?.() ?? "").filter(Boolean).join("\n"); }
  promptList(): { server: string; name: string }[] {
    const prompts = this.sources.flatMap((source) => source.promptList?.() ?? []);
    const seen = new Set<string>();
    for (const prompt of prompts) {
      const key = `${prompt.server}\0${prompt.name}`;
      if (seen.has(key)) throw new Error(`duplicate MCP prompt: ${prompt.server}:${prompt.name}`);
      seen.add(key);
    }
    return prompts;
  }
  getPrompt(server: string, name: string, args: any): Promise<string> {
    const matches = this.sources.filter((candidate) =>
      candidate.getPrompt && candidate.promptList?.().some((prompt) => prompt.server === server && prompt.name === name));
    if (matches.length > 1) return Promise.resolve(`Error: ambiguous MCP prompt ${server}:${name}`);
    const source = matches[0];
    if (!source?.getPrompt) return Promise.resolve(`Error: unknown MCP prompt ${server}:${name}`);
    return source.getPrompt(server, name, args);
  }
  loadTools(names: string[]): string {
    const batches = new Map<McpTools, string[]>();
    const errors: string[] = [];
    for (const name of names) {
      const matches = this.sources.filter((source) => source.has(name));
      if (matches.length > 1) {
        errors.push(`Error: ambiguous external tool name ${name}`);
        continue;
      }
      const source = matches[0];
      if (!source?.loadTools) {
        errors.push(`Error: unknown external tool ${name}`);
        continue;
      }
      const batch = batches.get(source) ?? [];
      batch.push(name);
      batches.set(source, batch);
    }
    const loaded = [...batches].map(([source, batch]) => source.loadTools!(batch)).filter(Boolean);
    return [...loaded, ...errors].join("\n");
  }
}

export function composeMcpTools(...sources: (McpTools | undefined)[]): McpTools | undefined {
  const present = sources.filter((source): source is McpTools => !!source);
  if (!present.length) return undefined;
  return present.length === 1 ? present[0] : new CompositeMcpTools(present);
}
