# Feature completion and release

When a feature is finished, automatically validate and release it, then explain how to use it.
Restarting Jolanda for a completed feature is authorized; do not ask for confirmation again.

1. Before each release with user-facing changes, update `src/releases/current.ts`: use a new,
   increasing UTC timestamp ID (`YYYY-MM-DDTHH:mm:ssZ`) and write concise Slovak and English
   notes covering what changed, exact usage, relevant permissions, and limitations. Keep each
   rendered message under Discord's 2,000-character limit. The renderer adds the reminder to
   restart Discord if changes or new commands are not visible. Keep the same ID for ordinary
   restarts, and do not generate notes from raw Git history or include private operational details.
2. Run `pnpm format`, `pnpm check`, and `pnpm build`. Resolve failures caused by the change before
   releasing. Demonstrate meaningful behavior with actual input/output; clearly identify mocks
   and anything that was not tested live.
3. Use the installed Herdr control skill and CLI to discover the tab running Jolanda. Find it by
   its label, working directory, and foreground process, not a hard-coded pane ID. Verify the
   process is this project's `pnpm start` / `node dist/index.js` before stopping it.
4. Send Ctrl+C to that specific pane, wait until its shell is ready, then run `pnpm start` in the
   same project directory. Preserve other tabs and processes. Verify the new process logs
   `mongodb_connected` and `discord_connected`; check for startup or command-registration errors.
   The bot registers its slash commands on startup, then automatically announces the current
   release to each guild configured with `/jolanda releases set channel:#updates`. This public
   release announcement is authorized; do not ask again or send a second manual copy. Check
   `release_announcement` outcomes and any `release_announcement_failed` or
   `release_announcement_unavailable` events. No configured channel means no announcement;
   never choose a channel on the guild's behalf. A repeated restart must not duplicate the note.
   Report rejected or uncertain deliveries; do not erase delivery state to force a resend.
5. Finish with a self-contained release overview: what changed, exact usage steps or an example,
   who can use it, whether messages are public, what persists versus applies once, validation
   results, confirmation of the restart, and release-announcement results. Include relevant
   limitations or ongoing errors.

If validation or restart cannot be completed, state the blocker and the remaining release step;
do not claim the feature is deployed. Do not commit or push unless requested.
