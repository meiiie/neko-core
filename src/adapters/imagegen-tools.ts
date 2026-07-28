/**
 * Image generation as a tool the running agent can call - whatever model is driving.
 *
 * Composed through the MCP seam so it defaults to GATED: a generation spends the user's ChatGPT
 * subscription credits (the Codex rate card burns included usage ~3-5x faster than a text turn) and
 * writes a file, so it asks first, exactly like `write_file` does. See
 * docs/research/imagegen-chatgpt-2026-07-28.md for why the Codex app-server is the one legitimate
 * subscription surface (no API billing, no private-endpoint wrapping).
 */
import type { McpTools } from "../core/ports.ts";
import { composeMcpTools } from "./mcp-compose.ts";
import { generateImage, imageGenerationAvailable, type ImageClientFactory } from "./imagegen.ts";

const NAME = "mcp__neko_image__generate";

const SCHEMAS = [
  {
    type: "function",
    function: {
      name: NAME,
      description:
        "Generate one image from a text prompt via the user's ChatGPT subscription (Codex image tool, GPT-Image class). " +
        "Gated: it spends subscription usage noticeably faster than a text turn and writes a PNG into the project. " +
        "Write prompts like a photographer/art director: subject, composition, lens/light, style, and what to avoid.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The full image prompt. Include composition, lighting, style; state what must NOT appear." },
          path: { type: "string", description: "Output file path relative to the project root (default: neko-image-<stamp>.png)." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
];

class ImageTools implements McpTools {
  constructor(private readonly root: string, private readonly clientFactory?: ImageClientFactory) {}

  toolSchemas(): any[] {
    // Advertised only when the route exists (codex support + ChatGPT login): a tool that always
    // errors is noise in every prompt; absence IS the honest signal.
    return imageGenerationAvailable().ok ? SCHEMAS : [];
  }
  has(name: string): boolean { return name === NAME && imageGenerationAvailable().ok; }
  permission(): "safe" | "gated" { return "gated"; }
  indexBlock(): string {
    const available = imageGenerationAvailable();
    return available.ok
      ? "Image generation is available (ChatGPT subscription via Codex): the generate tool renders a prompt to a PNG in the project. Gated - it costs subscription usage."
      : "";
  }

  async call(name: string, args: Record<string, any>): Promise<string> {
    if (name !== NAME) return `Error: unknown image tool ${name}`;
    const available = imageGenerationAvailable();
    if (!available.ok) return `Error: ${available.detail}`;
    try {
      const result = await generateImage(this.root, String(args.prompt ?? ""), args.path ? String(args.path) : undefined, this.clientFactory);
      return [
        `Image saved: ${result.path}`,
        result.revisedPrompt ? `Prompt as rendered: ${result.revisedPrompt}` : "",
        "Look at it with read_file (vision) before declaring the task done.",
      ].filter(Boolean).join("\n");
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  }
}

export function createImageTools(root: string, clientFactory?: ImageClientFactory): McpTools {
  return new ImageTools(root, clientFactory);
}

export function withImageTools(source: McpTools | undefined, root: string): McpTools {
  return composeMcpTools(source, createImageTools(root))!;
}
