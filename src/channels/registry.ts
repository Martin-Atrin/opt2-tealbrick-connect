/** The chat channel providers Connect ships (C58). One entry per service; the hub never branches on a service id. */
import type { ChannelProvider, ChannelService } from "./provider.ts";
import { discordProvider } from "./providers/discord.ts";
import { slackProvider } from "./providers/slack.ts";
import { teamsProvider } from "./providers/teams.ts";
import { telegramProvider } from "./providers/telegram.ts";

export function channelProviders(): Map<ChannelService, ChannelProvider> {
  const list: ChannelProvider[] = [slackProvider, teamsProvider, telegramProvider, discordProvider];
  return new Map(list.map((p) => [p.service, p]));
}
