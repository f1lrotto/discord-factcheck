import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import { messages, type Locale } from './i18n/index.js';
import { formatDateTime } from './i18n/format.js';
import { text } from './news/render.js';
import { parseReminder, reminderLimits, type ReminderStore } from './reminders.js';
import { safeMentions } from './discord-response.js';

export const handleReminderCommand = async (input: {
  interaction: ChatInputCommandInteraction;
  store: ReminderStore;
  locale: Locale;
  timeZone: string;
  now?: Date;
}) => {
  const { interaction, store, locale, timeZone } = input;
  const now = input.now ?? new Date();
  const copy = messages(locale).reminders;
  const edit = (content: string) =>
    interaction.editReply({ content, allowedMentions: safeMentions });
  const scope = { guildId: interaction.guildId!, userId: interaction.user.id };
  const action = interaction.options.getSubcommand();
  if (action === 'list') {
    const reminders = await store.listForMember({ ...scope, now });
    // 20 full texts exceed Discord's content limit. Bound each row independently.
    await edit(
      reminders.length
        ? copy.list(
            reminders.map((reminder) => ({
              id: reminder.id,
              text:
                reminder.status === 'uncertain'
                  ? `${copy.deliveryUncertain} ${text(reminder.text, 20)}`
                  : text(reminder.text, 42),
              dueAt: formatDateTime(locale, reminder.dueAt, timeZone),
            })),
          )
        : copy.listEmpty,
    );
    return;
  }
  if (action === 'cancel') {
    const id = interaction.options.getString('id', true).trim().toLowerCase();
    const cancelled = /^[a-f0-9]{4}$/.test(id) && (await store.cancel({ ...scope, id }));
    await edit(cancelled ? copy.cancelled(id) : copy.notFound(text(id, 20)));
    return;
  }
  if (
    !interaction.channel ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(interaction.channel.type)
  ) {
    await edit(messages(locale).briefing.channelUnsupported);
    return;
  }
  const parsed = parseReminder({
    now,
    timeZone,
    text: interaction.options.getString('text', true),
    in: interaction.options.getString('in'),
    at: interaction.options.getString('at'),
  });
  if (!parsed.ok) {
    const failures = {
      invalid_time: copy.invalidTime,
      too_soon: copy.tooSoon,
      too_far: copy.tooFar,
      empty_text: copy.emptyText,
      text_too_long: copy.textTooLong,
    };
    await edit(failures[parsed.reason]);
    return;
  }
  const saved = await store.create({
    destination: { ...scope, channelId: interaction.channelId },
    dueAt: parsed.dueAt,
    text: parsed.text,
    now,
  });
  await edit(
    saved === 'limit_reached'
      ? copy.limitReached(reminderLimits.maximumPending)
      : copy.created({
          id: saved.id,
          dueAt: `${formatDateTime(locale, saved.dueAt, timeZone)} (${timeZone})`,
        }),
  );
};
