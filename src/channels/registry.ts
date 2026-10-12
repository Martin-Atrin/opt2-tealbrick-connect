/** The chat channel providers Connect ships (C58). One entry per service; the hub never branches on a service id. */
import type { ChannelProvider, ChannelService } from "./provider.ts";

export function channelProviders(): Map<ChannelService, ChannelProvider> {
  const list: ChannelProvider[] = [];
  return new Map(list.map((p) => [p.service, p]));
}
