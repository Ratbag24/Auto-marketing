import type { Channel } from "../db/types.js";
import { EmailAdapter } from "./email.js";
import { LinkedInAdapter } from "./linkedin.js";
import { FacebookAdapter, InstagramAdapter } from "./meta.js";
import { XAdapter } from "./x.js";
import type { ChannelAdapter } from "./types.js";

const adapters: Record<Channel, ChannelAdapter> = {
  email: new EmailAdapter(),
  x: new XAdapter(),
  linkedin: new LinkedInAdapter(),
  facebook: new FacebookAdapter(),
  instagram: new InstagramAdapter(),
};

export function adapterFor(channel: Channel): ChannelAdapter {
  const adapter = adapters[channel];
  if (!adapter) throw new Error(`No adapter registered for channel ${channel}`);
  return adapter;
}

/** Test seam: swap an adapter without touching the registry's consumers. */
export function registerAdapter(adapter: ChannelAdapter): void {
  adapters[adapter.channel] = adapter;
}

export function channelStatuses(): {
  channel: Channel;
  live: boolean;
  hint: string;
}[] {
  return (Object.keys(adapters) as Channel[]).map((channel) => {
    const a = adapters[channel];
    return { channel, live: a.isConfigured(), hint: a.configHint() };
  });
}
