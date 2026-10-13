import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config, type Effort } from "../config.js";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface GenerateResult<T> {
  value: T;
  usage: Usage;
}

/**
 * The single seam between this product and the model. Everything that needs
 * generation goes through `generate`, which is swapped for a stub in tests.
 */
export interface AiClient {
  generate<T extends z.ZodType>(req: {
    schema: T;
    /** Stable, cacheable prefix - brand profile and standing rules. */
    system: string;
    /** Volatile, per-request content - goes after the cache breakpoint. */
    prompt: string;
    maxTokens?: number;
    effort?: Effort;
  }): Promise<GenerateResult<z.infer<T>>>;
}

export class AnthropicAiClient implements AiClient {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile, in that order.
    this.client = client ?? new Anthropic();
  }

  async generate<T extends z.ZodType>(req: {
    schema: T;
    system: string;
    prompt: string;
    maxTokens?: number;
    effort?: Effort;
  }): Promise<GenerateResult<z.infer<T>>> {
    const response = await this.client.messages.parse({
      model: config.model,
      max_tokens: req.maxTokens ?? 16000,
      // Adaptive thinking: the planner reasons over performance data, which is
      // exactly the sort of work that benefits from it.
      thinking: { type: "adaptive" },
      output_config: {
        effort: req.effort ?? config.plannerEffort,
        format: zodOutputFormat(req.schema),
      },
      // The brand profile is identical across every call for a business, so
      // caching the system prefix is the single biggest cost lever here.
      system: [
        {
          type: "text",
          text: req.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: req.prompt }],
    });

    if (response.stop_reason === "refusal") {
      // stop_details is populated only on refusals. It is not in the installed
      // SDK's types yet, so read it defensively rather than assume the shape.
      const details = (response as { stop_details?: { category?: string } })
        .stop_details;
      throw new Error(
        `Model declined this request (${details?.category ?? "unknown"}). ` +
          `Review the brand brief for content that may trip safety policy.`,
      );
    }

    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new Error(
        `Model returned output that did not match the expected schema ` +
          `(stop_reason: ${response.stop_reason}).`,
      );
    }

    return {
      value: response.parsed_output as z.infer<T>,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cached_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}

/** Lazily constructed so importing this module never requires credentials. */
let shared: AiClient | null = null;

export function getAiClient(): AiClient {
  if (!shared) shared = new AnthropicAiClient();
  return shared;
}

/** Test seam. */
export function setAiClient(client: AiClient): void {
  shared = client;
}
